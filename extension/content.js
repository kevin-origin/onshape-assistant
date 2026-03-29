// content.js — Onshape Tab Folder Scanner
// Injected into Onshape document pages. Reads the tab bar DOM by clicking
// through folders and reporting the structure back to background.js.

(function () {
  "use strict";

  const CLICK_DELAY = 500;   // ms after clicking a folder before reading children
  const ROOT_DELAY  = 500;   // ms after clicking "All tabs" breadcrumb
  let _scanning = false;     // lock to prevent concurrent scans
  let _folderCreationInProgress = false; // suppress scans during folder creation

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
      // data-icon-src is the reliable type identifier (from DOM observation)
      const iconSrc = tab.getAttribute("data-icon-src") || "";
      let tabType = "unknown";
      if (isFolder) tabType = "folder";
      else if (iconSrc === "partstudio") tabType = "partstudio";
      else if (iconSrc === "assembly") tabType = "assembly";
      else if (iconSrc === "drawing") tabType = "drawing";
      else if (iconSrc === "feature-studio-element") tabType = "featurestudio";
      else if (iconSrc === "variable-studio-element") tabType = "variablestudio";
      return { text: el.textContent.trim(), el: el, tab: tab, isFolder, tabType, iconSrc };
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
        wid: getWidFromUrl(),
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

      // NOTE: Folder navigation via DOM clicks doesn't work (Onshape checks
      // event.isTrusted). Assembly counting per folder is done via API in
      // background.js storeDocScanResult() instead.

      return result;
    } finally {
      _scanning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-scan logic — runs on every Onshape doc open
  // ---------------------------------------------------------------------------

  async function autoScan() {
    if (_folderCreationInProgress) {
      console.log("[Scanner] autoScan skipped: folder creation in progress");
      return;
    }
    const docId = getDocIdFromUrl();
    if (!docId) { console.log("[Scanner] autoScan: no docId"); return; }
    console.log("[Scanner] autoScan starting for", docId);

    // Wait for tab bar to be ready
    await waitForTabBar();
    console.log("[Scanner] Tab bar ready");

    // Quick check: do folders exist? If so, sort first — the single
    // scan runs after sort-done. If no folders, scan immediately.
    const tabs = getTabNames();
    const hasFolders = tabs.some(t => t.isFolder);

    if (hasFolders) {
      // Offer folder creation check (won't show since folders exist, but keeps logic)
      console.log("[Scanner] Folders detected, sorting tabs first");
      chrome.runtime.sendMessage({ type: "sort-tabs" });
      // The single scan happens in the "tab-sort-done" handler.
    } else {
      // No folders — scan now, also check if we should offer folder creation
      const result = await scanTabFolders();
      if (!result) return;
      const overlayShown = await maybeOfferFolderCreation(result);
      // Always send scan result so "no folders" notification fires
      sendScanResult(result);
    }

  }

  function sendScanResult(result) {
    chrome.runtime.sendMessage({ type: "tab-folder-result", data: result });

    const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];
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
    if (illegal.length > 0 || multiAssembly || folders.length === 0) {
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
      if (document.querySelector(".os-tab-name")) {
        console.log(`[Scanner] waitForTabBar: found after ${i * 500}ms`);
        return;
      }
      await sleep(500);
    }
    console.log("[Scanner] waitForTabBar: timed out after 15s");
  }

  // ---------------------------------------------------------------------------
  // Folder creation overlay — offered on new/empty docs
  // ---------------------------------------------------------------------------

  const FOLDER_NAMES = ["Part Studios", "Assemblies", "Drawings", "Feature Studios", "Variable Studios"];

  async function maybeOfferFolderCreation(scanResult) {
    const docId = scanResult.doc_id;
    if (!docId) { console.log("[FolderSetup] No docId"); return false; }

    const folders = Object.keys(scanResult.folders || {});
    const rootTabs = scanResult.root_tabs || [];
    console.log(`[FolderSetup] docId=${docId}, folders=${folders.length}, rootTabs=${rootTabs.length}`);

    // Only offer if: no folders, few root tabs, not already offered
    if (folders.length > 0) { console.log("[FolderSetup] Skipped: has folders"); return false; }
    if (rootTabs.length >= 5) { console.log("[FolderSetup] Skipped: too many root tabs"); return false; }

    // Check if already offered for this doc
    const stored = await chrome.storage.local.get("folderCreationOffered");
    const offered = stored.folderCreationOffered || [];
    if (offered.includes(docId)) { console.log("[FolderSetup] Skipped: already offered"); return false; }

    // Check version count (stored by checkDocViolations, zero extra API calls)
    const vcData = await chrome.storage.local.get("versionCounts");
    const versionCount = (vcData.versionCounts || {})[docId];
    console.log(`[FolderSetup] versionCount=${versionCount}`);
    // If version count not yet available, wait a bit and retry once
    if (versionCount === undefined) {
      console.log("[FolderSetup] Version count not yet available, waiting 3s...");
      await sleep(3000);
      const vcRetry = await chrome.storage.local.get("versionCounts");
      const retryCount = (vcRetry.versionCounts || {})[docId];
      console.log(`[FolderSetup] Retry versionCount=${retryCount}`);
      if (retryCount !== undefined && retryCount > 1) { console.log("[FolderSetup] Skipped: too many versions after retry"); return false; }
      // If still undefined, this is likely a brand-new doc — proceed
    } else if (versionCount > 1) {
      console.log("[FolderSetup] Skipped: too many versions");
      return false; // Not a new doc
    }

    console.log("[FolderSetup] Showing overlay!");
    showFolderOverlay(docId);
    return true;
  }

  function showFolderOverlay(docId) {
    // Remove any existing overlay
    const existing = document.getElementById("oxt-folder-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "oxt-folder-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #fff; border-radius: 8px; padding: 24px 28px;
      min-width: 340px; max-width: 420px; box-shadow: 0 8px 32px rgba(0,0,0,0.25);
    `;

    const title = document.createElement("h3");
    title.textContent = "Set up folder structure";
    title.style.cssText = "margin: 0 0 16px 0; font-size: 16px; color: #1a1a1a;";
    card.appendChild(title);

    const checkboxes = [];
    for (const name of FOLDER_NAMES) {
      const label = document.createElement("label");
      label.style.cssText = "display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 14px; color: #333; cursor: pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = name;
      cb.style.cssText = "width: 16px; height: 16px; cursor: pointer;";
      label.appendChild(cb);
      label.appendChild(document.createTextNode(name));
      card.appendChild(label);
      checkboxes.push(cb);
    }

    const progressText = document.createElement("div");
    progressText.id = "oxt-folder-progress";
    progressText.style.cssText = "margin: 12px 0; font-size: 13px; color: #666; min-height: 20px;";
    card.appendChild(progressText);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end;";

    const skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    skipBtn.style.cssText = `
      padding: 8px 18px; border: 1px solid #ccc; border-radius: 4px;
      background: #fff; color: #555; font-size: 14px; cursor: pointer;
    `;
    skipBtn.addEventListener("click", async () => {
      // Save docId to offered list
      const stored = await chrome.storage.local.get("folderCreationOffered");
      const offered = stored.folderCreationOffered || [];
      if (!offered.includes(docId)) offered.push(docId);
      await chrome.storage.local.set({ folderCreationOffered: offered });
      overlay.remove();
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = "Create Folders";
    createBtn.style.cssText = `
      padding: 8px 18px; border: none; border-radius: 4px;
      background: #2563eb; color: #fff; font-size: 14px; cursor: pointer;
      font-weight: 500;
    `;
    createBtn.addEventListener("click", () => {
      const selected = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
      if (selected.length === 0) {
        progressText.textContent = "Select at least one folder.";
        progressText.style.color = "#dc2626";
        return;
      }
      // Remove the full overlay so CDP can reach the tab bar
      overlay.remove();
      _folderCreationInProgress = true;
      // Show a small non-blocking toast for progress
      showProgressToast("Starting folder creation...");

      chrome.runtime.sendMessage({ type: "create-folders", folders: selected });
    });

    btnRow.appendChild(skipBtn);
    btnRow.appendChild(createBtn);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function showProgressToast(text) {
    let toast = document.getElementById("oxt-folder-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "oxt-folder-toast";
      toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: #1e293b; color: #fff; padding: 10px 20px; border-radius: 6px;
        font-size: 13px; z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        pointer-events: none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    return toast;
  }

  function removeProgressToast() {
    const toast = document.getElementById("oxt-folder-toast");
    if (toast) toast.remove();
  }

  function removeFolderOverlay() {
    const overlay = document.getElementById("oxt-folder-overlay");
    if (overlay) overlay.remove();
    removeProgressToast();
  }

  // ---------------------------------------------------------------------------
  // CDP automation overlay — shown while debugger is attached
  // ---------------------------------------------------------------------------

  function showCdpOverlay() {
    if (document.getElementById("oxt-cdp-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "oxt-cdp-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.35); z-index: 999998;
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    `;
    const card = document.createElement("div");
    card.style.cssText = `
      background: #1e293b; color: #fff; padding: 20px 32px;
      border-radius: 10px; text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    card.innerHTML = `
      <div style="font-size:16px;font-weight:600;margin-bottom:8px;">Onshape Assistant is running</div>
      <div style="font-size:13px;color:#94a3b8;">Please do not use the mouse or keyboard.</div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function removeCdpOverlay() {
    const overlay = document.getElementById("oxt-cdp-overlay");
    if (overlay) overlay.remove();
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

    } else if (msg.type === "folder-creation-progress") {
      if (msg.status === "moving") {
        showProgressToast(`Moving "${msg.name}" to folder...`);
      } else {
        showProgressToast(`Creating folder ${msg.index}/${msg.total}: ${msg.name}...`);
      }

    } else if (msg.type === "tab-sort-progress") {
      showProgressToast(`Sorting: moving "${msg.name}"...`);

    } else if (msg.type === "tab-sort-done") {
      if (msg.sorted > 0) {
        showProgressToast(`Sorted ${msg.sorted} tab(s) into folders`);
        setTimeout(removeProgressToast, 3000);
      } else {
        removeProgressToast();
      }
      // Single scan after sort completes — this is the only scan when folders exist
      console.log("[Scanner] Sort done, running scan");
      setTimeout(async () => {
        const result = await scanTabFolders();
        if (result) {
          maybeOfferFolderCreation(result);
          sendScanResult(result);
        }
      }, 1000);

    } else if (msg.type === "interference-progress") {
      showProgressToast(msg.message);

    } else if (msg.type === "interference-done") {
      const results = msg.results || {};
      if (results.totalInterferences > 0) {
        const toast = showProgressToast(`${results.totalInterferences} interference(s) detected`);
        toast.style.background = "#7c4a00";
        setTimeout(removeProgressToast, 5000);
      } else if (!results.error) {
        showProgressToast("No interferences found");
        setTimeout(removeProgressToast, 3000);
      } else {
        removeProgressToast();
      }

    } else if (msg.type === "folder-creation-done") {
      _folderCreationInProgress = false;
      if (msg.success) {
        showProgressToast("All folders created!");
        // Save docId to offered list so overlay doesn't reappear
        const docId = getDocIdFromUrl();
        if (docId) {
          chrome.storage.local.get("folderCreationOffered", (stored) => {
            const offered = stored.folderCreationOffered || [];
            if (!offered.includes(docId)) offered.push(docId);
            chrome.storage.local.set({ folderCreationOffered: offered });
          });
        }
        setTimeout(removeProgressToast, 3000);
      } else {
        const toast = showProgressToast(`Error: ${msg.error || "Unknown error"}`);
        toast.style.background = "#dc2626";
        setTimeout(removeProgressToast, 5000);
      }

    } else if (msg.type === "setup-new-doc-progress") {
      showProgressToast(msg.message);

    } else if (msg.type === "setup-new-doc-done") {
      if (msg.success) {
        if (msg.protectionSkipped) {
          // Already protected, no toast needed
        } else {
          showProgressToast("Workspace protection enabled");
          setTimeout(removeProgressToast, 4000);
        }
      } else {
        const toast = showProgressToast(`Protection error: ${msg.error || "Unknown"}`);
        toast.style.background = "#dc2626";
        setTimeout(removeProgressToast, 5000);
      }

    } else if (msg.type === "remove-progress-toast") {
      removeProgressToast();

    } else if (msg.type === "cdp-overlay-show") {
      showCdpOverlay();

    } else if (msg.type === "cdp-overlay-hide") {
      removeCdpOverlay();
    }
  });

  // ---------------------------------------------------------------------------
  // Auto-scan on page load (every Onshape doc)
  // ---------------------------------------------------------------------------

  // Small delay to let Onshape fully initialize
  let _lastDocId = null;
  let _scanTimer = null;
  let _violationsTimer = null;

  function runOnDocLoad() {
    const docId = getDocIdFromUrl();
    if (!docId || docId === _lastDocId) return;
    _lastDocId = docId;
    console.log("[Scanner] Doc detected:", docId);

    // Cancel any pending timers from a previous doc
    if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
    if (_violationsTimer) { clearTimeout(_violationsTimer); _violationsTimer = null; }

    _scanTimer = setTimeout(() => { _scanTimer = null; autoScan(); }, 8000);

    // Check violations (versions, parts, features, tabs) for release tracker
    _violationsTimer = setTimeout(() => {
      _violationsTimer = null;
      // Re-read from URL in case doc changed during the delay
      const currentDocId = getDocIdFromUrl();
      if (currentDocId !== docId) {
        console.log("[Scanner] Doc changed during delay, skipping violations for", docId);
        return;
      }
      const wid = getWidFromUrl();
      const docName = getDocName();
      if (docId) {
        chrome.runtime.sendMessage({ type: "check-versions", docId, docName, wid });
      }
    }, 8000);
  }

  // Initial page load
  runOnDocLoad();

  // SPA navigation: background.js sends "spa-navigated" when URL changes
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "spa-navigated") {
      console.log("[Scanner] SPA navigation (tabs.onUpdated):", msg.url);
      removeFolderOverlay();
      runOnDocLoad();
    }
  });

  // Fallback: poll URL every 2s in case tabs.onUpdated doesn't fire
  setInterval(() => {
    const docId = getDocIdFromUrl();
    if (docId && docId !== _lastDocId) {
      console.log("[Scanner] URL poll detected new doc:", docId);
      removeFolderOverlay();
      runOnDocLoad();
    }
  }, 2000);

  // ---------------------------------------------------------------------------
  // Export Drawing detection
  // ---------------------------------------------------------------------------
  // Watches for the "Export Drawing" modal dialog to appear.
  // Fires when the user right-clicks a drawing tab and clicks "Export...".
  // Selectors from observer data:
  //   Modal:  div.modal.fade.show
  //   Form:   form.export-dxf-or-dwg-dialog
  //   Title:  span.title-description  (text: "Export Drawing")
  //   Format: select inside form (options: PDF, DWG, DXF, etc.)
  //   Filename: #drawing-export-filename-input

  let _exportDetected = false;

  const exportObserver = new MutationObserver((mutations) => {
    if (_exportDetected) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // The modal wrapper has class "modal fade" and contains the export form
        const form = node.querySelector
          ? node.querySelector("form.export-dxf-or-dwg-dialog")
          : null;
        if (!form) continue;

        _exportDetected = true;
        const filenameInput = form.querySelector("#drawing-export-filename-input");
        const formatSelect = form.querySelector("select");
        const filename = filenameInput ? filenameInput.value : "";
        const format = formatSelect
          ? formatSelect.options[formatSelect.selectedIndex]?.label || ""
          : "";

        console.log(`[ExportDetect] Export Drawing dialog opened: "${filename}" as ${format}`);

        const docId = getDocIdFromUrl();

        // Ask background.js to check releases, then show banner if none
        chrome.runtime.sendMessage({
          type: "check-releases",
          docId: docId,
        }, (response) => {
          if (response && response.hasReleases) {
            console.log(`[ExportDetect] Doc has ${response.count} release(s), no banner needed`);
            return;
          }
          console.log("[ExportDetect] No releases found, blocking export");
          const modalContent = form.closest(".modal-content");
          if (modalContent) {
            // Show warning banner
            const banner = document.createElement("div");
            banner.id = "oxt-release-reminder";
            banner.style.cssText = `
              background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
              padding: 10px 14px; margin: 0 16px 12px 16px; font-size: 13px;
              color: #92400e; font-weight: 500;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            banner.textContent = "Please create a release before sending for manufacturing.";
            const modalBody = modalContent.querySelector(".modal-body, .me-4");
            if (modalBody) {
              modalBody.parentNode.insertBefore(banner, modalBody);
            } else {
              modalContent.insertBefore(banner, modalContent.children[1] || null);
            }

            // Disable the Export/OK submit button
            const buttons = form.querySelectorAll("button");
            for (const btn of buttons) {
              const text = btn.textContent.trim().toLowerCase();
              if (text === "export" || text === "ok" || btn.type === "submit") {
                btn.disabled = true;
                btn.title = "Release required before export";
                btn.style.opacity = "0.4";
                btn.style.cursor = "not-allowed";
                console.log(`[ExportDetect] Disabled button: "${btn.textContent.trim()}"`);
              }
            }
            // Also block form submission directly
            form.addEventListener("submit", function blockSubmit(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              console.log("[ExportDetect] Form submit blocked");
            }, true);
          }
        });

        // Reset flag when modal is removed
        const modalEl = node.closest ? node : node.parentElement;
        const removeObserver = new MutationObserver(() => {
          if (!document.querySelector("form.export-dxf-or-dwg-dialog")) {
            _exportDetected = false;
            removeObserver.disconnect();
            console.log("[ExportDetect] Export dialog closed");
          }
        });
        removeObserver.observe(document.body, { childList: true, subtree: true });
        return;
      }
    }
  });

  exportObserver.observe(document.body, { childList: true, subtree: true });
})();
