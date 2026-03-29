// background.js — Onshape Doc Scanner service worker
// Handles rescan requests, stores per-doc scan results, drawing creation,
// and violation checks. No bulk scan — content.js auto-scans every doc on open.

const ONSHAPE_BASE = "https://cad.onshape.com";
const COMPANY_ID   = "6810c247e7c40668c32816a6";

// Scan timeout per document (ms) — if content.js doesn't respond in time
const DOC_SCAN_TIMEOUT = 30000;


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

async function createDrawingsForUrl(url, selectedParts) {
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

  // Use pre-selected parts if provided, otherwise fetch (legacy fallback)
  let parts;
  if (selectedParts && selectedParts.length > 0) {
    parts = selectedParts;
    broadcastDrawLog(`${parts.length} part(s) selected`);
  } else {
    broadcastDrawLog("Fetching parts...");
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
  }
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

  // Sort new drawings into Drawings folder
  if (created > 0) {
    broadcastDrawLog("Sorting drawings into folders...");
    try {
      const tabs = await chrome.tabs.query({ url: "https://cad.onshape.com/*" });
      const tab = tabs.find(t => t.url && t.url.includes(docId));
      if (tab) {
        // Navigate back to the document and wait for drawings to finish generating
        await navigateTab(tab.id, `https://cad.onshape.com/documents/${docId}/w/${wid}`);
        await new Promise(r => setTimeout(r, 10000));
        await sortStrayTabs(tab.id, tab.id);
        broadcastDrawLog("Drawings sorted into folders", "log-ok");
      }
    } catch (e) {
      broadcastDrawLog(`Sort failed: ${e.message} (drawings created but not sorted)`, "log-err");
    }
  }

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

const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];

async function storeDocScanResult(result) {
  if (!result || !result.doc_id) return;
  console.log("[Scanner] storeDocScanResult called, wid=" + (result.wid || "none") +
    ", folders=" + Object.keys(result.folders || {}).join(","));

  // Enrich with assembly count from API
  // Onshape API doesn't expose tab group membership, so we count total
  // assemblies and attribute them to the "Assemblies" folder if it exists
  if (result.wid) {
    try {
      const rawElements = await onshapeFetch(
        `/api/v10/documents/d/${result.doc_id}/w/${result.wid}/elements`
      );
      const elements = Array.isArray(rawElements) ? rawElements : (rawElements.items || []);
      const assemblies = elements.filter(e => e.elementType === "ASSEMBLY");
      console.log(`[Scanner] ${assemblies.length} assembly(s) found:`,
        assemblies.map(a => a.name));

      // Store assembly element IDs for interference checker (0 extra API calls)
      result.assemblyElements = assemblies.map(a => ({ id: a.id, name: a.name }));

      if (result.folders && result.folders["Assemblies"]) {
        result.folders["Assemblies"].assemblies = assemblies.length;
        console.log("[Scanner] Set Assemblies folder count to " + assemblies.length);
      }
    } catch (e) {
      console.error("[Scanner] Elements API error:", e.message);
    }
  } else {
    console.log("[Scanner] Skipping API enrichment: no wid");
  }

  const data = await chrome.storage.local.get("docScanResults");
  const results = data.docScanResults || {};
  results[result.doc_id] = result;
  await chrome.storage.local.set({ docScanResults: results });
  console.log("[Scanner] Stored enriched result for " + result.doc_id);
}

// ---------------------------------------------------------------------------
// Violation checker — runs on every doc open
// ---------------------------------------------------------------------------

const PARTS_LIMIT = 25;
const FEATURES_LIMIT = 250;
const TABS_LIMIT = 40;

