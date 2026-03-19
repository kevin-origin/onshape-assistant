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

  // ---------------------------------------------------------------------------
  // DOM automation: add a new drawing sheet
  // ---------------------------------------------------------------------------

  async function exploreDrawingDom() {
    const results = {};

    // 1. Elements with 'sheet' in class name
    results.sheetClassEls = Array.from(document.querySelectorAll("[class*='sheet' i]")).map(el => ({
      tag: el.tagName,
      class: el.className.toString().slice(0, 120),
      text: el.textContent.trim().slice(0, 60),
      visible: el.offsetHeight > 0,
    }));

    // 2. Elements with 'Sheet' in text content (exact word)
    results.sheetTextEls = Array.from(document.querySelectorAll("*")).filter(el =>
      el.textContent.trim().match(/^Sheet\s*\d+$/i) && el.children.length === 0 && el.offsetHeight > 0
    ).map(el => ({
      tag: el.tagName,
      class: el.className.toString().slice(0, 120),
      text: el.textContent.trim(),
      parent: el.parentElement ? { tag: el.parentElement.tagName, class: el.parentElement.className.toString().slice(0, 120) } : null,
    }));

    // 3. Bottom 120px of viewport — likely sheet tab bar area
    results.bottomBar = Array.from(document.querySelectorAll("*")).filter(el => {
      const r = el.getBoundingClientRect();
      return r.bottom > window.innerHeight - 120 && r.height > 3 && r.height < 80 && el.children.length < 5;
    }).slice(0, 40).map(el => ({
      tag: el.tagName,
      class: el.className.toString().slice(0, 120),
      text: el.textContent.trim().slice(0, 60),
      h: Math.round(el.getBoundingClientRect().height),
    }));

    // 4. Any add/insert/plus buttons or icons
    results.addButtons = Array.from(document.querySelectorAll(
      "[aria-label*='add' i], [aria-label*='insert' i], [aria-label*='new' i], [data-tooltip*='add' i], [data-tooltip*='insert' i], [data-tooltip*='sheet' i], [title*='add' i], [title*='insert' i], [title*='sheet' i]"
    )).map(el => ({
      tag: el.tagName,
      class: el.className.toString().slice(0, 120),
      text: el.textContent.trim().slice(0, 60),
      ariaLabel: el.getAttribute("aria-label"),
      tooltip: el.getAttribute("data-tooltip"),
      title: el.getAttribute("title"),
    }));

    // 5. Right-click context menu (if any already visible)
    results.contextMenus = Array.from(document.querySelectorAll(
      "[class*='context-menu' i], [class*='contextmenu' i], [class*='popup-menu' i], [class*='dropdown-menu' i], [role='menu']"
    )).map(el => ({
      tag: el.tagName,
      class: el.className.toString().slice(0, 120),
      childCount: el.children.length,
      items: Array.from(el.children).slice(0, 10).map(c => c.textContent.trim().slice(0, 60)),
    }));

    console.log("[DrawSheet DOM Explorer]", JSON.stringify(results, null, 2));
    return results;
  }

  async function addDrawingSheet() {
    // First, log DOM structure for debugging
    const domInfo = await exploreDrawingDom();
    console.log("[DrawSheet] DOM exploration complete, attempting sheet creation...");

    // Strategy 1: Look for a "+" button or "Add sheet" button near the sheet tabs
    const addBtn = document.querySelector(
      ".os-add-sheet-button, .os-sheet-add, [data-tooltip*='sheet' i], [aria-label*='sheet' i], [aria-label*='Insert' i]"
    );
    if (addBtn) {
      console.log("[DrawSheet] Found add-sheet button:", addBtn.className, addBtn.textContent.trim());
      addBtn.click();
      await sleep(2000);
      return { ok: true, method: "add-button" };
    }

    // Strategy 2: Right-click on the first sheet tab to get context menu
    // Find sheet tab elements (Sheet 1 tab)
    const sheetTabs = document.querySelectorAll(
      ".os-drawing-sheet-tab, .os-sheet-tab, [class*='sheet-tab'], [class*='SheetTab']"
    );
    console.log("[DrawSheet] Sheet tabs found:", sheetTabs.length,
      Array.from(sheetTabs).map(el => ({ class: el.className, text: el.textContent.trim() }))
    );

    // Also try finding by text content "Sheet 1"
    let sheetTabEl = null;
    if (sheetTabs.length > 0) {
      sheetTabEl = sheetTabs[0];
    } else {
      // Broader search: any element containing "Sheet 1" text near bottom of page
      const allEls = document.querySelectorAll("span, div, li, button, a");
      for (const el of allEls) {
        if (el.textContent.trim() === "Sheet 1" && el.offsetHeight > 0) {
          sheetTabEl = el;
          console.log("[DrawSheet] Found 'Sheet 1' element by text:", el.tagName, el.className);
          break;
        }
      }
    }

    if (sheetTabEl) {
      console.log("[DrawSheet] Right-clicking sheet tab:", sheetTabEl.tagName, sheetTabEl.className);
      // Dispatch right-click (contextmenu event)
      const rect = sheetTabEl.getBoundingClientRect();
      const rightClick = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 2,
      });
      sheetTabEl.dispatchEvent(rightClick);
      await sleep(1000);

      // Look for context menu items
      const menuItems = document.querySelectorAll(
        ".os-context-menu-item, .context-menu-item, [class*='context-menu'] [class*='item'], [class*='ContextMenu'] [class*='Item'], .os-menu-item"
      );
      console.log("[DrawSheet] Context menu items:", menuItems.length,
        Array.from(menuItems).map(el => el.textContent.trim())
      );

      // Find "Insert new sheet after" or similar
      let insertItem = null;
      for (const item of menuItems) {
        const text = item.textContent.trim().toLowerCase();
        if (text.includes("insert") && text.includes("sheet")) {
          insertItem = item;
          break;
        }
      }

      // Fallback: "Add sheet", "New sheet"
      if (!insertItem) {
        for (const item of menuItems) {
          const text = item.textContent.trim().toLowerCase();
          if ((text.includes("add") || text.includes("new")) && text.includes("sheet")) {
            insertItem = item;
            break;
          }
        }
      }

      if (insertItem) {
        console.log("[DrawSheet] Clicking menu item:", insertItem.textContent.trim());
        insertItem.click();
        await sleep(2000);

        // Verify second sheet appeared
        const newTabs = document.querySelectorAll(
          ".os-drawing-sheet-tab, .os-sheet-tab, [class*='sheet-tab'], [class*='SheetTab']"
        );
        // Also check by text
        let sheet2Found = false;
        const allSpans = document.querySelectorAll("span, div, li, button, a");
        for (const el of allSpans) {
          if (el.textContent.trim() === "Sheet 2" && el.offsetHeight > 0) {
            sheet2Found = true;
            break;
          }
        }
        console.log("[DrawSheet] After insert — sheet tabs:", newTabs.length, "Sheet 2 found:", sheet2Found);
        return { ok: true, method: "context-menu", sheet2Found };
      } else {
        // Dismiss context menu by clicking elsewhere
        document.body.click();
        await sleep(300);
        console.log("[DrawSheet] No 'Insert sheet' item found in context menu");
        return { error: "No 'Insert sheet' menu item found. Check console for DOM details." };
      }
    }

    // Strategy 3: Log everything we can find for debugging
    console.log("[DrawSheet] Could not find sheet tabs or add button. DOM dump of bottom area:");
    const bottomEls = Array.from(document.querySelectorAll("*")).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > window.innerHeight - 100 && rect.height > 5 && rect.height < 60;
    });
    console.log("[DrawSheet] Bottom-area elements:",
      bottomEls.slice(0, 30).map(el => ({
        tag: el.tagName,
        class: el.className.toString().slice(0, 80),
        text: el.textContent.trim().slice(0, 50),
        rect: el.getBoundingClientRect(),
      }))
    );

    return { error: "Could not find sheet tab area. Check console for DOM dump." };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "scan-tab-folders") {
      waitForTabBar()
        .then(() => scanTabFolders())
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true; // keep channel open for async response

    } else if (msg.type === "add-drawing-sheet") {
      addDrawingSheet()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    } else if (msg.type === "explore-drawing-dom") {
      exploreDrawingDom()
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ error: err.message }));
      return true;
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-scan on page load (only registered docs)
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
