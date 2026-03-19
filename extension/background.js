// background.js — Onshape Tab Folder Scanner service worker
// Orchestrates bulk scans: discovers docs via Onshape session cookies,
// opens a scanner tab, cycles through docs, collects results, POSTs to dashboard.

const ONSHAPE_BASE = "https://cad.onshape.com";
const COMPANY_ID   = "6810c247e7c40668c32816a6";

// Scan timeout per document (ms) — if content.js doesn't respond in time
const DOC_SCAN_TIMEOUT = 30000;

// Release tracker — alert when versions exceed this without a release
const VERSION_RELEASE_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// Onshape API via session cookies (no API keys, zero quota cost)
// ---------------------------------------------------------------------------

async function onshapeFetch(path) {
  const resp = await fetch(`${ONSHAPE_BASE}${path}`, {
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`Onshape ${path}: ${resp.status}`);
  return resp.json();
}

async function getXsrfToken() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: ONSHAPE_BASE, name: "XSRF-TOKEN" }, (cookie) => {
      resolve(cookie ? cookie.value : "");
    });
  });
}

async function onshapePost(path, body) {
  const xsrf = await getXsrfToken();
  const headers = { "Accept": "application/json", "Content-Type": "application/json" };
  if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
  const resp = await fetch(`${ONSHAPE_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Onshape POST ${path}: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Drawing Creator — create drawings for all parts in a Part Studio
// ---------------------------------------------------------------------------

const DRAWING_TEMPLATE = {
  templateDocumentId: "e4ecea9df80b53b39ab4fa38",
  templateWorkspaceId: "038996d814574f1d1d3b774a",
  templateElementId: "4a80b03c1485e714f587fb61",
};

function broadcastDrawLog(message, cls) {
  console.log(`[Drawing] ${message}`);
  chrome.runtime.sendMessage({ type: "draw-log", message, cls }).catch(() => {});
}

function parsePartStudioUrl(url) {
  // https://cad.onshape.com/documents/{docId}/w/{wid}/e/{eid}
  const m = url.match(/\/documents\/([^/]+)\/w\/([^/]+)\/e\/([^/?#]+)/);
  if (!m) return null;
  return { docId: m[1], wid: m[2], eid: m[3] };
}

function computeScale(bb) {
  const dx = (bb.highX - bb.lowX) * 1000;
  const dy = (bb.highY - bb.lowY) * 1000;
  const dz = (bb.highZ - bb.lowZ) * 1000;
  const largest = Math.max(dx, dy, dz);
  broadcastDrawLog(`  bbox: ${dx.toFixed(1)} x ${dy.toFixed(1)} x ${dz.toFixed(1)} mm, largest=${largest.toFixed(1)}`);
  if (largest < 0.1) {
    broadcastDrawLog("  bbox zero/tiny -- defaulting to 1:5", "log-err");
    return [1, 5];
  }
  const AVAILABLE = 50.0;
  const standards = [[2,1],[1,1],[1,2],[1,3],[1,4],[1,5],[1,7],[1,10],[1,15],[1,20],[1,50]];
  for (const [num, den] of standards) {
    if (largest * num / den <= AVAILABLE) return [num, den];
  }
  return [1, 50];
}

async function pollModify(docId, wid, drawingEid, mid, timeoutSec = 30) {
  const url = `/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modificationstatus/${mid}`;
  const deadline = Date.now() + timeoutSec * 1000;
  let notFound = 0;
  while (Date.now() < deadline) {
    try {
      const r = await onshapeFetch(url);
      const state = r.requestState || "";
      if (state === "DONE") return true;
      if (state === "FAILED") {
        broadcastDrawLog(`  modify FAILED: ${JSON.stringify(r).slice(0, 200)}`, "log-err");
        return false;
      }
    } catch (e) {
      if (e.message.includes("404")) {
        notFound++;
        if (notFound >= 3) {
          broadcastDrawLog(`  poll 404 x${notFound} -- assuming completed`);
          return true;
        }
      } else {
        broadcastDrawLog(`  poll error: ${e.message}`, "log-err");
        return false;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  broadcastDrawLog(`  modify timed out after ${timeoutSec}s`, "log-err");
  return false;
}

async function createDrawingsForUrl(url) {
  const parsed = parsePartStudioUrl(url);
  if (!parsed) {
    broadcastDrawLog("Invalid Part Studio URL", "log-err");
    chrome.runtime.sendMessage({ type: "draw-done", error: "Invalid URL" }).catch(() => {});
    return;
  }
  const { docId, wid, eid } = parsed;
  broadcastDrawLog(`Document: ${docId}`);
  broadcastDrawLog(`Workspace: ${wid}`);
  broadcastDrawLog(`Part Studio: ${eid}`);

  // 1. Fetch parts list
  broadcastDrawLog("Fetching parts...");
  let parts;
  try {
    parts = await onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${eid}`);
  } catch (e) {
    broadcastDrawLog(`Failed to fetch parts: ${e.message}`, "log-err");
    chrome.runtime.sendMessage({ type: "draw-done", error: e.message }).catch(() => {});
    return;
  }

  if (!parts || parts.length === 0) {
    broadcastDrawLog("No parts found in Part Studio", "log-err");
    chrome.runtime.sendMessage({ type: "draw-done", error: "No parts" }).catch(() => {});
    return;
  }

  broadcastDrawLog(`Found ${parts.length} part(s)`);
  let created = 0;
  let failed = 0;

  // 2. Create drawing for each part
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partId = part.partId || "";
    const partName = part.name || "Part";
    if (!partId) { failed++; continue; }

    broadcastDrawLog(`[${i + 1}/${parts.length}] ${partName}`);

    // 2a. Create drawing element
    let drawingEid;
    try {
      const createBody = {
        drawingName: `Drawing - ${partName}`,
        elementId: eid,
        partId: partId,
        ...DRAWING_TEMPLATE,
      };
      const resp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/create`, createBody);
      drawingEid = resp.id || "";
      if (!drawingEid) throw new Error("No drawing element ID returned");
      broadcastDrawLog(`  drawing created: ${drawingEid}`);
    } catch (e) {
      broadcastDrawLog(`  create failed: ${e.message}`, "log-err");
      failed++;
      continue;
    }

    // 2b. Wait for drawing to initialize
    await new Promise(r => setTimeout(r, 3000));

    // 2c. Get bounding box + compute scale
    let scale = [1, 5];
    try {
      const bb = await onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${eid}/partid/${partId}/boundingboxes`);
      scale = computeScale(bb);
    } catch (e) {
      broadcastDrawLog(`  bbox failed (${e.message}), using 1:5`, "log-err");
    }
    broadcastDrawLog(`  scale: ${scale[0]}:${scale[1]}`);

    const ref = { documentId: docId, workspaceId: wid, elementId: eid, partId: partId };

    // A3 landscape sheet: 0.420 x 0.297m
    // Title block ~60mm at bottom, usable area roughly y: 0.070 to 0.280
    // Center views vertically at y=0.155, spread horizontally

    // Step 1: Create front + iso views
    // TODO: Add to dashboard later
    try {
      const viewBody = {
        description: "Add views",
        jsonRequests: [{
          messageName: "onshapeCreateViews",
          formatVersion: "2021-01-01",
          views: [
            {
              viewType: "TopLevel",
              orientation: "front",
              scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
              reference: ref,
            },
            {
              viewType: "TopLevel",
              orientation: "isometric",
              scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
              reference: ref,
            },
          ],
        }],
      };
      const resp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modify`, viewBody);
      const mid = resp.id || "";
      if (mid) await pollModify(docId, wid, drawingEid, mid);
    } catch (e) {
      broadcastDrawLog(`  views failed: ${e.message}`, "log-err");
      failed++;
      continue;
    }

    // Step 1b: Enable view labels on Sheet 1 (showViewLabel ignored in create)
    try {
      const viewsResp = await onshapeFetch(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/views`);
      const viewList = viewsResp.items || [];
      if (viewList.length > 0) {
        function identifyView(v) {
          const m = v.viewMatrix || [];
          if (m.some(val => val !== 0 && val !== 1 && val !== -1)) return "Isometric";
          if (m[0] === 1 && m[6] === 1) return "Front";
          if (m[0] === 1 && m[5] === 1) return "Top";
          if (m[1] === -1 || m[1] === 1) return "Left";
          return "View";
        }
        const editViews = viewList.map((v) => ({
          viewId: v.viewId,
          showViewLabel: true,
          label: identifyView(v),
          name: identifyView(v),
        }));
        const editBody = {
          description: "Enable view labels",
          jsonRequests: [{
            messageName: "onshapeEditViews",
            formatVersion: "2021-01-01",
            views: editViews,
          }],
        };
        const editResp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modify`, editBody);
        const editMid = editResp.id || "";
        if (editMid) await pollModify(docId, wid, drawingEid, editMid);
        broadcastDrawLog(`  labels applied`);
      }
    } catch (e) {
      broadcastDrawLog(`  labels failed: ${e.message}`, "log-err");
    }

    // Step 2: Add Sheet 2 via DOM automation (navigate active tab to drawing)
    try {
      const drawingUrl = `${ONSHAPE_BASE}/documents/${docId}/w/${wid}/e/${drawingEid}`;
      broadcastDrawLog(`  navigating to drawing for sheet creation...`);

      // Find the active Onshape tab (the one the user triggered from)
      const tabs = await chrome.tabs.query({ url: "https://cad.onshape.com/*" });
      if (tabs.length === 0) {
        broadcastDrawLog(`  no Onshape tab found for DOM automation`, "log-err");
      } else {
        const activeTab = tabs[0];

        // Navigate the active tab to the drawing
        await navigateTab(activeTab.id, drawingUrl);
        // Wait for drawing editor iframe to fully render
        await new Promise(r => setTimeout(r, 5000));

        // Inject into drawing iframe and click Add Sheet
        const sheetResult = await addSheetViaIframe(activeTab.id);

        if (sheetResult.error) {
          broadcastDrawLog(`  sheet 2 DOM failed: ${sheetResult.error}`, "log-err");
        } else {
          broadcastDrawLog(`  sheet 2 created (${sheetResult.sheetBefore} -> ${sheetResult.sheetAfter})`);
        }

        // Tab stays on the drawing — no need to navigate back
        // Add flat pattern view on Sheet 2 via API (sheetIndex: 1)
        if (!sheetResult.error) {
          const flatBody = {
            description: "Add flat pattern view",
            jsonRequests: [{
              messageName: "onshapeCreateViews",
              formatVersion: "2021-01-01",
              views: [{
                viewType: "TopLevel",
                orientation: "flatPattern",
                scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
                reference: ref,
                sheetIndex: 1,
              }],
            }],
          };
          const flatResp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modify`, flatBody);
          const flatMid = flatResp.id || "";
          if (flatMid) await pollModify(docId, wid, drawingEid, flatMid);
          broadcastDrawLog(`  flat pattern added to sheet 2`);
        }
      }
    } catch (e) {
      broadcastDrawLog(`  sheet 2 / flat pattern failed: ${e.message}`, "log-err");
    }

    created++;
    broadcastDrawLog(`  done`, "log-ok");
  }

  broadcastDrawLog(`Complete: ${created} created, ${failed} failed`, created > 0 ? "log-ok" : "log-err");
  chrome.runtime.sendMessage({ type: "draw-done", created, failed }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Document discovery — find all docs in the configured folders
// ---------------------------------------------------------------------------

async function discoverDocs(folderIds) {
  const docs = [];
  const seenDocIds = new Set();

  for (const folderId of folderIds) {
    await discoverDocsInFolder(folderId, docs, seenDocIds);
  }

  return docs;
}

async function discoverDocsInFolder(folderId, docs, seenDocIds) {
  try {
    // List documents owned by company, filtered by folder
    // Use globaltreenodes which returns docs + subfolders in a folder
    const items = await onshapeFetch(
      `/api/v10/globaltreenodes/folder/${folderId}?getPathToRoot=false&includeAssemblies=false&limit=50`
    );

    const nodes = items.items || items.pathToRoot || items || [];
    const nodeList = Array.isArray(nodes) ? nodes : [];

    for (const node of nodeList) {
      if (node.jsonType === "document" || node.resourceType === "document") {
        if (!seenDocIds.has(node.id)) {
          seenDocIds.add(node.id);
          docs.push({
            id: node.id,
            name: node.name || node.id,
            url: `${ONSHAPE_BASE}/documents/${node.id}`,
          });
        }
      } else if (node.jsonType === "folder" || node.resourceType === "folder") {
        // Recurse into subfolder
        await discoverDocsInFolder(node.id, docs, seenDocIds);
      }
    }
  } catch (err) {
    console.error(`[Scanner] Failed to list folder ${folderId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Bulk scan — open scanner tab, cycle through docs, collect results
// ---------------------------------------------------------------------------

let scanState = {
  running: false,
  total: 0,
  scanned: 0,
  results: [],
  errors: [],
  scannerTabId: null,
};

async function runBulkScan(folderIds) {
  if (scanState.running) {
    return { error: "Scan already in progress" };
  }

  scanState = {
    running: true,
    total: 0,
    scanned: 0,
    results: [],
    errors: [],
    scannerTabId: null,
  };

  try {
    // 1. Discover all docs in configured folders
    broadcastProgress("Discovering documents...");
    const docs = await discoverDocs(folderIds);
    scanState.total = docs.length;

    if (docs.length === 0) {
      scanState.running = false;
      return { error: "No documents found in configured folders" };
    }

    // Save registered doc IDs for auto-scan, and set bulk scan flag
    const docIds = docs.map(d => d.id);
    await chrome.storage.local.set({ registeredDocIds: docIds, bulkScanRunning: true });

    // 2. Create scanner tab (inactive/background)
    const tab = await chrome.tabs.create({
      url: docs[0].url,
      active: false,
    });
    scanState.scannerTabId = tab.id;

    // 3. Scan each doc one by one
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      scanState.scanned = i;
      broadcastProgress(`Scanning ${i + 1}/${docs.length}: ${doc.name}`);

      try {
        // Navigate scanner tab (first doc already loaded)
        if (i > 0) {
          await navigateTab(scanState.scannerTabId, doc.url);
        } else {
          // Wait for first doc to finish loading
          await waitForTabLoad(scanState.scannerTabId);
        }

        // Ask content.js to scan
        const result = await scanDocInTab(scanState.scannerTabId);
        if (result && !result.error) {
          scanState.results.push(result);
        } else {
          scanState.errors.push({
            doc_id: doc.id,
            doc_name: doc.name,
            error: result?.error || "No response from content script",
          });
        }
      } catch (err) {
        scanState.errors.push({
          doc_id: doc.id,
          doc_name: doc.name,
          error: err.message,
        });
      }
    }

    // 4. Close scanner tab
    try {
      await chrome.tabs.remove(scanState.scannerTabId);
    } catch (_) { /* tab may already be closed */ }

    scanState.scanned = docs.length;
    const summary = {
      total: docs.length,
      scanned: scanState.results.length,
      errors: scanState.errors.length,
      results: scanState.results,
    };

    // Save last scan summary
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) + " IST";
    await chrome.storage.local.set({
      lastScanSummary: {
        ...summary,
        timestamp: timeStr,
      },
    });

    broadcastProgress(`Done: ${summary.scanned} docs scanned, ${summary.errors} errors`);
    scanState.running = false;
    await chrome.storage.local.set({ bulkScanRunning: false });
    return summary;

  } catch (err) {
    scanState.running = false;
    await chrome.storage.local.set({ bulkScanRunning: false });
    try {
      if (scanState.scannerTabId) await chrome.tabs.remove(scanState.scannerTabId);
    } catch (_) {}
    return { error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Tab navigation helpers
// ---------------------------------------------------------------------------

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      waitForTabLoad(tabId).then(resolve).catch(reject);
    });
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway, content script may still respond
    }, 15000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay for Onshape SPA to initialize
        setTimeout(resolve, 2000);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function scanDocInTab(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ error: "Scan timed out" });
    }, DOC_SCAN_TIMEOUT);

    chrome.tabs.sendMessage(tabId, { type: "scan-tab-folders" }, (response) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Progress broadcast to popup
// ---------------------------------------------------------------------------

function broadcastProgress(message) {
  chrome.runtime.sendMessage({ type: "scan-progress", message }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Try sending scan message to a tab's content script
// Returns result or { __noConnection: true } if content script isn't there
// ---------------------------------------------------------------------------

function trySendScan(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ error: "Scan timed out" }), DOC_SCAN_TIMEOUT);
    chrome.tabs.sendMessage(tabId, { type: "scan-tab-folders" }, (result) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({ __noConnection: true, error: chrome.runtime.lastError.message });
      } else {
        resolve(result || { error: "No response" });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Violation checker — runs on every doc open
// ---------------------------------------------------------------------------

const PARTS_LIMIT = 25;
const FEATURES_LIMIT = 250;
const TABS_LIMIT = 40;

async function checkDocViolations(docId, docName, wid) {
  const violations = [];

  try {
    // Parallel fetch: versions always, elements if wid available
    const promises = [
      onshapeFetch(`/api/v10/documents/d/${docId}/versions`).catch(() => null),
    ];
    if (wid) {
      promises.push(
        onshapeFetch(`/api/v10/documents/d/${docId}/w/${wid}/elements`).catch(() => null),
      );
    }

    const [versions, rawElements] = await Promise.all(promises);

    // 1. Versions since last release
    if (Array.isArray(versions) && versions.length > 0) {
      // Sort by createdAt ascending
      const sorted = [...versions].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      // Find the last release version (purpose field: non-zero = release)
      let lastReleaseIdx = -1;
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].purpose && sorted[i].purpose !== 0) {
          lastReleaseIdx = i;
          break;
        }
      }

      // Count only versions created after the last release
      const versionsSinceRelease = lastReleaseIdx >= 0
        ? sorted.length - 1 - lastReleaseIdx
        : sorted.length; // no releases at all — count everything

      if (versionsSinceRelease >= VERSION_RELEASE_THRESHOLD) {
        violations.push(`${versionsSinceRelease} versions since last release (limit: ${VERSION_RELEASE_THRESHOLD})`);
      }
    }

    // Unwrap elements (API may return array or { items: [...] })
    let elements = rawElements;
    if (rawElements && !Array.isArray(rawElements)) {
      elements = rawElements.items || rawElements.elements || [];
    }

    if (Array.isArray(elements) && elements.length > 0) {
      // Filter out BOMs — they're auto-generated, not user-created tabs
      const userElements = elements.filter(
        e => e.elementType !== "BILLOFMATERIALS" && !(e.name || "").startsWith("BOM :")
      );

      // 2 & 3. Per Part Studio: parts > 25, features > 250
      const partStudios = userElements.filter(e =>
        (e.elementType || e.type || "") === "PARTSTUDIO"
      );
      for (const ps of partStudios) {
        try {
          const [partsResp, featResp] = await Promise.all([
            onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${ps.id}`).catch(() => null),
            onshapeFetch(`/api/v10/partstudios/d/${docId}/w/${wid}/e/${ps.id}/features`).catch(() => null),
          ]);
          const partCount = Array.isArray(partsResp) ? partsResp.length : 0;
          const featureCount = Array.isArray(featResp?.features) ? featResp.features.length : 0;
          if (partCount > PARTS_LIMIT) {
            violations.push(`"${ps.name}" has ${partCount} parts (limit: ${PARTS_LIMIT})`);
          }
          if (featureCount > FEATURES_LIMIT) {
            violations.push(`"${ps.name}" has ${featureCount} features (limit: ${FEATURES_LIMIT})`);
          }
        } catch (_) { /* skip */ }
      }

      // 4. Tabs > 5 (excluding BOMs)
      if (userElements.length > TABS_LIMIT) {
        violations.push(`${userElements.length} tabs (limit: ${TABS_LIMIT})`);
      }
    }
  } catch (e) {
    console.error("[Violations] Error checking doc:", e);
    return;
  }

  // Store only current doc's violations (no history)
  const current = {};
  if (violations.length > 0) {
    current[docId] = {
      docName: docName || docId,
      timestamp: new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
      }),
      items: violations,
    };
    // Unique notification ID so it fires every time the doc is opened
    chrome.notifications.create(`violations-${docId}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `${docName || docId}`,
      message: `${violations.length} violation${violations.length > 1 ? "s" : ""} detected, please take action.`,
    });
  }

  await chrome.storage.local.set({ violations: current });
  chrome.runtime.sendMessage({ type: "violations-updated" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// DOM automation: add drawing sheet via iframe injection
// ---------------------------------------------------------------------------

async function addSheetViaIframe(tabId) {
  // Find the drawing editor iframe (production-drawing-*.onshape.com)
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const drawingFrame = frames.find(f =>
    f.url.includes("onshape.com/editor") || f.url.includes("onshape.com/drawing")
  );

  if (!drawingFrame) {
    // Log all frame URLs for debugging
    console.log("[AddSheet] No drawing iframe found. Frames:", frames.map(f => f.url.slice(0, 120)));
    return { error: "Drawing editor iframe not found. Check service worker console for frame URLs." };
  }

  console.log("[AddSheet] Found drawing iframe:", drawingFrame.url.slice(0, 120), "frameId:", drawingFrame.frameId);

  // Inject script into the drawing iframe to click "Add Sheet"
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [drawingFrame.frameId] },
    func: async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // Wait for the Add Sheet button to appear (drawing editor loads async)
      let addBtn = null;
      for (let i = 0; i < 20; i++) {
        addBtn = document.querySelector(".xenon-dialog-addSheet");
        if (addBtn) break;
        await sleep(1000);
      }
      if (!addBtn) {
        // Dump what sheet-related elements exist for debugging
        const sheetEls = Array.from(document.querySelectorAll("[class*='sheet' i]"))
          .filter(el => el.offsetHeight > 0)
          .map(el => ({ cls: el.className.toString().slice(0, 100), text: el.textContent.trim().slice(0, 40) }));
        return { error: "Add Sheet button not found after 20s", sheetEls };
      }

      // Read active sheet before click
      const before = document.querySelector(".active_sheet_label")?.textContent.trim() || "";

      addBtn.click();
      await sleep(3000);

      // Read active sheet after click — should change to the new sheet
      const after = document.querySelector(".active_sheet_label")?.textContent.trim() || "";

      return { ok: true, sheetBefore: before, sheetAfter: after };
    },
  });

  const result = results?.[0]?.result || { error: "No result from injected script" };
  console.log("[AddSheet] Result:", JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "create-drawings") {
    createDrawingsForUrl(msg.url);
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "start-bulk-scan") {
    runBulkScan(msg.folderIds).then(sendResponse);
    return true; // async response

  } else if (msg.type === "get-scan-status") {
    sendResponse({
      running: scanState.running,
      total: scanState.total,
      scanned: scanState.scanned,
    });

  } else if (msg.type === "tab-folder-result") {
    // Auto-scan result from content.js — store locally
    // (previously forwarded to dashboard, now extension-only)

  } else if (msg.type === "test-add-sheet") {
    // Manual test: run on the active tab's drawing
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      const result = await addSheetViaIframe(tabs[0].id);
      sendResponse(result);
    });
    return true;

  } else if (msg.type === "check-versions") {
    const { docId, docName, wid } = msg;
    checkDocViolations(docId, docName, wid);

  } else if (msg.type === "rescan-active-tab") {
    // Re-scan the current active tab. If content script isn't injected, inject it first.
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      const tab = tabs[0];
      if (!tab.url || !tab.url.includes("cad.onshape.com/documents/")) {
        return sendResponse({ error: "Active tab is not an Onshape document" });
      }

      // Try messaging content script; if missing, inject and retry
      let result = await trySendScan(tab.id);
      if (result.__noConnection) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          });
          // Wait for tab bar to be ready
          await new Promise(r => setTimeout(r, 2000));
          result = await trySendScan(tab.id);
        } catch (injectErr) {
          return sendResponse({ error: "Failed to inject scanner: " + injectErr.message });
        }
      }

      if (result.error) return sendResponse(result);
      sendResponse(result);
    });
    return true;
  }
});