async function checkDocViolations(docId, docName, wid, tabId) {
  const violations = [];
  console.log(`[Violations] Checking ${docName} (${docId}), wid=${wid || "null"}`);

  try {
    // Parallel fetch: versions always, elements if wid available
    const promises = [
      onshapeFetch(`/api/v10/documents/d/${docId}/versions`).catch(e => { console.error("[Violations] versions fetch failed:", e.message); return null; }),
    ];
    if (wid) {
      promises.push(
        onshapeFetch(`/api/v10/documents/d/${docId}/w/${wid}/elements`).catch(e => { console.error("[Violations] elements fetch failed:", e.message); return null; }),
      );
    }

    const [versions, rawElements] = await Promise.all(promises);

    // Store version count for folder-creation overlay (zero extra API calls)
    if (Array.isArray(versions)) {
      const vcData = await chrome.storage.local.get("versionCounts");
      const vc = vcData.versionCounts || {};
      vc[docId] = versions.length;
      await chrome.storage.local.set({ versionCounts: vc });
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
      console.log(`[Violations] ${partStudios.length} Part Studio(s), ${userElements.length} user elements, versions=${Array.isArray(versions) ? versions.length : "null"}, tabId=${tabId || "none"}`);
      let totalFeatures = 0;
      for (const ps of partStudios) {
        try {
          const [partsResp, featResp] = await Promise.all([
            onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${ps.id}`).catch(() => null),
            onshapeFetch(`/api/v10/partstudios/d/${docId}/w/${wid}/e/${ps.id}/features`).catch(() => null),
          ]);
          const partCount = Array.isArray(partsResp) ? partsResp.length : 0;
          const featureCount = Array.isArray(featResp?.features) ? featResp.features.length : 0;
          totalFeatures += featureCount;
          if (partCount > PARTS_LIMIT) {
            violations.push(`"${ps.name}" has ${partCount} parts (limit: ${PARTS_LIMIT})`);
          }
          if (featureCount > FEATURES_LIMIT) {
            violations.push(`"${ps.name}" has ${featureCount} features (limit: ${FEATURES_LIMIT})`);
          }
        } catch (_) { /* skip */ }
      }

      // Auto-create "Initial" version when: 0 versions + >= 3 features
      // Then enable workspace protection after successful version creation
      const versionCount = Array.isArray(versions) ? versions.length : -1;
      const hasInitialVersion = Array.isArray(versions) && versions.some(v => v.name === "Initial");
      console.log(`[NewDocSetup] versionCount=${versionCount}, totalFeatures=${totalFeatures}, threshold=10, hasInitial=${hasInitialVersion}`);
      if (versionCount <= 1 && totalFeatures >= 10 && !hasInitialVersion) {
        console.log(`[NewDocSetup] ${versionCount} versions + ${totalFeatures} features — creating initial version`);
        const vResult = await createInitialVersion(docId, wid);
        if (!vResult.error) {
          // Create Development branch from the new version
          await createDevelopmentBranch(docId, vResult.versionId);
          // Enable workspace protection on Main via CDP
          if (tabId) {
            console.log("[NewDocSetup] Enabling workspace protection");
            enableWorkspaceProtection(tabId, tabId);
          }
        }
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

  // Store only current doc's violations (replaces previous doc)
  const current = {};
  if (violations.length > 0) {
    current[docId] = {
      docName: docName || docId,
      timestamp: new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
      }),
      items: violations,
    };
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
// CDP helpers — chrome.debugger wrappers for trusted input events
// ---------------------------------------------------------------------------

function showCdpOverlay(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "cdp-overlay-show" }).catch(() => {});
}

function hideCdpOverlay(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "cdp-overlay-hide" }).catch(() => {});
}

function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function cdpClick(tabId, x, y) {
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, buttons: 0,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function cdpRightClick(tabId, x, y) {
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, buttons: 0,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1,
  });
}

async function cdpTypeText(tabId, text) {
  // Select all existing text first (Ctrl+A), then type
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", modifiers: 2, windowsVirtualKeyCode: 65, key: "a", code: "KeyA",
  });
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 65, key: "a", code: "KeyA",
  });
  await cdpSend(tabId, "Input.insertText", { text });
}

async function cdpPressKey(tabId, key, keyCode) {
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", windowsVirtualKeyCode: keyCode, key, code: key,
  });
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", windowsVirtualKeyCode: keyCode, key, code: key,
  });
}

async function cdpDrag(tabId, fromX, fromY, toX, toY) {
  // Three-phase drag: DOWN (out of tab bar) → ACROSS → UP (into target folder)
  // Straight-line drags cross intermediate folders and tabs get "caught" mid-path.
  const dropY = fromY + 120; // drag below the tab bar to avoid crossing other folders

  // Hover over source
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: fromX, y: fromY, button: "none", buttons: 0, pointerType: "mouse",
  });
  await new Promise(r => setTimeout(r, 100));

  // Press down on source
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse",
  });
  await new Promise(r => setTimeout(r, 200));

  // Phase 1: Drag DOWN (out of tab bar)
  for (let i = 1; i <= 4; i++) {
    const y = Math.round(fromY + (dropY - fromY) * (i / 4));
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: fromX, y, button: "left", buttons: 1, pointerType: "mouse",
    });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 100));

  // Phase 2: Move ACROSS horizontally (below the tab bar, no folders to snag)
  const hSteps = 8;
  for (let i = 1; i <= hSteps; i++) {
    const x = Math.round(fromX + (toX - fromX) * (i / hSteps));
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y: dropY, button: "left", buttons: 1, pointerType: "mouse",
    });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 100));

  // Phase 3: Drag UP into target folder
  for (let i = 1; i <= 4; i++) {
    const y = Math.round(dropY + (toY - dropY) * (i / 4));
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: toX, y, button: "left", buttons: 1, pointerType: "mouse",
    });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 150));

  // Release on target
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse",
  });
}

async function waitForElement(tabId, jsExpr, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await cdpSend(tabId, "Runtime.evaluate", {
      expression: jsExpr,
      returnByValue: true,
    });
    if (res.result && res.result.value) return res.result.value;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery helper — dump context menu DOM after right-clicking tab bar
// Run once to find selectors for "Create folder" menu item.
// Triggered by message type "discover-context-menu" from content.js or console.
// ---------------------------------------------------------------------------

async function discoverContextMenu(tabId) {
  console.log("[CDP-Discovery] Attaching debugger to tab", tabId);
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Find tab bar area coordinates
    const tabBarPos = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const selectors = ['.os-tab-bar-scroll-container', '.os-tab-bar', '.os-tab-bar-tabs', '[class*="tab-bar"]', '[class*="tabbar"]'];
        let bar = null;
        for (const sel of selectors) {
          bar = document.querySelector(sel);
          if (bar && bar.offsetHeight > 0) break;
          bar = null;
        }
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        return { x: r.left + 80, y: r.top + r.height / 2 };
      })()`,
      returnByValue: true,
    });

    if (!tabBarPos.result?.value) {
      console.log("[CDP-Discovery] Tab bar not found");
      return { error: "Tab bar not found" };
    }

    const { x, y } = tabBarPos.result.value;
    console.log("[CDP-Discovery] Right-clicking at", x, y);
    await cdpRightClick(tabId, x, y);

    // Wait for context menu to appear
    await new Promise(r => setTimeout(r, 1000));

    // Dump all context menu elements
    const menuDump = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const items = document.querySelectorAll(
          '[class*="context-menu"] *, [class*="contextmenu"] *, [class*="dropdown-menu"] *, [class*="popover"] li, [class*="popup"] li, [role="menu"] *, [role="menuitem"]'
        );
        const results = [];
        for (const el of items) {
          if (el.offsetHeight === 0) continue;
          const text = el.textContent.trim();
          if (!text || text.length > 100) continue;
          const r = el.getBoundingClientRect();
          results.push({
            tag: el.tagName,
            cls: el.className.toString().slice(0, 150),
            text: text.slice(0, 80),
            role: el.getAttribute('role') || '',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
        return results;
      })()`,
      returnByValue: true,
    });

    // Dismiss the menu with Escape
    await cdpPressKey(tabId, "Escape", 27);

    const menuItems = menuDump.result?.value || [];
    console.log("[CDP-Discovery] Context menu items:", JSON.stringify(menuItems, null, 2));
    return { items: menuItems };
  } catch (e) {
    console.error("[CDP-Discovery] Error:", e.message);
    return { error: e.message };
  } finally {
    chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Folder creation orchestrator — creates tab folders via CDP
// ---------------------------------------------------------------------------

async function createTabFolders(tabId, senderTabId, folderNames) {
  console.log("[CDP-Folders] Starting folder creation:", folderNames);
  showCdpOverlay(senderTabId);

  function sendProgress(index, total, name, status) {
    chrome.tabs.sendMessage(senderTabId, {
      type: "folder-creation-progress",
      index, total, name, status,
    }).catch(() => {});
  }

  function sendDone(success, error) {
    chrome.tabs.sendMessage(senderTabId, {
      type: "folder-creation-done",
      success, error,
    }).catch(() => {});
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Wait for debugger banner to appear and page layout to stabilize
    await new Promise(r => setTimeout(r, 500));

    for (let i = 0; i < folderNames.length; i++) {
      const name = folderNames[i];
      sendProgress(i + 1, folderNames.length, name, "creating");
      console.log(`[CDP-Folders] Creating folder ${i + 1}/${folderNames.length}: ${name}`);

      // Step a: Find the "Insert new tab" button (+ icon near tab bar)
      const insertBtn = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          // Search by Bootstrap tooltip attribute (confirmed from DOM observation)
          const byTooltip = document.querySelector('[data-bs-original-title="Insert new tab"], [title="Insert new tab"]');
          if (byTooltip && byTooltip.offsetHeight > 0) {
            const r = byTooltip.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), method: "tooltip" };
          }
          // Fallback: find "+" button or insert icon near the tab bar
          const tabBar = document.querySelector('.os-tab-bar-tab');
          if (!tabBar) return null;
          const tabR = tabBar.getBoundingClientRect();
          // Look for small buttons/icons near the tab bar
          const candidates = document.querySelectorAll('button, [role="button"], .os-icon, [class*="insert"], [class*="add"]');
          for (const el of candidates) {
            if (el.offsetHeight === 0) continue;
            const r = el.getBoundingClientRect();
            const title = el.getAttribute('data-bs-original-title') || el.getAttribute('title') || '';
            const aria = el.getAttribute('aria-label') || '';
            const text = el.textContent.trim();
            // Must be near the tab bar vertically, and look like an add/insert button
            if (Math.abs(r.top - tabR.top) < 30 && r.width < 50 && r.height < 50) {
              if (text === '+' || title.toLowerCase().includes('insert') || title.toLowerCase().includes('new tab') || aria.toLowerCase().includes('insert')) {
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), method: "scan", title, text: text.slice(0, 20) };
              }
            }
          }
          // Last resort: dump nearby small buttons for diagnostic
          const nearby = [];
          for (const el of candidates) {
            if (el.offsetHeight === 0) continue;
            const r = el.getBoundingClientRect();
            if (Math.abs(r.top - tabR.top) < 50 && r.width < 60) {
              nearby.push({ cls: (el.className||'').toString().slice(0, 100), title: el.getAttribute('data-bs-original-title') || el.getAttribute('title') || '', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
            }
          }
          return { error: "not-found", nearby: nearby.slice(0, 10) };
        })()`,
        returnByValue: true,
      });

      const btnInfo = insertBtn.result?.value;
      if (!btnInfo || btnInfo.error) {
        console.log("[CDP-Folders] Insert button search:", JSON.stringify(btnInfo));
        throw new Error("'Insert new tab' button not found. See console for nearby elements.");
      }

      console.log(`[CDP-Folders] Found insert button via ${btnInfo.method} at (${btnInfo.x}, ${btnInfo.y})`);

      // Step b: Click the "Insert new tab" button to open dropdown
      await cdpClick(tabId, btnInfo.x, btnInfo.y);
      await new Promise(r => setTimeout(r, 1000));

      // Step c: Find "Folder" option in the dropdown menu
      const folderOption = await waitForElement(tabId, `(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.offsetHeight === 0 || el.children.length > 3) continue;
          const text = el.textContent.trim().toLowerCase();
          if (text === 'folder' || text === 'tab group' || text === 'create folder' || text === 'new folder') {
            const r = el.getBoundingClientRect();
            if (r.width > 30 && r.height > 10) {
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() };
            }
          }
        }
        return null;
      })()`, 3000);

      if (!folderOption) {
        // Dump what appeared in the dropdown for diagnostic
        const dropDiag = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const items = [];
            const all = document.querySelectorAll('*');
            for (const el of all) {
              if (el.offsetHeight === 0 || el.children.length > 3) continue;
              const text = el.textContent.trim();
              if (!text || text.length > 60 || text.length < 2) continue;
              const style = getComputedStyle(el);
              const pos = style.position;
              const z = parseInt(style.zIndex) || 0;
              const r = el.getBoundingClientRect();
              // Look for menu-like items (positioned, or in a dropdown area)
              if ((pos === 'absolute' || pos === 'fixed') && z > 0 && r.width > 50 && r.height < 400) {
                items.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0, 100), text: text.slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
              }
            }
            return items.slice(0, 20);
          })()`,
          returnByValue: true,
        });
        console.log("[CDP-Folders] Dropdown items:", JSON.stringify(dropDiag.result?.value, null, 2));
        await cdpPressKey(tabId, "Escape", 27);
        throw new Error("'Folder' option not found in dropdown. See console.");
      }

      console.log(`[CDP-Folders] Found folder option: "${folderOption.text}" at (${folderOption.x}, ${folderOption.y})`);

      // Step d: Click "Folder" option
      await cdpClick(tabId, folderOption.x, folderOption.y);

      // Step e: Wait for rename input to appear
      const renameInput = await waitForElement(tabId, `(() => {
        const input = document.querySelector('.rename-tab-input, .os-tab-name-input, input[class*="rename"]');
        if (input && input.offsetHeight > 0) {
          const r = input.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      })()`, 5000);

      if (!renameInput) {
        await cdpPressKey(tabId, "Escape", 27);
        throw new Error(`Rename input not found after creating folder "${name}"`);
      }

      console.log(`[CDP-Folders] Rename input at (${renameInput.x}, ${renameInput.y})`);

      // Step f: Click input to focus, select all, type folder name, press Enter
      await cdpClick(tabId, renameInput.x, renameInput.y);
      await new Promise(r => setTimeout(r, 200));
      await cdpTypeText(tabId, name);
      await new Promise(r => setTimeout(r, 300));
      await cdpPressKey(tabId, "Enter", 13);

      // Step g: Wait for folder to appear in DOM
      const folderAppeared = await waitForElement(tabId, `(() => {
        const tabs = document.querySelectorAll('.os-tab-name');
        for (const t of tabs) {
          if (t.textContent.trim() === ${JSON.stringify(name)}) return true;
        }
        return null;
      })()`, 3000);

      if (folderAppeared) {
        console.log(`[CDP-Folders] Folder "${name}" confirmed in DOM`);
      } else {
        console.log(`[CDP-Folders] Warning: folder "${name}" not confirmed, continuing`);
      }

      // Pause before next folder
      await new Promise(r => setTimeout(r, 800));
    }

    console.log("[CDP-Folders] All folders created successfully");

    // --- Move all stray root-level tabs into their matching folders ---
    // Type-to-folder mapping (tab CSS classes → target folder name)
    // data-icon-src → folder name mapping (from DOM observation)
    const ICON_FOLDER_MAP = {
      "partstudio": "Part Studios",
      "assembly": "Assemblies",
      "drawing": "Drawings",
      "feature-studio-element": "Feature Studios",
      "variable-studio-element": "Variable Studios",
    };

    // Gather all root-level non-folder tabs and their types via data-icon-src
    const strayTabs = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const results = [];
        const tabs = document.querySelectorAll('.os-tab-bar-tab');
        for (const tab of tabs) {
          if (tab.classList.contains('os-tab-bar-tab-group')) continue;
          if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
          const nameEl = tab.querySelector('.os-tab-name');
          if (!nameEl) continue;
          const name = nameEl.textContent.trim();
          const iconSrc = tab.getAttribute('data-icon-src') || '';
          const r = tab.getBoundingClientRect();
          if (r.width === 0) continue;
          results.push({ name, iconSrc, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        }
        return results;
      })()`,
      returnByValue: true,
    });

    const strays = strayTabs.result?.value || [];
    console.log(`[CDP-Folders] Found ${strays.length} stray root tab(s):`, strays.map(s => `${s.name} (${s.iconSrc})`));

    for (const stray of strays) {
      const targetFolder = ICON_FOLDER_MAP[stray.iconSrc];
      if (!targetFolder) {
        console.log(`[CDP-Folders] No folder mapping for "${stray.name}" (icon: ${stray.iconSrc}), skipping`);
        continue;
      }
      if (!folderNames.includes(targetFolder)) {
        console.log(`[CDP-Folders] Folder "${targetFolder}" wasn't created, skipping "${stray.name}"`);
        continue;
      }

      sendProgress(folderNames.length, folderNames.length, stray.name, "moving");
      console.log(`[CDP-Folders] Moving "${stray.name}" into "${targetFolder}"`);

      // Find target folder position (re-query each time since positions shift after moves)
      const tgtResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            const container = t.closest('.os-tab-bar-tab');
            if (container && container.classList.contains('os-tab-bar-tab-group') && t.textContent.trim() === ${JSON.stringify(targetFolder)}) {
              const r = container.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      // Re-query source position too (may have shifted)
      const srcResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          for (const tab of tabs) {
            if (tab.classList.contains('os-tab-bar-tab-group')) continue;
            if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const r = tab.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const src = srcResult.result?.value;
      const tgt = tgtResult.result?.value;

      if (!src) {
        console.log(`[CDP-Folders] Tab "${stray.name}" no longer at root, skipping`);
        continue;
      }
      if (!tgt) {
        console.log(`[CDP-Folders] Folder "${targetFolder}" not found for move, skipping`);
        continue;
      }

      console.log(`[CDP-Folders] Dragging from (${src.x},${src.y}) to (${tgt.x},${tgt.y})`);
      await cdpDrag(tabId, src.x, src.y, tgt.x, tgt.y);
      await new Promise(r => setTimeout(r, 800));

      // Verify the tab moved
      const verified = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            if (t.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const container = t.closest('.os-tab-bar-tab');
              const parent = container?.parentElement?.closest('.os-tab-bar-tab-group');
              return { moved: !!parent };
            }
          }
          return { moved: false, reason: "tab-not-found" };
        })()`,
        returnByValue: true,
      });
      const v = verified.result?.value;
      if (v?.moved) {
        console.log(`[CDP-Folders] "${stray.name}" successfully moved`);
      } else {
        console.log(`[CDP-Folders] "${stray.name}" move not confirmed:`, JSON.stringify(v));
      }
    }

    // Move default tabs into their folders (debugger still attached)
    await sortDefaultTabs(tabId);

    sendDone(true);
  } catch (e) {
    console.error("[CDP-Folders] Error:", e.message);
    // Try to dismiss any open menus/dialogs
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendDone(false, e.message);
  } finally {
    hideCdpOverlay(senderTabId);
    chrome.debugger.detach({ tabId }, () => {});
  }
}

// Move default Onshape tabs into their folders after folder creation
async function sortDefaultTabs(tabId) {
  const defaults = [
    { name: "Part Studio 1", folder: "Part Studios" },
    { name: "Assembly 1", folder: "Assemblies" },
  ];

  await new Promise(r => setTimeout(r, 500)); // Let folders settle

  for (const { name, folder } of defaults) {
    const positions = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        let src = null, tgt = null;
        const tabs = document.querySelectorAll('.os-tab-bar-tab');
        for (const tab of tabs) {
          if (tab.classList.contains('os-tab-bar-tab-group')) {
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(folder)} && tab.offsetWidth > 0) {
              const r = tab.getBoundingClientRect();
              tgt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
            continue;
          }
          if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
          const nameEl = tab.querySelector('.os-tab-name');
          if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(name)} && tab.offsetWidth > 0) {
            const r = tab.getBoundingClientRect();
            src = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return (src && tgt) ? { src, tgt } : null;
      })()`,
      returnByValue: true,
    });

    const pos = positions.result?.value;
    if (!pos) {
      console.log(`[CDP-Folders] Default tab "${name}" or folder "${folder}" not found, skipping`);
      continue;
    }

    console.log(`[CDP-Folders] Moving "${name}" -> "${folder}"`);
    await cdpDrag(tabId, pos.src.x, pos.src.y, pos.tgt.x, pos.tgt.y);
    await new Promise(r => setTimeout(r, 800));
  }
}

