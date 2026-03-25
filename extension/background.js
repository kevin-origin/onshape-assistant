// background.js — Onshape Doc Scanner service worker
// Handles rescan requests, stores per-doc scan results, drawing creation,
// and violation checks. No bulk scan — content.js auto-scans every doc on open.

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

        // Ensure tab is focused (Onshape won't fully init an unfocused editor)
        await chrome.tabs.update(activeTab.id, { active: true });
        await chrome.windows.update(activeTab.windowId, { focused: true });

        // Navigate the active tab to the drawing
        await navigateTab(activeTab.id, drawingUrl);

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
          console.log("[Drawing] Flat pattern response:", JSON.stringify(flatResp));
          const flatMid = flatResp.id || "";
          if (flatMid) await pollModify(docId, wid, drawingEid, flatMid);

          // Check what views exist now
          try {
            const allViews = await onshapeFetch(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/views`);
            const items = allViews.items || [];
            console.log("[Drawing] Views after flat pattern:", items.length, items.map(v => ({
              viewId: v.viewId, sheetIndex: v.sheetIndex, label: v.label, viewType: v.viewType,
            })));
          } catch (_) {}
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
// Store scan result per doc in chrome.storage.local
// ---------------------------------------------------------------------------

const ALLOWED_FOLDERS = ["Parts", "Assemblies", "Drawings", "CAD Imports", "Feature Studios"];

async function storeDocScanResult(result) {
  if (!result || !result.doc_id) return;
  const data = await chrome.storage.local.get("docScanResults");
  const results = data.docScanResults || {};
  results[result.doc_id] = result;
  await chrome.storage.local.set({ docScanResults: results });

  // Check for illegal tabs and notify after 10s delay
  const folders = Object.keys(result.folders || {});
  const rootTabs = result.root_tabs || [];
  const extra = folders.filter(f => !ALLOWED_FOLDERS.includes(f));
  const illegal = [...extra, ...rootTabs];
  if (illegal.length > 0) {
    setTimeout(() => {
      chrome.notifications.create(`folder-scan-${result.doc_id}-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: result.doc_name || result.doc_id,
        message: "Incorrect folder structure, please take action.",
      });
    }, 10000);
  }
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
  // Poll for the drawing editor iframe (it loads after the parent page)
  let drawingFrame = null;
  for (let i = 0; i < 30; i++) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    drawingFrame = frames.find(f =>
      f.url.includes("onshape.com/editor") || f.url.includes("onshape.com/drawing")
    );
    if (drawingFrame) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!drawingFrame) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    console.log("[AddSheet] No drawing iframe found after 30s. Frames:", frames.map(f => f.url.slice(0, 120)));
    return { error: "Drawing editor iframe not found after 30s." };
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

      // Wait for editor to become fully interactive
      // The button appears in DOM before the editor is ready to handle clicks.
      // Wait for the drawing canvas to render (indicates editor is interactive).
      for (let i = 0; i < 30; i++) {
        const canvas = document.querySelector("canvas");
        if (canvas && canvas.offsetHeight > 100) break;
        await sleep(1000);
      }
      // Extra buffer after canvas renders
      await sleep(3000);

      const before = document.querySelector(".active_sheet_label")?.textContent.trim() || "";

      // Retry click up to 5 times — editor may not be interactive on first attempt
      let after = before;
      for (let attempt = 0; attempt < 5; attempt++) {
        // Re-query button each attempt (DOM may rebuild)
        const btn = document.querySelector(".xenon-dialog-addSheet");
        if (!btn) break;

        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const evtOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
        btn.dispatchEvent(new MouseEvent("mousedown", evtOpts));
        await sleep(50);
        btn.dispatchEvent(new MouseEvent("mouseup", evtOpts));
        await sleep(50);
        btn.dispatchEvent(new MouseEvent("click", evtOpts));
        await sleep(4000);

        after = document.querySelector(".active_sheet_label")?.textContent.trim() || "";
        if (after !== before) break;
        // Wait longer before next retry
        await sleep(3000);
      }

      return { ok: before !== after, sheetBefore: before, sheetAfter: after };
    },
  });

  const result = results?.[0]?.result || { error: "No result from injected script" };
  console.log("[AddSheet] Result:", JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Test helpers — disabled, kept for future debugging
// ---------------------------------------------------------------------------

/*
// Test helper — explore drawing editor DOM to find flat pattern insertion UI
// Run with: exploreFlatPatternUI()
// Must have a drawing open in the active tab
async function exploreFlatPatternUI() {
  const tabs = await chrome.tabs.query({ url: "https://cad.onshape.com/*" });
  if (!tabs.length) return console.log("No Onshape tab found");

  const tabId = tabs[0].id;
  console.log("[FlatExplore] Using tab:", tabId, tabs[0].url.slice(0, 80));

  // Find drawing iframe
  let drawingFrame = null;
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  drawingFrame = frames.find(f =>
    f.url.includes("onshape.com/editor") || f.url.includes("onshape.com/drawing")
  );
  if (!drawingFrame) return console.log("No drawing iframe. Frames:", frames.map(f => f.url.slice(0, 120)));

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [drawingFrame.frameId] },
    func: () => {
      const found = {};

      // 1. Look for toolbar/ribbon elements
      const toolbarEls = document.querySelectorAll("[class*='toolbar' i], [class*='ribbon' i], [class*='menu' i]");
      found.toolbars = Array.from(toolbarEls)
        .filter(el => el.offsetHeight > 0)
        .slice(0, 20)
        .map(el => ({ cls: el.className.toString().slice(0, 120), tag: el.tagName, text: el.textContent.trim().slice(0, 60) }));

      // 2. Look for anything with "flat", "pattern", "insert", "view" in class or text
      const allEls = document.querySelectorAll("*");
      found.flatRelated = [];
      found.insertRelated = [];
      for (const el of allEls) {
        if (el.offsetHeight === 0) continue;
        const cls = (el.className || "").toString().toLowerCase();
        const txt = (el.textContent || "").trim().toLowerCase().slice(0, 80);
        const title = (el.getAttribute("title") || "").toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();

        if (cls.includes("flat") || txt.includes("flat pattern") || title.includes("flat") || aria.includes("flat")) {
          found.flatRelated.push({ cls: el.className.toString().slice(0, 120), tag: el.tagName, text: txt.slice(0, 60), title, aria });
        }
        if (cls.includes("insert") || title.includes("insert") || aria.includes("insert")) {
          found.insertRelated.push({ cls: el.className.toString().slice(0, 120), tag: el.tagName, text: txt.slice(0, 60), title, aria });
        }
      }
      found.flatRelated = found.flatRelated.slice(0, 20);
      found.insertRelated = found.insertRelated.slice(0, 20);

      // 3. Detailed toolbar button info (tooltips, data attrs, children)
      const tbBtns = document.querySelectorAll(".toolbar-button, .toolbar-popup-button");
      found.toolbarButtons = Array.from(tbBtns)
        .filter(el => el.offsetHeight > 0)
        .map(el => {
          const tooltip = el.querySelector(".tooltip-text, .tooltip");
          const svgUse = el.querySelector("svg use");
          const img = el.querySelector("img");
          const dataAttrs = {};
          for (const attr of el.attributes) {
            if (attr.name.startsWith("data-")) dataAttrs[attr.name] = attr.value;
          }
          return {
            cls: el.className.toString().slice(0, 120),
            title: el.getAttribute("title") || "",
            aria: el.getAttribute("aria-label") || "",
            tooltipText: tooltip?.textContent.trim().slice(0, 60) || "",
            svgHref: svgUse?.getAttribute("href") || svgUse?.getAttribute("xlink:href") || "",
            imgSrc: img?.getAttribute("src")?.slice(0, 80) || "",
            dataAttrs,
            disabled: el.classList.contains("disabled"),
            childClasses: Array.from(el.children).map(c => c.className.toString().slice(0, 80)).slice(0, 5),
          };
        });

      // 4. Active sheet info
      found.activeSheet = document.querySelector(".active_sheet_label")?.textContent.trim() || "not found";

      return found;
    },
  });

  const data = results?.[0]?.result;
  if (data) {
    console.log("[FlatExplore] Active sheet:", data.activeSheet);
    console.log("[FlatExplore] Flat-related elements:", JSON.stringify(data.flatRelated, null, 2));
    console.log("[FlatExplore] Insert-related elements:", JSON.stringify(data.insertRelated, null, 2));
    console.log("[FlatExplore] Toolbar buttons:", JSON.stringify(data.toolbarButtons, null, 2));
    console.log("[FlatExplore] Toolbars:", JSON.stringify(data.toolbars, null, 2));
  }
  return data;
}

// Test helper — click "Insert view" button and explore the dialog that appears
// Run with: exploreInsertViewDialog()
async function exploreInsertViewDialog() {
  const tabs = await chrome.tabs.query({ url: "https://cad.onshape.com/*" });
  if (!tabs.length) return console.log("No Onshape tab found");

  const tabId = tabs[0].id;
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const drawingFrame = frames.find(f =>
    f.url.includes("onshape.com/editor") || f.url.includes("onshape.com/drawing")
  );
  if (!drawingFrame) return console.log("No drawing iframe found");

  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [drawingFrame.frameId] },
    func: async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // Click "Insert view" button
      const insertBtn = document.querySelector('[data-object-name="button_ID_DRAWINGVIEW"]');
      if (!insertBtn) return { error: "Insert view button not found" };

      const rect = insertBtn.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const evtOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
      insertBtn.dispatchEvent(new MouseEvent("mousedown", evtOpts));
      await sleep(50);
      insertBtn.dispatchEvent(new MouseEvent("mouseup", evtOpts));
      await sleep(50);
      insertBtn.dispatchEvent(new MouseEvent("click", evtOpts));

      // Wait for dialog/panel to appear
      await sleep(3000);

      // Explore what appeared — look for dialogs, panels, dropdowns, radio buttons, selectors
      const found = {};

      // 1. Any new dialog/panel/flyout elements
      const dialogs = document.querySelectorAll("[class*='dialog' i], [class*='panel' i], [class*='flyout' i], [class*='popup' i], [class*='modal' i]");
      found.dialogs = Array.from(dialogs)
        .filter(el => el.offsetHeight > 0)
        .slice(0, 15)
        .map(el => ({
          cls: el.className.toString().slice(0, 150),
          text: el.textContent.trim().slice(0, 200),
          childCount: el.children.length,
        }));

      // 2. Any elements with "view", "orientation", "flat", "front", "iso" text
      const allVisible = document.querySelectorAll("*");
      found.viewOptions = [];
      for (const el of allVisible) {
        if (el.offsetHeight === 0 || el.children.length > 3) continue;
        const txt = (el.textContent || "").trim().toLowerCase();
        if (txt.length > 2 && txt.length < 80 && (
          txt.includes("flat") || txt.includes("front") || txt.includes("isometric") ||
          txt.includes("orientation") || txt.includes("view type") || txt.includes("part studio") ||
          txt.includes("scale") || txt.includes("sheet metal")
        )) {
          found.viewOptions.push({
            cls: el.className.toString().slice(0, 100),
            tag: el.tagName,
            text: txt.slice(0, 80),
          });
        }
      }
      found.viewOptions = found.viewOptions.slice(0, 30);

      // 3. Radio buttons, checkboxes, select elements, dropdowns
      const inputs = document.querySelectorAll("input[type='radio'], input[type='checkbox'], select, [class*='dropdown' i], [class*='combo' i], [class*='select' i]");
      found.inputs = Array.from(inputs)
        .filter(el => el.offsetHeight > 0)
        .slice(0, 20)
        .map(el => ({
          cls: el.className.toString().slice(0, 100),
          tag: el.tagName,
          type: el.type || "",
          name: el.name || "",
          value: el.value || "",
          text: el.textContent.trim().slice(0, 60),
        }));

      // 4. Clickable items in any list/tree that appeared
      const listItems = document.querySelectorAll("[class*='list-item' i], [class*='tree-item' i], [class*='option' i], [class*='row' i]");
      found.listItems = Array.from(listItems)
        .filter(el => el.offsetHeight > 0 && el.textContent.trim().length > 0 && el.textContent.trim().length < 100)
        .slice(0, 20)
        .map(el => ({
          cls: el.className.toString().slice(0, 100),
          tag: el.tagName,
          text: el.textContent.trim().slice(0, 80),
        }));

      return found;
    },
  });

  const data = results?.[0]?.result;
  if (data) {
    console.log("[InsertView] Dialogs/panels:", JSON.stringify(data.dialogs, null, 2));
    console.log("[InsertView] View options:", JSON.stringify(data.viewOptions, null, 2));
    console.log("[InsertView] Inputs:", JSON.stringify(data.inputs, null, 2));
    console.log("[InsertView] List items:", JSON.stringify(data.listItems, null, 2));
  }
  return data;
}
*/

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "create-drawings") {
    createDrawingsForUrl(msg.url);
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "tab-folder-result") {
    // Auto-scan result from content.js — store per doc
    storeDocScanResult(msg.data);

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

      // Store result per doc
      await storeDocScanResult(result);
      sendResponse(result);
    });
    return true;
  }
});
