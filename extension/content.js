// content.js — Onshape Tab Folder Scanner
// Injected into Onshape document pages. Reads the tab bar DOM by clicking
// through folders and reporting the structure back to background.js.

(function () {
  "use strict";

  const CLICK_DELAY = 500;   // ms after clicking a folder before reading children
  const ROOT_DELAY  = 500;   // ms after clicking "All tabs" breadcrumb
  let _scanning = false;     // lock to prevent concurrent scans

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getDocIdFromUrl() {
    const m = window.location.pathname.match(/\/documents\/([a-f0-9]+)/);
    return m ? m[1] : null;
  }

  function getDocName() {
    // Onshape sets document name in the page title: "DocName | Onshape"
    const title = document.title || "";
    const pipe = title.indexOf("|");
    return pipe > 0 ? title.substring(0, pipe).trim() : title.trim();
  }

  function getAllTabsBreadcrumb() {
    // The "All tabs" breadcrumb resets the tab bar to root view
    const crumbs = document.querySelectorAll(".os-tab-bar-breadcrumb");
    for (const c of crumbs) {
      if (c.getAttribute("title") === "All tabs" || c.textContent.trim() === "All tabs") {
        return c;
      }
    }
    return null;
  }

  function getTabNames() {
    return Array.from(document.querySelectorAll(".os-tab-name")).map(el => ({
      text: el.textContent.trim(),
      el: el,
    }));
  }

  function getBreadcrumbDepth() {
    return document.querySelectorAll(".os-tab-bar-breadcrumb").length;
  }

  async function clickAllTabs() {
    const btn = getAllTabsBreadcrumb();
    if (btn) {
      btn.click();
      await sleep(ROOT_DELAY);
    }
  }

  // ---------------------------------------------------------------------------
  // Main scan
  // ---------------------------------------------------------------------------

  async function scanTabFolders() {
    if (_scanning) return null; // another scan already running
    _scanning = true;

    try {
      const docId = getDocIdFromUrl();
      if (!docId) return null;

      const result = {
        doc_id: docId,
        doc_name: getDocName(),
        folders: {},
        root_tabs: [],
      };

      // Step 1: Click "All tabs" to ensure we're at root
      await clickAllTabs();

      // Step 2: Read root-level items
      const rootItems = getTabNames();
      if (rootItems.length === 0) return result;

      const depthBefore = getBreadcrumbDepth();

      for (let i = 0; i < rootItems.length; i++) {
        // Re-query each iteration because DOM may have changed after navigation
        const currentItems = getTabNames();
        if (i >= currentItems.length) break;

        const item = currentItems[i];
        const itemName = item.text;

        // Click this item
        item.el.click();
        await sleep(CLICK_DELAY);

        const depthAfter = getBreadcrumbDepth();

        if (depthAfter > depthBefore) {
          // This was a FOLDER — breadcrumb depth increased
          const children = getTabNames().map(c => c.text);
          result.folders[itemName] = children;

          // Return to root
          await clickAllTabs();
        } else {
          // Regular tab — not a folder
          result.root_tabs.push(itemName);
          // Return to root to keep position consistent
          await clickAllTabs();
        }
      }

      return result;
    } finally {
      _scanning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-scan logic (only for registered docs)
  // ---------------------------------------------------------------------------

  async function autoScan() {
    const docId = getDocIdFromUrl();
    if (!docId) return;

    // Skip if bulk scan is running (it handles scanning itself)
    const data = await chrome.storage.local.get(["registeredDocIds", "bulkScanRunning"]);
    if (data.bulkScanRunning) return;

    const registered = data.registeredDocIds || [];
    if (registered.length === 0) return;          // No bulk scan done yet
    if (!registered.includes(docId)) return;      // Not a registered doc

    // Wait for tab bar to be ready
    await waitForTabBar();

    const result = await scanTabFolders();
    if (!result) return;

    // Send to background for dashboard reporting
    chrome.runtime.sendMessage({ type: "tab-folder-result", data: result });
  }

  async function waitForTabBar() {
    // Poll for the tab bar to appear (Onshape loads it dynamically)
    for (let i = 0; i < 30; i++) {
      if (document.querySelector(".os-tab-name")) return;
      await sleep(500);
    }
  }

  // ---------------------------------------------------------------------------
  // Message handler — background.js can trigger a scan on demand
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "scan-tab-folders") {
      waitForTabBar()
        .then(() => scanTabFolders())
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true; // keep channel open for async response
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-scan on page load (only registered docs)
  // ---------------------------------------------------------------------------

  // Small delay to let Onshape fully initialize
  setTimeout(() => autoScan(), 3000);

  // Check version count for release tracker
  setTimeout(() => {
    const docId = getDocIdFromUrl();
    const docName = getDocName();
    if (docId) {
      chrome.runtime.sendMessage({ type: "check-versions", docId, docName });
    }
  }, 3000);
})();