// ---------------------------------------------------------------------------
// New-doc setup: create initial version + enable workspace protection
// ---------------------------------------------------------------------------

async function createInitialVersion(docId, wid) {
  console.log(`[NewDocSetup] Creating initial version for ${docId}`);
  try {
    const result = await onshapePost(`/api/v10/documents/d/${docId}/versions`, {
      name: "Initial",
      documentId: docId,
      workspaceId: wid,
    });
    console.log(`[NewDocSetup] Version created: ${result.id || result.name || "ok"}`);
    return { ok: true, versionId: result.id };
  } catch (e) {
    console.error(`[NewDocSetup] Version creation failed: ${e.message}`);
    return { error: e.message };
  }
}

async function createDevelopmentBranch(docId, versionId) {
  console.log(`[NewDocSetup] Creating Development branch from version ${versionId}`);
  try {
    const result = await onshapePost(`/api/v10/documents/d/${docId}/workspaces`, {
      name: "Development",
      versionId: versionId,
    });
    console.log(`[NewDocSetup] Branch created: ${result.id || "ok"}`);
    return { ok: true, workspaceId: result.id };
  } catch (e) {
    console.error(`[NewDocSetup] Branch creation failed: ${e.message}`);
    return { error: e.message };
  }
}

async function enableWorkspaceProtection(tabId, senderTabId) {
  console.log("[NewDocSetup] Enabling workspace protection via CDP");
  showCdpOverlay(senderTabId);

  function sendSetupProgress(message) {
    chrome.tabs.sendMessage(senderTabId, {
      type: "setup-new-doc-progress",
      message,
    }).catch(() => {});
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Wait for debugger banner to appear and layout to stabilize
    await new Promise(r => setTimeout(r, 500));

    // Step 1: Check if workspace is already protected (lock icon visible)
    const alreadyProtected = await waitForElement(tabId, `(() => {
      const lock = document.querySelector('svg.branch-lock-icon');
      return lock && lock.offsetWidth > 0 ? true : null;
    })()`, 500);

    if (alreadyProtected) {
      console.log("[NewDocSetup] Workspace already protected, skipping");
      return { ok: true, skipped: true };
    }

    sendSetupProgress("Opening versions panel...");

    // Step 2: Click "Versions and history" panel button
    const vhBtn = await waitForElement(tabId, `(() => {
      // Search by tooltip
      const byTooltip = document.querySelector('[data-bs-original-title="Versions and history"], [title="Versions and history"]');
      if (byTooltip && byTooltip.offsetHeight > 0) {
        const r = byTooltip.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      // Fallback: search panel selector buttons
      const btns = document.querySelectorAll('.os-panel-selector-button');
      for (const btn of btns) {
        const tip = btn.getAttribute('data-bs-original-title') || btn.getAttribute('title') || '';
        if (tip.includes('ersion')) {
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    })()`, 5000);

    if (!vhBtn) throw new Error("Versions and history button not found");

    console.log(`[NewDocSetup] Versions button at (${vhBtn.x}, ${vhBtn.y})`);
    await cdpClick(tabId, vhBtn.x, vhBtn.y);
    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Right-click on workspace "Main"
    sendSetupProgress("Right-clicking workspace...");

    const wsMain = await waitForElement(tabId, `(() => {
      const spans = document.querySelectorAll('span.workspace-name');
      for (const s of spans) {
        if (s.offsetHeight > 0) {
          const r = s.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: s.textContent.trim() };
        }
      }
      return null;
    })()`, 5000);

    if (!wsMain) throw new Error("Workspace name element not found in versions panel");

    console.log(`[NewDocSetup] Workspace "${wsMain.text}" at (${wsMain.x}, ${wsMain.y})`);
    await cdpRightClick(tabId, wsMain.x, wsMain.y);
    await new Promise(r => setTimeout(r, 800));

    // Step 4: Click "Workspace protection..." in context menu
    sendSetupProgress("Opening protection dialog...");

    const protectItem = await waitForElement(tabId, `(() => {
      const items = document.querySelectorAll('.dropdown-item, [role="menuitem"], .dropdown-menu a, .dropdown-menu li');
      for (const el of items) {
        const text = el.textContent.trim().toLowerCase();
        if (text.includes('workspace protection') || text.includes('protect')) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 5) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() };
          }
        }
      }
      return null;
    })()`, 3000);

    if (!protectItem) {
      await cdpPressKey(tabId, "Escape", 27);
      throw new Error("'Workspace protection...' menu item not found");
    }

    console.log(`[NewDocSetup] Protection item "${protectItem.text}" at (${protectItem.x}, ${protectItem.y})`);
    await cdpClick(tabId, protectItem.x, protectItem.y);
    await new Promise(r => setTimeout(r, 1000));

    // Step 5: Wait for protection dialog to appear
    const dialogReady = await waitForElement(tabId, `(() => {
      const dialog = document.querySelector('.workspace-permissions-dialog, .modal.workspace-permissions-dialog, [class*="workspace-permissions"]');
      return dialog && dialog.offsetHeight > 0 ? true : null;
    })()`, 5000);

    if (!dialogReady) throw new Error("Workspace protection dialog did not appear");

    // Step 6: Check the "Enable workspace protection" checkbox
    sendSetupProgress("Enabling protection...");

    const checkbox = await waitForElement(tabId, `(() => {
      const cb = document.querySelector('#enable-workspace-protection');
      if (cb && cb.offsetHeight > 0) {
        const r = cb.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), checked: cb.checked };
      }
      return null;
    })()`, 3000);

    if (!checkbox) throw new Error("Enable workspace protection checkbox not found");

    if (!checkbox.checked) {
      console.log(`[NewDocSetup] Clicking checkbox at (${checkbox.x}, ${checkbox.y})`);
      await cdpClick(tabId, checkbox.x, checkbox.y);
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log("[NewDocSetup] Checkbox already checked");
    }

    // Step 7: Wait for Apply button to become enabled, then click it
    const applyBtn = await waitForElement(tabId, `(() => {
      const btn = document.querySelector('#workspace-protection-apply');
      if (btn && btn.offsetHeight > 0 && !btn.disabled) {
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    })()`, 3000);

    if (!applyBtn) throw new Error("Apply button not found or still disabled");

    console.log(`[NewDocSetup] Clicking Apply at (${applyBtn.x}, ${applyBtn.y})`);
    await cdpClick(tabId, applyBtn.x, applyBtn.y);
    await new Promise(r => setTimeout(r, 1500));

    // Step 8: Verify success — look for success message bubble or lock icon
    const success = await waitForElement(tabId, `(() => {
      const bubble = document.querySelector('.osx-message-bubble-inner-container');
      if (bubble && bubble.textContent.includes('protection settings updated')) return 'bubble';
      const lock = document.querySelector('svg.branch-lock-icon');
      if (lock && lock.offsetWidth > 0) return 'lock';
      return null;
    })()`, 5000);

    if (success) {
      console.log(`[NewDocSetup] Workspace protection enabled (confirmed via ${success})`);
    } else {
      console.log("[NewDocSetup] Warning: protection confirmation not detected, may still have worked");
    }

    // Step 9: Close the versions panel by clicking the button again
    const vhBtnClose = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const byTooltip = document.querySelector('[data-bs-original-title="Versions and history"], [title="Versions and history"]');
        if (byTooltip && byTooltip.offsetHeight > 0) {
          const r = byTooltip.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const closePos = vhBtnClose.result?.value;
    if (closePos) {
      await cdpClick(tabId, closePos.x, closePos.y);
    }

    sendSetupProgress("Workspace protection enabled");
    setTimeout(() => {
      chrome.tabs.sendMessage(senderTabId, { type: "remove-progress-toast" }).catch(() => {});
    }, 3000);
    return { ok: true };

  } catch (e) {
    console.error("[NewDocSetup] Error:", e.message);
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendSetupProgress(`Error: ${e.message}`);
    setTimeout(() => {
      chrome.tabs.sendMessage(senderTabId, { type: "remove-progress-toast" }).catch(() => {});
    }, 5000);
    return { error: e.message };
  } finally {
    hideCdpOverlay(senderTabId);
    chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Tab Sorter — persistent, moves stray root-level tabs into matching folders
// Runs independently of folder creation: after every scan, or on demand.
// ---------------------------------------------------------------------------

// data-icon-src → folder name (from DOM observation)
const TAB_ICON_FOLDER_MAP = {
  "partstudio": "Part Studios",
  "assembly": "Assemblies",
  "drawing": "Drawings",
  "feature-studio-element": "Feature Studios",
  "variable-studio-element": "Variable Studios",
};

let _sortingInProgress = false;

async function sortStrayTabs(tabId, senderTabId) {
  if (_sortingInProgress) {
    console.log("[TabSort] Already sorting, skipping");
    return { sorted: 0, skipped: 0, reason: "already-sorting" };
  }
  _sortingInProgress = true;

  function sendSortProgress(name) {
    chrome.tabs.sendMessage(senderTabId, { type: "tab-sort-progress", name }).catch(() => {});
  }
  function sendSortDone(sorted, skipped) {
    chrome.tabs.sendMessage(senderTabId, { type: "tab-sort-done", sorted, skipped }).catch(() => {});
  }

  showCdpOverlay(senderTabId);
  let needsDetach = false;
  let sorted = 0;
  let skipped = 0;

  try {
    // Lightweight pre-check via executeScript (no debugger needed)
    const preCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const folders = [];
        const strays = [];
        const tabs = document.querySelectorAll('.os-tab-bar-tab');
        for (const tab of tabs) {
          const nameEl = tab.querySelector('.os-tab-name');
          if (!nameEl) continue;
          const name = nameEl.textContent.trim();
          if (tab.classList.contains('os-tab-bar-tab-group')) {
            folders.push(name);
          } else if (!tab.parentElement?.closest('.os-tab-bar-tab-group')) {
            const iconSrc = tab.getAttribute('data-icon-src') || '';
            strays.push({ name, iconSrc });
          }
        }
        return { folders, strays };
      },
    });

    const { folders, strays } = preCheck?.[0]?.result || { folders: [], strays: [] };
    if (folders.length === 0) {
      console.log("[TabSort] No folders exist, nothing to sort");
      return { sorted: 0, skipped: 0, reason: "no-folders" };
    }

    // Log ALL strays for diagnostics
    console.log(`[TabSort] All stray tabs (${strays.length}):`, strays.map(s => `"${s.name}" (iconSrc: "${s.iconSrc}")`));

    const movable = strays.filter(s => {
      const target = TAB_ICON_FOLDER_MAP[s.iconSrc];
      return target && folders.includes(target);
    });
    const unmapped = strays.filter(s => {
      const target = TAB_ICON_FOLDER_MAP[s.iconSrc];
      return !target || !folders.includes(target);
    });
    if (unmapped.length > 0) {
      console.log(`[TabSort] ${unmapped.length} UNMAPPED stray tab(s) (no folder mapping, will stay at root):`,
        unmapped.map(s => `"${s.name}" (iconSrc: "${s.iconSrc}")`));
    }
    if (movable.length === 0) {
      console.log("[TabSort] No stray tabs to sort (all unmapped)");
      return { sorted: 0, skipped: 0, reason: "none-stray" };
    }

    console.log(`[TabSort] ${movable.length} movable stray tab(s):`, movable.map(s => `${s.name} -> ${TAB_ICON_FOLDER_MAP[s.iconSrc]}`));

    // Attach debugger only when we actually have tabs to move
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    needsDetach = true;

    for (const stray of movable) {
      const targetFolder = TAB_ICON_FOLDER_MAP[stray.iconSrc];
      sendSortProgress(stray.name);
      console.log(`[TabSort] Moving "${stray.name}" -> "${targetFolder}"`);

      // Fresh source position (layout shifts after each drag)
      const srcResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          for (const tab of tabs) {
            if (tab.classList.contains('os-tab-bar-tab-group')) continue;
            if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const r = tab.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const tgtResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            const container = t.closest('.os-tab-bar-tab');
            if (container && container.classList.contains('os-tab-bar-tab-group') && t.textContent.trim() === ${JSON.stringify(targetFolder)}) {
              const r = container.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      let src = srcResult.result?.value;
      const tgt = tgtResult.result?.value;
      // Retry once after 500ms if source not found (DOM reflow after prior drag)
      if (!src) {
        await new Promise(r => setTimeout(r, 500));
        const retry = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const tabs = document.querySelectorAll('.os-tab-bar-tab');
            for (const tab of tabs) {
              if (tab.classList.contains('os-tab-bar-tab-group')) continue;
              if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
              const nameEl = tab.querySelector('.os-tab-name');
              if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
                const r = tab.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
            }
            return null;
          })()`,
          returnByValue: true,
        });
        src = retry.result?.value;
        if (src) console.log(`[TabSort] "${stray.name}" found on retry`);
      }
      if (!src) { console.log(`[TabSort] "${stray.name}" no longer at root, skipping`); skipped++; continue; }
      if (!tgt) { console.log(`[TabSort] Folder "${targetFolder}" not found, skipping`); skipped++; continue; }

      console.log(`[TabSort] Dragging (${src.x},${src.y}) -> (${tgt.x},${tgt.y})`);
      await cdpDrag(tabId, src.x, src.y, tgt.x, tgt.y);
      await new Promise(r => setTimeout(r, 800));

      // Verify
      const verified = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            if (t.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const container = t.closest('.os-tab-bar-tab');
              return !!container?.parentElement?.closest('.os-tab-bar-tab-group');
            }
          }
          return false;
        })()`,
        returnByValue: true,
      });
      if (verified.result?.value) {
        console.log(`[TabSort] "${stray.name}" moved successfully`); sorted++;
      } else {
        console.log(`[TabSort] "${stray.name}" move not confirmed`); skipped++;
      }
    }

    // Re-scan: check for any remaining strays and do a second pass
    if (skipped > 0) {
      await new Promise(r => setTimeout(r, 500));
      const rescan = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          const strays = [];
          for (const tab of tabs) {
            if (tab.classList.contains('os-tab-bar-tab-group')) continue;
            if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
            const nameEl = tab.querySelector('.os-tab-name');
            const iconSrc = tab.getAttribute('data-icon-src') || '';
            if (nameEl && tab.offsetWidth > 0) strays.push({ name: nameEl.textContent.trim(), iconSrc });
          }
          return strays;
        })()`,
        returnByValue: true,
      });
      const remaining = (rescan.result?.value || []).filter(s => TAB_ICON_FOLDER_MAP[s.iconSrc] && folders.includes(TAB_ICON_FOLDER_MAP[s.iconSrc]));
      if (remaining.length > 0) {
        console.log(`[TabSort] Re-scan: ${remaining.length} stray(s) still at root, second pass`);
        for (const stray of remaining) {
          const targetFolder = TAB_ICON_FOLDER_MAP[stray.iconSrc];
          const srcR = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const tabs = document.querySelectorAll('.os-tab-bar-tab');
              for (const tab of tabs) {
                if (tab.classList.contains('os-tab-bar-tab-group')) continue;
                if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
                const nameEl = tab.querySelector('.os-tab-name');
                if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
                  const r = tab.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
              }
              return null;
            })()`,
            returnByValue: true,
          });
          const tgtR = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const tabs = document.querySelectorAll('.os-tab-name');
              for (const t of tabs) {
                const container = t.closest('.os-tab-bar-tab');
                if (container && container.classList.contains('os-tab-bar-tab-group') && t.textContent.trim() === ${JSON.stringify(targetFolder)}) {
                  const r = container.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
              }
              return null;
            })()`,
            returnByValue: true,
          });
          const s = srcR.result?.value, t = tgtR.result?.value;
          if (s && t) {
            console.log(`[TabSort] Re-scan: dragging "${stray.name}" -> "${targetFolder}"`);
            await cdpDrag(tabId, s.x, s.y, t.x, t.y);
            await new Promise(r => setTimeout(r, 800));
            sorted++;
            skipped--;
          }
        }
      }
    }

    console.log(`[TabSort] Done: ${sorted} moved, ${skipped} skipped`);
    sendSortDone(sorted, skipped);
    return { sorted, skipped };
  } catch (e) {
    console.error("[TabSort] Error:", e.message);
    return { sorted, skipped, error: e.message };
  } finally {
    _sortingInProgress = false;
    hideCdpOverlay(senderTabId);
    if (needsDetach) chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Interference Detection — CDP automation for assembly interference checks
// ---------------------------------------------------------------------------

let _interferenceInProgress = false;

async function checkInterference(tabId, senderTabId, docId, wid) {
  if (_interferenceInProgress) {
    console.log("[Interference] Already in progress, skipping");
    return;
  }
  // Wait for tab sort to finish (up to 30s)
  for (let i = 0; i < 60 && _sortingInProgress; i++) {
    await new Promise(r => setTimeout(r, 500));
  }
  _interferenceInProgress = true;
  showCdpOverlay(senderTabId);

  function sendProgress(message) {
    chrome.tabs.sendMessage(senderTabId, { type: "interference-progress", message }).catch(() => {});
  }
  function sendDone(results) {
    chrome.tabs.sendMessage(senderTabId, { type: "interference-done", results }).catch(() => {});
  }

  let needsDetach = false;

  try {
    // Get assembly elements from stored scan results (0 API calls)
    const data = await chrome.storage.local.get("docScanResults");
    const docScan = (data.docScanResults || {})[docId];
    const assemblyElements = docScan?.assemblyElements || [];

    if (assemblyElements.length === 0) {
      console.log("[Interference] No assemblies found for", docId);
      sendDone({ totalInterferences: 0, assemblies: {} });
      return;
    }

    console.log(`[Interference] Checking ${assemblyElements.length} assembly(s):`,
      assemblyElements.map(a => a.name));
    sendProgress(`Starting interference check (${assemblyElements.length} assembly${assemblyElements.length > 1 ? "s" : ""})...`);

    // Attach debugger
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    needsDetach = true;

    // Wait for debugger banner to appear and page layout to stabilize
    await new Promise(r => setTimeout(r, 500));

    const results = { assemblies: {}, totalInterferences: 0 };

    // Check if assemblies are inside a folder — look for "Assemblies" folder tab
    // (queried AFTER debugger banner settles so coordinates are accurate)
    const folder = await waitForElement(tabId, `(() => {
      const tabs = document.querySelectorAll('.os-tab-bar-tab-group');
      for (const t of tabs) {
        const nameEl = t.querySelector('.os-tab-name');
        if (nameEl && nameEl.textContent.trim() === 'Assemblies' && t.offsetWidth > 0) {
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    })()`, 2000);

    let enteredFolder = false;

    if (folder) {
      // Enter the Assemblies folder to reveal assembly tabs
      console.log(`[Interference] Entering Assemblies folder at (${folder.x}, ${folder.y})`);
      await cdpClick(tabId, folder.x, folder.y);
      // Wait for folder contents to render (assembly tabs appear inside)
      const folderReady = await waitForElement(tabId, `(() => {
        const tabs = document.querySelectorAll('.os-tab-bar-tab[data-icon-src="assembly"]');
        for (const t of tabs) {
          if (t.offsetWidth > 0) return true;
        }
        return null;
      })()`, 5000);
      if (folderReady) {
        enteredFolder = true;
        console.log("[Interference] Assemblies folder contents loaded");
      } else {
        console.log("[Interference] Assemblies folder contents did not load, trying without folder");
      }
    } else {
      console.log("[Interference] No Assemblies folder found, looking for assembly tabs at root");
    }

    for (let i = 0; i < assemblyElements.length; i++) {
      const asm = assemblyElements[i];
      sendProgress(`Checking interference: ${asm.name} (${i + 1}/${assemblyElements.length})...`);
      console.log(`[Interference] ${i + 1}/${assemblyElements.length}: ${asm.name}`);

      try {
        // Find assembly tab — poll up to 3s (may still be rendering after folder entry)
        const tabPos = await waitForElement(tabId, `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          for (const t of tabs) {
            if (t.classList.contains('os-tab-bar-tab-group')) continue;
            const nameEl = t.querySelector('.os-tab-name');
            const iconSrc = t.getAttribute('data-icon-src') || '';
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(asm.name)} && iconSrc === 'assembly' && t.offsetWidth > 0) {
              const r = t.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`, 3000);

        if (!tabPos) {
          console.log(`[Interference] Tab "${asm.name}" not found after 3s, skipping`);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Tab not found" };
          continue;
        }

        // Click assembly tab to activate
        await cdpClick(tabId, tabPos.x, tabPos.y);

        // Wait for assembly to load: poll for "Show analysis tools" button (up to 15s)
        const analysisBtn = await waitForElement(tabId, `(() => {
          const btn = document.querySelector('[data-bs-original-title="Show analysis tools"], [title="Show analysis tools"]');
          if (btn && btn.offsetWidth > 0) {
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return null;
        })()`, 15000);

        if (!analysisBtn) {
          console.log(`[Interference] Analysis tools button not found for "${asm.name}"`);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Analysis tools not found" };
          continue;
        }

        // Click "Show analysis tools"
        await cdpClick(tabId, analysisBtn.x, analysisBtn.y);

        // Wait for "Interference detection..." menu item (up to 3s)
        const interferenceItem = await waitForElement(tabId, `(() => {
          const items = document.querySelectorAll('span.context-menu-item-span');
          for (const item of items) {
            if (item.textContent.trim().toLowerCase().includes('interference')) {
              const r = item.getBoundingClientRect();
              if (r.width > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: item.textContent.trim() };
            }
          }
          return null;
        })()`, 3000);

        if (!interferenceItem) {
          console.log(`[Interference] Interference menu item not found for "${asm.name}"`);
          await cdpPressKey(tabId, "Escape", 27);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Menu item not found" };
          continue;
        }

        console.log(`[Interference] Opening interference dialog`);
        await cdpClick(tabId, interferenceItem.x, interferenceItem.y);

        // Wait for interference detection dialog (up to 5s)
        const dialogFound = await waitForElement(tabId, `(() => {
          const dialog = document.querySelector('#interference-detection-dialog');
          if (dialog && dialog.offsetWidth > 0) return true;
          return null;
        })()`, 5000);

        if (!dialogFound) {
          console.log(`[Interference] Dialog not found for "${asm.name}"`);
          await cdpPressKey(tabId, "Escape", 27);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Dialog not found" };
          continue;
        }

        // Check if instances are already populated (auto-populated in manual flow)
        const hasInstances = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const dialog = document.querySelector('#interference-detection-dialog');
            if (!dialog) return 0;
            const container = dialog.querySelector('[data-parameter-id="bodiesToCheck"]');
            if (!container) return 0;
            return container.querySelectorAll('.os-selection-item-line').length;
          })()`,
          returnByValue: true,
        });
        const instanceCount = hasInstances.result?.value || 0;
        console.log(`[Interference] Instances already populated: ${instanceCount}`);

        if (instanceCount === 0) {
          // Click the bodiesToCheck area to activate selection mode
          const bodiesToCheck = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const dialog = document.querySelector('#interference-detection-dialog');
              if (!dialog) return null;
              const el = dialog.querySelector('[data-parameter-id="bodiesToCheck"]');
              if (el && el.offsetWidth > 0) {
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
              return null;
            })()`,
            returnByValue: true,
          });

          if (bodiesToCheck.result?.value) {
            console.log(`[Interference] Clicking bodiesToCheck at (${bodiesToCheck.result.value.x}, ${bodiesToCheck.result.value.y})`);
            await cdpClick(tabId, bodiesToCheck.result.value.x, bodiesToCheck.result.value.y);
            await new Promise(r => setTimeout(r, 500));

            // Click the top-level assembly entry text in the sidebar (right side to avoid left icons)
            const asmEntry = await cdpSend(tabId, "Runtime.evaluate", {
              expression: `(() => {
                const dialog = document.querySelector('#interference-detection-dialog');
                const labels = document.querySelectorAll('.os-list-item-label');
                for (const el of labels) {
                  if (dialog && dialog.contains(el)) continue;
                  if (el.offsetWidth === 0) continue;
                  const text = el.textContent.trim();
                  if (text === ${JSON.stringify(asm.name)}) {
                    const r = el.getBoundingClientRect();
                    return { text, x: Math.round(r.right - 20), y: Math.round(r.top + r.height / 2) };
                  }
                }
                return null;
              })()`,
              returnByValue: true,
            });

            if (asmEntry.result?.value) {
              console.log(`[Interference] Clicking assembly entry: "${asmEntry.result.value.text}" at (${asmEntry.result.value.x}, ${asmEntry.result.value.y})`);
              await cdpClick(tabId, asmEntry.result.value.x, asmEntry.result.value.y);
            }

            // Wait for instances to populate (up to 5s)
            const populated = await waitForElement(tabId, `(() => {
              const dialog = document.querySelector('#interference-detection-dialog');
              if (!dialog) return null;
              const container = dialog.querySelector('[data-parameter-id="bodiesToCheck"]');
              if (!container) return null;
              const items = container.querySelectorAll('.os-selection-item-line');
              return items.length > 0 ? items.length : null;
            })()`, 5000);
            console.log(`[Interference] ${populated || 0} instance(s) selected`);
          }
        }

        // Wait for interference results to compute (poll interferenceBodies for up to 20s)
        console.log("[Interference] Waiting for results to compute...");
        let resultsReady = false;
        for (let poll = 0; poll < 20; poll++) {
          await new Promise(r => setTimeout(r, 1000));
          const snap = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const dialog = document.querySelector('#interference-detection-dialog');
              if (!dialog) return { open: false };
              const container = dialog.querySelector('[data-parameter-id="interferenceBodies"]');
              const items = container ? container.querySelectorAll('.os-selection-item-line').length : 0;
              const noInt = !!dialog.querySelector('[title="No interferences"]');
              const text = dialog.textContent.toLowerCase();
              const noIntText = text.includes('no interference');
              return { open: true, items, noInt: noInt || noIntText };
            })()`,
            returnByValue: true,
          });
          const s = snap.result?.value || {};
          if (!s.open) { console.log("[Interference] Dialog closed unexpectedly"); break; }
          if (s.items > 0 || s.noInt) { resultsReady = true; break; }
        }

        // Read interference results from dialog
        const intResult = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const dialog = document.querySelector('#interference-detection-dialog');
            if (!dialog) return { interferences: [], count: 0 };
            // "No interferences" indicator
            if (dialog.querySelector('[title="No interferences"]')) return { interferences: [], count: 0 };
            // Read interference pairs from results list
            const container = dialog.querySelector('[data-parameter-id="interferenceBodies"]');
            const items = (container || dialog).querySelectorAll('.os-selection-item-line');
            const pairs = [];
            for (const item of items) {
              const text = item.textContent.trim();
              if (text) pairs.push(text);
            }
            // Fallback: check text content for "no interference"
            if (pairs.length === 0 && dialog.textContent.toLowerCase().includes('no interference')) {
              return { interferences: [], count: 0 };
            }
            return { interferences: pairs, count: pairs.length };
          })()`,
          returnByValue: true,
        });

        const intData = intResult.result?.value || { interferences: [], count: 0 };
        results.assemblies[asm.name] = intData;
        results.totalInterferences += intData.count;
        console.log(`[Interference] ${asm.name}: ${intData.count} interference(s)`, intData.interferences);

        // Close dialog
        const closeBtnPos = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const dialog = document.querySelector('#interference-detection-dialog');
            if (!dialog) return null;
            const btn = dialog.querySelector('.btn-close.ns-dialog-button-close')
              || dialog.querySelector('.btn-close')
              || dialog.querySelector('[class*="close"]');
            if (btn && btn.offsetWidth > 0) {
              const r = btn.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
            return null;
          })()`,
          returnByValue: true,
        });

        if (closeBtnPos.result?.value) {
          await cdpClick(tabId, closeBtnPos.result.value.x, closeBtnPos.result.value.y);
        } else {
          await cdpPressKey(tabId, "Escape", 27);
        }
        await new Promise(r => setTimeout(r, 500));

      } catch (asmErr) {
        console.error(`[Interference] Error on "${asm.name}":`, asmErr.message);
        results.assemblies[asm.name] = { interferences: [], count: 0, error: asmErr.message };
        try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
      }
    }

    // Navigate back to root if we entered a folder
    if (enteredFolder) {
      const allTabsBtn = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const crumbs = document.querySelectorAll('.os-tab-bar-breadcrumb');
          for (const c of crumbs) {
            if (c.getAttribute('title') === 'All tabs' || c.textContent.trim() === 'All tabs') {
              const r = c.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          if (crumbs.length > 0) {
            const r = crumbs[0].getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return null;
        })()`,
        returnByValue: true,
      });
      if (allTabsBtn.result?.value) {
        await cdpClick(tabId, allTabsBtn.result.value.x, allTabsBtn.result.value.y);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Store results in chrome.storage.local
    const stored = await chrome.storage.local.get("interferenceResults");
    const allResults = stored.interferenceResults || {};
    allResults[docId] = {
      timestamp: new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
      }),
      assemblies: results.assemblies,
      totalInterferences: results.totalInterferences,
    };
    await chrome.storage.local.set({ interferenceResults: allResults });

    sendDone(results);

    // Browser notification if interferences found
    if (results.totalInterferences > 0) {
      const docName = docScan?.doc_name || docId;
      const affectedCount = Object.values(results.assemblies).filter(a => a.count > 0).length;
      chrome.notifications.create(`interference-${docId}-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: docName,
        message: `${results.totalInterferences} interference(s) detected in ${affectedCount} assembl${affectedCount === 1 ? "y" : "ies"}`,
      });
    }

    console.log(`[Interference] Done: ${results.totalInterferences} total across ${assemblyElements.length} assembly(s)`);

  } catch (e) {
    console.error("[Interference] Fatal error:", e.message);
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendDone({ totalInterferences: 0, assemblies: {}, error: e.message });
  } finally {
    _interferenceInProgress = false;
    hideCdpOverlay(senderTabId);
    if (needsDetach) chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Interference Observer — call directly from service worker console
// ---------------------------------------------------------------------------
// Step 1: Open assembly, open interference dialog manually
// Step 2: observeInterference()   — starts recording DOM mutations
// Step 3: Select instances manually in the dialog
// Step 4: readInterferenceObserver()  — dumps mutations + dialog snapshot

async function observeInterference() {
  const tabs = await chrome.tabs.query({ url: "https://cad.onshape.com/*" });
  if (tabs.length === 0) return console.log("[IntObs] No Onshape tab found");
  await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: () => {
      const dialog = document.querySelector('#interference-detection-dialog');
      if (!dialog) return console.log("[IntObs] No interference dialog found -- open it first");
      window.__intObsChanges = [];
      window.__intObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes') {
            const el = m.target;
            const r = el.getBoundingClientRect();
            window.__intObsChanges.push({
              action: 'attr-changed', attr: m.attributeName,
              newVal: (el.getAttribute(m.attributeName) || '').slice(0, 200),
              tag: el.tagName, cls: (el.className || '').toString().slice(0, 150),
              text: el.textContent.trim().slice(0, 80),
              x: Math.round(r.left), y: Math.round(r.top),
              w: Math.round(r.width), h: Math.round(r.height),
            });
          }
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const r = node.getBoundingClientRect();
            window.__intObsChanges.push({
              action: 'added', tag: node.tagName,
              cls: (node.className || '').toString().slice(0, 150),
              text: node.textContent.trim().slice(0, 120),
              x: Math.round(r.left), y: Math.round(r.top),
              w: Math.round(r.width), h: Math.round(r.height),
              html: node.outerHTML.slice(0, 400),
            });
          }
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1) continue;
            window.__intObsChanges.push({
              action: 'removed', tag: node.tagName,
              cls: (node.className || '').toString().slice(0, 150),
              text: node.textContent.trim().slice(0, 80),
            });
          }
        }
      });
      window.__intObserver.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'title', 'aria-selected', 'data-selected', 'style'],
      });
      console.log("[IntObs] Recording. Select instances, then call readInterferenceObserver() in SW console.");
    },
  });
  console.log("[IntObs] Observer injected. Select instances in the dialog, then call readInterferenceObserver()");
}

