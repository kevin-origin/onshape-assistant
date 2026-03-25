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
    return Array.from(document.querySelectorAll(".os-tab-name")).map(el => {
      // TAB-LIST-ITEM.os-tab-bar-tab is the real tab container
      // Folders have additional class: os-tab-bar-tab-group
      const tab = el.closest(".os-tab-bar-tab") || el.parentElement;
      const isFolder = tab.classList?.contains("os-tab-bar-tab-group") || false;
      const classes = (tab.className || "").toString().toLowerCase();
      // Detect element type from tab classes (assembly, partstudio, drawing, etc.)
      let tabType = "unknown";
      if (isFolder) tabType = "folder";
      else if (classes.includes("assembly")) tabType = "assembly";
      else if (classes.includes("partstudio") || classes.includes("part-studio")) tabType = "partstudio";
      else if (classes.includes("drawing")) tabType = "drawing";
      return { text: el.textContent.trim(), el: el, tab: tab, isFolder, tabType, classes };
    });
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

      // Debug: log detected root items
      console.log("[Scanner] Root items:", rootItems.map(r => ({
        text: r.text, isFolder: r.isFolder, tabType: r.tabType, classes: r.classes,
      })));

      const depthBefore = getBreadcrumbDepth();

      // First pass: classify root items as folder or root tab
      for (const item of rootItems) {
        if (item.isFolder) {
          result.folders[item.text] = { children: [], assemblies: 0 };
        } else {
          result.root_tabs.push(item.text);
        }
      }

      // Second pass: click into each folder to read children and count assemblies.
      // Try multiple click targets — Onshape's Angular may bind the handler on
      // any of these elements. Stop as soon as breadcrumb depth increases.
      for (let i = 0; i < rootItems.length; i++) {
        if (!rootItems[i].isFolder) continue;
        const folderName = rootItems[i].text;

        // Re-query to get fresh DOM references
        const freshItems = getTabNames();
        const folderItem = freshItems.find(f => f.text === folderName && f.isFolder);
        if (!folderItem) continue;

        const wrapper = folderItem.el.closest(".tab-content-wrapper");
        const targets = [
          { name: "tab-content-wrapper", el: wrapper },
          { name: "TAB-LIST-ITEM", el: folderItem.tab },
          { name: "ELEMENT-NAME", el: folderItem.el.parentElement },
          { name: "os-tab-name", el: folderItem.el },
        ].filter(t => t.el);

        let navigated = false;
        for (const target of targets) {
          const rect = target.el.getBoundingClientRect();
          if (rect.width === 0) continue;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };

          target.el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1 }));
          await sleep(30);
          target.el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1 }));
          await sleep(30);
          target.el.dispatchEvent(new MouseEvent("click", opts));
          await sleep(CLICK_DELAY);

          if (getBreadcrumbDepth() > depthBefore) {
            console.log(`[Scanner] Folder "${folderName}" opened via: ${target.name}`);
            navigated = true;
            break;
          }
        }

        if (navigated) {
          const children = getTabNames();
          const childNames = children.map(c => c.text);
          const assemblyCount = children.filter(c => c.tabType === "assembly").length;

          console.log(`[Scanner] Folder "${folderName}" children:`, children.map(c => ({
            text: c.text, tabType: c.tabType, classes: c.classes,
          })));

          result.folders[folderName] = { children: childNames, assemblies: assemblyCount };
          await clickAllTabs();
        }
        // If no target worked, folder stays with defaults (0 assemblies)
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

    // Notify after 10s if issues found (delay lives here in the content
    // script because the service worker may sleep before a setTimeout fires)
    const ALLOWED_FOLDERS = ["Parts", "Assemblies", "Drawings", "CAD Imports", "Feature Studios"];
    const folderData = result.folders || {};
    const folders = Object.keys(folderData);
    const rootTabs = result.root_tabs || [];
    const illegal = [
      ...folders.filter(f => !ALLOWED_FOLDERS.includes(f)),
      ...rootTabs,
    ];
    const multiAssembly = Object.entries(folderData).some(
      ([, data]) => typeof data === "object" && data.assemblies > 1
    );
    if (illegal.length > 0 || multiAssembly) {
      setTimeout(() => {
        chrome.runtime.sendMessage({
          type: "folder-scan-notify",
          docId: result.doc_id,
          docName: result.doc_name,
        });
      }, 10000);
    }
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
      // If auto-scan is running, wait for it to finish then scan fresh
      const waitThenScan = async () => {
        for (let i = 0; i < 60 && _scanning; i++) await sleep(500); // up to 30s
        await waitForTabBar();
        return scanTabFolders();
      };
      waitThenScan()
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
