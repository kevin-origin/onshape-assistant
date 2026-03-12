// background.js — Onshape Tab Folder Scanner service worker
// Orchestrates bulk scans: discovers docs via Onshape session cookies,
// opens a scanner tab, cycles through docs, collects results, POSTs to dashboard.

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

async function runBulkScan(folderIds, dashboardUrl) {
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

    // 5. POST results to dashboard
    if (dashboardUrl && scanState.results.length > 0) {
      await postResultsToDashboard(dashboardUrl, scanState.results);
    }

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
// Dashboard POST
// ---------------------------------------------------------------------------

async function postResultsToDashboard(dashboardUrl, results) {
  const url = dashboardUrl.replace(/\/+$/, "") + "/api/report-tab-folders";

  for (const result of results) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
    } catch (err) {
      console.error(`[Scanner] Failed to POST result for ${result.doc_id}:`, err);
    }
  }
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
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "start-bulk-scan") {
    const { folderIds, dashboardUrl } = msg;
    runBulkScan(folderIds, dashboardUrl).then(sendResponse);
    return true; // async response

  } else if (msg.type === "get-scan-status") {
    sendResponse({
      running: scanState.running,
      total: scanState.total,
      scanned: scanState.scanned,
    });

  } else if (msg.type === "tab-folder-result") {
    // Auto-scan result from content.js — forward to dashboard
    chrome.storage.local.get("dashboardUrl", (data) => {
      const dashboardUrl = data.dashboardUrl || "";
      if (dashboardUrl) {
        postResultsToDashboard(dashboardUrl, [msg.data]);
      }
    });

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

      // POST to dashboard
      chrome.storage.local.get("dashboardUrl", (data) => {
        if (data.dashboardUrl) postResultsToDashboard(data.dashboardUrl, [result]);
      });
      sendResponse(result);
    });
    return true;
  }
});