async function readInterferenceObserver() {
  const tabs = await chrome.tabs.query({ url: "https://cad.onshape.com/*" });
  if (tabs.length === 0) return console.log("[IntObs] No Onshape tab found");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: () => {
      if (window.__intObserver) { window.__intObserver.disconnect(); window.__intObserver = null; }
      const changes = window.__intObsChanges || [];
      window.__intObsChanges = [];
      const dialog = document.querySelector('#interference-detection-dialog');
      let snapshot = null;
      if (dialog) {
        const items = dialog.querySelectorAll('.os-selection-item-line, [class*="selection-item"], [class*="query-list-item"]');
        snapshot = {
          itemCount: items.length,
          items: Array.from(items).slice(0, 20).map(el => ({
            cls: (el.className || '').toString().slice(0, 100),
            text: el.textContent.trim().slice(0, 80),
          })),
          bodyText: dialog.textContent.trim().slice(0, 500),
        };
      }
      return { changes, snapshot };
    },
  });
  const data = results?.[0]?.result || {};
  const changes = data.changes || [];
  const interesting = changes.filter(c =>
    c.action === 'added' ? (c.w > 5 && c.h > 5 && c.text.length > 0) :
    c.action === 'attr-changed' ? true : true
  );
  console.log(`[IntObs] ${changes.length} total mutations, ${interesting.length} interesting:`);
  for (const c of interesting.slice(0, 50)) {
    if (c.action === 'added') {
      console.log(`  + [${c.tag}] cls="${c.cls}" text="${c.text}" (${c.w}x${c.h})`);
      if (c.html) console.log(`    html: ${c.html}`);
    } else if (c.action === 'attr-changed') {
      console.log(`  ~ [${c.tag}] ${c.attr}="${c.newVal}" cls="${c.cls}" text="${c.text}"`);
    } else if (c.action === 'removed') {
      console.log(`  - [${c.tag}] cls="${c.cls}" text="${c.text}"`);
    }
  }
  if (data.snapshot) {
    console.log("[IntObs] Dialog snapshot:", JSON.stringify(data.snapshot, null, 2));
  }
  return data;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "fetch-parts") {
    // Fetch parts list and return to popup for selection
    (async () => {
      const parsed = parsePartStudioUrl(msg.url || "");
      if (!parsed) { sendResponse({ error: "Invalid Part Studio URL" }); return; }
      try {
        const parts = await onshapeFetch(`/api/v10/parts/d/${parsed.docId}/w/${parsed.wid}/e/${parsed.eid}`);
        if (!parts || parts.length === 0) { sendResponse({ error: "No parts found" }); return; }
        // Return minimal part data to popup
        const partList = parts.map(p => ({ partId: p.partId, name: p.name || "Unnamed" }));
        sendResponse({ parts: partList });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // async sendResponse

  } else if (msg.type === "create-drawings") {
    createDrawingsForUrl(msg.url, msg.selectedParts || null);
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "tab-folder-result") {
    // Auto-scan result from content.js — store per doc
    storeDocScanResult(msg.data);

  } else if (msg.type === "folder-scan-notify") {
    // Delayed notification from content.js (10s after scan found illegal tabs)
    chrome.notifications.create(`folder-scan-${msg.docId}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: msg.docName || msg.docId,
      message: "Incorrect folder structure, please take action.",
    });

  } else if (msg.type === "check-releases") {
    (async () => {
      try {
        const data = await onshapeFetch(`/api/v10/revisions/d/${msg.docId}`);
        const items = data.items || [];
        console.log(`[ExportDetect] Doc ${msg.docId}: ${items.length} revision(s)`);
        sendResponse({ hasReleases: items.length > 0, count: items.length });
      } catch (e) {
        console.log(`[ExportDetect] Release check failed: ${e.message}`);
        sendResponse({ hasReleases: false, count: 0, error: e.message });
      }
    })();
    return true; // async sendResponse

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
    const tabId = sender.tab?.id;
    checkDocViolations(docId, docName, wid, tabId);

  } else if (msg.type === "create-folders") {
    // Folder creation via CDP — triggered from content.js overlay
    const folderNames = msg.folders || [];
    const tabId = sender.tab?.id;
    if (!tabId || folderNames.length === 0) {
      sendResponse({ error: "Missing tab or folders" });
      return;
    }
    createTabFolders(tabId, tabId, folderNames);
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "sort-tabs") {
    // Persistent tab sorter — moves stray root tabs into matching folders
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: "No tab" }); return; }
    sortStrayTabs(tabId, tabId).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;

  } else if (msg.type === "check-interference") {
    // Interference detection via CDP — triggered from popup or content.js
    const { docId, wid } = msg;
    // sender.tab exists when from content.js; from popup we need to find the Onshape tab
    const fromTab = sender.tab?.id;
    if (fromTab) {
      checkInterference(fromTab, fromTab, docId, wid);
    } else {
      chrome.tabs.query({ url: "https://cad.onshape.com/*" }, (tabs) => {
        const tab = tabs.find(t => t.url && t.url.includes(docId));
        if (tab) {
          checkInterference(tab.id, tab.id, docId, wid);
        } else {
          sendResponse({ error: "No matching Onshape tab" });
        }
      });
    }
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "discover-context-menu") {
    // Discovery helper — run once to find context menu selectors
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      const result = await discoverContextMenu(tabs[0].id);
      sendResponse(result);
    });
    return true;

  } else if (msg.type === "observe-dom-changes") {
    // DOM observer: start recording mutations. User manually right-clicks and
    // creates a folder, then sends "read-dom-changes" to dump what happened.
    // Run from console: chrome.runtime.sendMessage({type:"observe-dom-changes"})
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            window.__domChanges = [];
            window.__domObserver = new MutationObserver((mutations) => {
              for (const m of mutations) {
                for (const node of m.addedNodes) {
                  if (node.nodeType !== 1) continue;
                  const el = node;
                  const r = el.getBoundingClientRect();
                  window.__domChanges.push({
                    action: "added",
                    tag: el.tagName,
                    cls: (el.className || "").toString().slice(0, 150),
                    text: el.textContent.trim().slice(0, 120),
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height),
                    children: el.children.length,
                    html: el.outerHTML.slice(0, 300),
                  });
                }
              }
            });
            window.__domObserver.observe(document.body, { childList: true, subtree: true });
            console.log("[DOM Observer] Recording started. Right-click tab bar and create a folder, then run: chrome.runtime.sendMessage({type:'read-dom-changes'})");
          },
        });
        sendResponse({ ok: true, msg: "Recording. Do the manual action, then send 'read-dom-changes'" });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;

  } else if (msg.type === "read-dom-changes") {
    // Read back recorded DOM mutations
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            if (window.__domObserver) {
              window.__domObserver.disconnect();
              window.__domObserver = null;
            }
            const changes = window.__domChanges || [];
            window.__domChanges = [];
            return changes;
          },
        });
        const changes = results?.[0]?.result || [];
        console.log(`[DOM Observer] ${changes.length} DOM mutations recorded:`);
        // Log the interesting ones (not our own toast, visible, menu-like)
        const interesting = changes.filter(c =>
          c.w > 20 && c.h > 10 && !c.cls.includes("oxt-") && c.text.length > 0
        );
        for (const c of interesting) {
          console.log(`  [${c.tag}] cls="${c.cls}" text="${c.text}" (${c.w}x${c.h} at ${c.x},${c.y})`);
        }
        console.log("[DOM Observer] Full dump:", JSON.stringify(interesting, null, 2));
        sendResponse({ count: changes.length, interesting });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;

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

// ---------------------------------------------------------------------------
// SPA navigation detection — notify content script when Onshape URL changes
// ---------------------------------------------------------------------------

// Track last known URL per tab to detect doc switches
const _tabUrls = {};

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!changeInfo.url.includes("cad.onshape.com/documents/")) return;
  const prev = _tabUrls[tabId] || "";
  _tabUrls[tabId] = changeInfo.url;
  // Only notify if the document ID changed (not just element/workspace switch)
  const prevDocId = prev.match(/\/documents\/([a-f0-9]+)/)?.[1];
  const newDocId = changeInfo.url.match(/\/documents\/([a-f0-9]+)/)?.[1];
  if (newDocId && newDocId !== prevDocId) {
    console.log("[SPA] Doc switch detected:", prevDocId, "->", newDocId);
    chrome.tabs.sendMessage(tabId, {
      type: "spa-navigated",
      url: changeInfo.url,
    }).catch(() => {
      // Content script not injected — reload tab as backup (approach C)
      console.log("[SPA] Content script not reachable, reloading tab");
      chrome.tabs.reload(tabId);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { delete _tabUrls[tabId]; });

// ---------------------------------------------------------------------------
// Notification click — open popup to the relevant section
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener((notificationId) => {
  let section = "";
  if (notificationId.startsWith("folder-scan-")) {
    section = "scanner";
  } else if (notificationId.startsWith("violations-") || notificationId.startsWith("interference-")) {
    section = "violations";
  }
  if (section) {
    // Store target section so popup.js can navigate to it on open
    chrome.storage.local.set({ popupTargetSection: section });
    // Open the popup (Chrome 99+ Manifest V3)
    chrome.action.openPopup().catch(() => {
      // Fallback: open popup.html as a tab if openPopup() unavailable
      chrome.tabs.create({ url: `popup.html?section=${section}` });
    });
  }
  chrome.notifications.clear(notificationId);
});
