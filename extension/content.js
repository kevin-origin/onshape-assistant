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

  function getWidFromUrl() {
    const m = window.location.pathname.match(/\/w\/([a-f0-9]+)/);
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
    // Onshape may start inside a folder (remembers last view).
    // Breadcrumbs may not have rendered yet when waitForTabBar() returns,
    // so poll for them briefly before giving up.
    for (let attempt = 0; attempt < 6; attempt++) {
      const btn = getAllTabsBreadcrumb();
      if (btn) {
        btn.click();
        await sleep(ROOT_DELAY);
        return;
      }
      // No breadcrumb found — either we're at root already, or it hasn't rendered.
      // Check: if breadcrumb depth > 0 but none say "All tabs", try the first one.
      const crumbs = document.querySelectorAll(".os-tab-bar-breadcrumb");
      if (crumbs.length > 0) {
        // Click the first (leftmost) breadcrumb — that's the root
        crumbs[0].click();
        await sleep(ROOT_DELAY);
        return;
      }
      // No breadcrumbs at all — likely at root. But on first few attempts,
      // wait a bit in case they haven't loaded yet.
      if (attempt < 5) await sleep(300);
    }
    // No breadcrumbs after polling — we're at root
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

        // Double-click to open folders (single-click just selects the tab)
        item.el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        await sleep(CLICK_DELAY);

        const depthAfter = getBreadcrumbDepth();

        if (depthAfter > depthBefore) {
          // This was a FOLDER — breadcrumb depth increased
          const children = getTabNames().map(c => c.text);
          result.folders[itemName] = children;

          // Return to root
          await clickAllTabs();
        } else {
          // Regular tab — not a folder (dblclick opened it in workspace, no nav)
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
  // Auto-scan logic — runs on every Onshape doc open
  // ---------------------------------------------------------------------------

  async function autoScan() {
    const docId = getDocIdFromUrl();
    if (!docId) return;

    // Wait for tab bar to be ready
    await waitForTabBar();

    const result = await scanTabFolders();
    if (!result) return;

    // Send to background for per-doc storage
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
  // Auto-scan on page load (every Onshape doc)
  // ---------------------------------------------------------------------------

  // Small delay to let Onshape fully initialize
  setTimeout(() => autoScan(), 3000);

  // Check violations (versions, parts, features, tabs) for release tracker
  setTimeout(() => {
    const docId = getDocIdFromUrl();
    const wid = getWidFromUrl();
    const docName = getDocName();
    if (docId) {
      chrome.runtime.sendMessage({ type: "check-versions", docId, docName, wid });
    }
  }, 3000);
})();
