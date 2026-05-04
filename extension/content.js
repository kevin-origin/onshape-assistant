// content.js — Onshape Tab Folder Scanner
// Injected into Onshape document pages. Reads the tab bar DOM by clicking
// through folders and reporting the structure back to background.js.

(function () {
  "use strict";

  const CLICK_DELAY = 500;   // ms after clicking a folder before reading children
  const ROOT_DELAY  = 500;   // ms after clicking "All tabs" breadcrumb
  const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];
  const EXCLUDED_DOC_NAMES = ["OTS Parts"];  // shared library docs — skip scanning/sorting
  let _scanning = false;     // lock to prevent concurrent scans
  let _folderCreationInProgress = false; // suppress scans during folder creation
  // let _unpackInProgress = false; // suppress scans during folder unpacking

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

  function getEidFromUrl() {
    const m = window.location.pathname.match(/\/e\/([a-f0-9]+)/);
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

  function waitForEl(selector, callback) {
    const el = document.querySelector(selector);
    if (el) { callback(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); callback(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
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
        text: r.text, isFolder: r.isFolder, tabType: r.tabType, iconSrc: r.iconSrc,
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
  // Toolbar visibility — hide toolbar when active Part Studio has >= 250 features
  // ---------------------------------------------------------------------------

  let _toolbarStyleEl = null;
  // Tracks Part Studio eids already notified about high feature count this session
  const _featureCountNotifiedEids = new Set();

  function setToolbarHidden(hide) {
    if (!_toolbarStyleEl) {
      _toolbarStyleEl = document.createElement('style');
      _toolbarStyleEl.id = 'oxt-toolbar-hide';
      document.head.appendChild(_toolbarStyleEl);
    }
    _toolbarStyleEl.textContent = hide
      ? '.os-element-toolbar { display: none !important; }'
      : '';
  }

  async function maybeHideToolbar() {
    const docId = getDocIdFromUrl();
    const wid   = getWidFromUrl();
    const parts = location.pathname.split('/');
    const eIdx  = parts.indexOf('e');
    const eid   = eIdx !== -1 ? parts[eIdx + 1] : null;
    if (!docId || !wid || !eid) { setToolbarHidden(false); return; }

    const { count } = await chrome.runtime.sendMessage(
      { type: 'get-feature-count', docId, wid, eid }
    ).catch(() => ({ count: 0 }));

    setToolbarHidden(count >= 250);

    // Onshape API excludes the 4 default features (planes + origin) from the count,
    // so 196 API-returned features = 200 visible features in the Part Studio.
    if (count >= 196 && count < 246 && !_featureCountNotifiedEids.has(eid)) {
      _featureCountNotifiedEids.add(eid);
      chrome.runtime.sendMessage({
        type: "feature-count-notify",
        docId,
        docName: getDocName(),
        eid,
        count,
      });
    }
  }

  const _setupTriggeredDocs = new Set();

  async function maybeSetupDoc() {
    const docId = getDocIdFromUrl();
    const wid   = getWidFromUrl();
    if (!docId || !wid) return;
    const resp = await chrome.runtime.sendMessage({ type: 'check-and-setup-doc', docId, wid }).catch(() => null);
    if (resp?.triggered) _setupTriggeredDocs.add(docId);
  }

  // ---------------------------------------------------------------------------
  // Auto-scan logic — runs on every Onshape doc open
  // ---------------------------------------------------------------------------

  async function autoScan() {
    if (_folderCreationInProgress) {
      console.log("[Scanner] autoScan skipped: folder creation in progress");
      return;
    }
    // if (_unpackInProgress) {
    //   console.log("[Scanner] autoScan skipped: folder unpack in progress");
    //   return;
    // }
    const docId = getDocIdFromUrl();
    if (!docId) { console.log("[Scanner] autoScan: no docId"); return; }

    // Skip excluded docs (shared libraries that shouldn't be scanned/sorted)
    const docName = getDocName();
    if (EXCLUDED_DOC_NAMES.includes(docName)) {
      console.log(`[Scanner] autoScan skipped: "${docName}" is in EXCLUDED_DOC_NAMES`);
      return;
    }

    console.log("[Scanner] autoScan starting for", docId);

    // Wait for tab bar to be ready
    await waitForTabBar();
    console.log("[Scanner] Tab bar ready");

    // Scan immediately — tab sorting is manual only (Sort Tabs button in Folder Generator)
    const result = await scanTabFolders();
    if (!result) return;
    const overlayShown = await maybeOfferFolderCreation(result);
    // Store scan data for popup, but skip Chrome notification if overlay is showing
    // (the overlay IS the notification — user is already being prompted)
    sendScanResult(result, overlayShown);

  }

  let _notifyTimer = null;
  // Tracks which docs already triggered a Chrome notification this session.
  // Prevents spamming the same notification every poll cycle (10 min).
  // Cleared on SPA navigation (new doc = fresh tracking).
  let _notifiedDocIds = new Set();

  function sendScanResult(result, skipNotification) {
    chrome.runtime.sendMessage({ type: "tab-folder-result", data: result });

    if (_notifyTimer) { clearTimeout(_notifyTimer); _notifyTimer = null; }

    // Skip Chrome notification if folder overlay is showing (user is already prompted)
    if (skipNotification) {
      console.log("[Scanner] Notification skipped — folder creation overlay is showing");
      return;
    }

    const folderData = result.folders || {};
    const folders = Object.keys(folderData);
    const rootTabs = result.root_tabs || [];

    // // Auto-unpack illegal folders (names not in ALLOWED_FOLDERS)
    const illegalFolders = folders.filter(f => !ALLOWED_FOLDERS.includes(f));
    // if (illegalFolders.length > 0 && !_unpackInProgress) {
    //   console.log("[Unpack] Found illegal folders:", illegalFolders);
    //   _unpackInProgress = true;
    //   showProgressToast("Unpacking illegal folders...");
    //   if (HAS_DEBUGGER) {
    //     chrome.runtime.sendMessage({ type: "unpack-illegal-folders", folders: illegalFolders });
    //   }
    //   return; // sort + re-scan will happen after unpack completes
    // }

    const illegal = [
      ...illegalFolders,
      ...rootTabs,
    ];
    const multiAssembly = Object.entries(folderData).some(
      ([, data]) => typeof data === "object" && data.assemblies > 1
    );
    if (illegal.length > 0 || multiAssembly || folders.length === 0) {
      // Only send Chrome notification once per doc (avoid spamming every 30s poll)
      if (_notifiedDocIds.has(result.doc_id)) return;

      _notifyTimer = setTimeout(() => {
        _notifyTimer = null;
        // Re-check: if folder creation happened during the delay, skip notification
        if (_folderCreationInProgress) return;
        // Re-read tabs to see if folders now exist (sorter may have run)
        const currentTabs = getTabNames();
        const nowHasFolders = currentTabs.some(t => t.isFolder);
        const nowHasRootTabs = currentTabs.filter(t => !t.isFolder).length > 0;
        if (nowHasFolders && !nowHasRootTabs) {
          console.log("[Scanner] Notification suppressed — folders exist and no root tabs after sort");
          return;
        }
        _notifiedDocIds.add(result.doc_id);
        chrome.runtime.sendMessage({
          type: "folder-scan-notify",
          docId: result.doc_id,
          docName: result.doc_name,
        });
      }, 10000);
    } else {
      // Issues resolved — allow re-notification if problems come back
      _notifiedDocIds.delete(result.doc_id);
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

  // Show folder creation overlay on any document without folders.
  // Guards: doc must have 0 folders, auto-setup not triggered this session,
  // and overlay must not have been shown in the last 24 hours.
  async function maybeOfferFolderCreation(scanResult) {
    const docId = scanResult.doc_id;
    if (!docId) { console.log("[FolderSetup] No docId"); return false; }

    const folders = Object.keys(scanResult.folders || {});
    console.log(`[FolderSetup] docId=${docId}, folders=${folders.length}`);

    if (folders.length > 0) { console.log("[FolderSetup] Skipped: has folders"); return false; }

    // Don't show overlay if auto-setup was triggered this session
    if (_setupTriggeredDocs.has(docId)) { console.log("[FolderSetup] Skipped: auto-setup triggered"); return false; }

    // 24-hour throttle: skip if overlay was shown within the last 24 hours
    const stored = await new Promise(resolve => chrome.storage.local.get("folderOverlayLastShown", resolve));
    const lastShown = stored.folderOverlayLastShown || 0;
    if (Date.now() - lastShown < 86400000) {
      console.log("[FolderSetup] Skipped: shown within last 24 hours");
      return false;
    }

    console.log("[FolderSetup] Showing overlay!");
    showFolderOverlay(docId);
    return true;
  }

  function showFolderOverlay(docId, existingFolders) {
    existingFolders = existingFolders || [];
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
      background: #1a1a2e; border-radius: 8px; padding: 24px 28px;
      min-width: 340px; max-width: 420px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      border: 1px solid #333;
    `;

    const title = document.createElement("h3");
    title.textContent = "Set up folder structure";
    title.style.cssText = "margin: 0 0 16px 0; font-size: 16px; color: #e0e0e0;";
    card.appendChild(title);

    // If all folders already exist, show a message and Close button only
    const allExist = FOLDER_NAMES.every(n => existingFolders.includes(n));
    if (allExist) {
      const msg = document.createElement("div");
      msg.textContent = "All folders already exist.";
      msg.style.cssText = "font-size: 14px; color: #95d5b2; margin: 16px 0;";
      card.appendChild(msg);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "Close";
      closeBtn.style.cssText = `
        padding: 8px 18px; border: 1px solid #444; border-radius: 4px;
        background: #16213e; color: #aaa; font-size: 14px; cursor: pointer;
        margin-top: 8px;
      `;
      closeBtn.addEventListener("click", () => overlay.remove());
      card.appendChild(closeBtn);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      return;
    }

    const checkboxes = [];
    for (const name of FOLDER_NAMES) {
      const alreadyExists = existingFolders.includes(name);
      const label = document.createElement("label");
      label.style.cssText = `display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 14px; color: ${alreadyExists ? "#666" : "#e0e0e0"}; cursor: ${alreadyExists ? "default" : "pointer"};`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = name;
      cb.style.cssText = "width: 16px; height: 16px; cursor: pointer; accent-color: #7ec8e3;";
      if (alreadyExists) {
        cb.disabled = true;
        cb.style.cursor = "default";
      }
      label.appendChild(cb);
      label.appendChild(document.createTextNode(name + (alreadyExists ? " (already exists)" : "")));
      card.appendChild(label);
      checkboxes.push(cb);
    }

    const progressText = document.createElement("div");
    progressText.id = "oxt-folder-progress";
    progressText.style.cssText = "margin: 12px 0; font-size: 13px; color: #888; min-height: 20px;";
    card.appendChild(progressText);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end;";

    const skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    skipBtn.style.cssText = `
      padding: 8px 18px; border: 1px solid #444; border-radius: 4px;
      background: #16213e; color: #aaa; font-size: 14px; cursor: pointer;
    `;
    skipBtn.addEventListener("click", () => {
      chrome.storage.local.set({ folderOverlayLastShown: Date.now() });
      overlay.remove();
    });

    const createBtn = document.createElement("button");
    createBtn.textContent = "Create Folders";
    createBtn.style.cssText = `
      padding: 8px 18px; border: none; border-radius: 4px;
      background: #1b4332; color: #95d5b2; font-size: 14px; cursor: pointer;
      font-weight: 500;
    `;
    createBtn.addEventListener("click", () => {
      // Only include enabled (non-existing) checked folders
      const selected = checkboxes.filter(cb => cb.checked && !cb.disabled).map(cb => cb.value);
      if (selected.length === 0) {
        progressText.textContent = "Select at least one folder.";
        progressText.style.color = "#dc2626";
        return;
      }
      chrome.storage.local.set({ folderOverlayLastShown: Date.now() });
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

  // Visual-only overlay — actual input blocking is done via CDP
  // Input.setIgnoreInputEvents in background.js (browser-level block).
  // Content script listeners can't block main-world events (isolated world).
  function showCdpOverlay() {
    if (document.getElementById("oxt-cdp-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "oxt-cdp-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.35); z-index: 999998;
      display: flex; align-items: center; justify-content: center;
      pointer-events: auto;
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

    } else if (msg.type === "show-merge-owner-popup") {
      const docId = getDocIdFromUrl();
      if (docId) {
        (async () => {
          const [userResp, teamResp, permsResp] = await Promise.all([
            new Promise(resolve => chrome.runtime.sendMessage({ type: "get-session-user" }, resolve)),
            new Promise(resolve => chrome.runtime.sendMessage({ type: "get-team-members" }, resolve)),
            new Promise(resolve => chrome.runtime.sendMessage({ type: "get-merge-perms", docId }, resolve)),
          ]);
          if (!userResp || userResp.error) { sendResponse({ error: "No session user" }); return; }
          const members = teamResp?.members || [];
          if (members.length === 0) { sendResponse({ error: "No team members" }); return; }

          // If owners already set for this doc, only existing owners can edit
          const perms = (permsResp && permsResp.exists) ? permsResp.data : null;
          if (perms && Array.isArray(perms.owners) && perms.owners.length > 0) {
            const isOwner = perms.owners.some(o => o.id === userResp.id || o.email === userResp.email);
            if (!isOwner) {
              showProgressToast("Only current merge owners can change permissions");
              setTimeout(removeProgressToast, 3000);
              sendResponse({ error: "Not a merge owner" });
              return;
            }
          }

          const docName = getDocName();
          let currentOwners = (perms && Array.isArray(perms.owners)) ? perms.owners : [];

          // Auto-suggest: pre-select the session user when no owner is set yet.
          if (currentOwners.length === 0) {
            const self = members.find(m => m.id === userResp.id || m.email === userResp.email);
            if (self) currentOwners = [self];
          }

          showMergeOwnerOverlay(docId, docName, userResp, members, currentOwners);
          sendResponse({ ok: true });
        })();
        return true;
      }

    } else if (msg.type === "unpack-progress") {
      /* unpack disabled
      showProgressToast(`Unpacking folder: "${msg.name}"...`);
      */

    } else if (msg.type === "unpack-done") {
      /* unpack disabled
      _unpackInProgress = false;
      if (msg.error) {
        const toast = showProgressToast(`Unpack error: ${msg.error}`);
        toast.style.background = "#dc2626";
        setTimeout(removeProgressToast, 5000);
      } else {
        showProgressToast(`Unpacked ${msg.count} folder(s), sorting...`);
        setTimeout(removeProgressToast, 3000);
        // sort-tabs + re-scan happen automatically from background.js
      }
      */

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

    } else if (msg.type === "generate-folders") {
      // Triggered from popup "Generate Folders" button
      (async () => {
        await waitForTabBar();
        const result = await scanTabFolders();
        const docId = getDocIdFromUrl();
        if (!docId) { sendResponse({ error: "Not an Onshape document" }); return; }
        const existingFolders = result ? Object.keys(result.folders || {}).filter(f => FOLDER_NAMES.includes(f)) : [];
        showFolderOverlay(docId, existingFolders);
        sendResponse({ ok: true });
      })();
      return true;

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
  // Scan lifecycle: on each new doc, wait 8s (let Onshape SPA init), then:
  //   1. autoScan() — reads tab bar DOM, triggers sort if folders exist
  //   2. Poll every 10 min to catch changes made during the session.
  // Timers are cleared and re-created on SPA navigation (doc switch).
  let _lastDocId = null;
  let _scanTimer = null;
  let _pollInterval = null;
  const POLL_INTERVAL_MS = 600000; // 10 min
  let _killSwitchActive = false; // set true if background says extension is disabled

  // ---------------------------------------------------------------------------
  // Assembly guard — write oxtAssemblyCount to DOM dataset so content-main.js
  // (MAIN world) can read it without an extra API call
  // ---------------------------------------------------------------------------
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local' || !changes.docScanResults) return;
    const docId = getDocIdFromUrl();
    if (!docId) return;
    const docResult = (changes.docScanResults.newValue || {})[docId];
    if (!docResult) return;
    const count = typeof docResult.totalAssemblies === 'number' ? docResult.totalAssemblies : 0;
    document.documentElement.dataset.oxtAssemblyCount = String(count);
    console.log('[AssemblyGuard] Storage updated, totalAssemblies=' + count);
  });

  function runOnDocLoad() {
    // Pre-populate oxtAssemblyCount from cached scan so content-main.js guard
    // has a value before any new scan completes
    chrome.storage.local.get('docScanResults', function(data) {
      const docId = getDocIdFromUrl();
      if (!docId) return;
      const docResult = (data.docScanResults || {})[docId];
      if (!docResult) return;
      const count = typeof docResult.totalAssemblies === 'number' ? docResult.totalAssemblies : 0;
      document.documentElement.dataset.oxtAssemblyCount = String(count);
    });
    if (_killSwitchActive) return;
    const docId = getDocIdFromUrl();
    if (!docId || docId === _lastDocId) return;
    _lastDocId = docId;
    console.log("[Scanner] Doc detected:", docId);

    // Cancel any pending timers/intervals from a previous doc
    if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
    if (_notifyTimer) { clearTimeout(_notifyTimer); _notifyTimer = null; }
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }

    _scanTimer = setTimeout(() => { _scanTimer = null; autoScan(); }, 8000);

    // Fetch tab count for insert-tab limit guard (independent of violation checker)
    const _tabCountDocId = docId;
    setTimeout(() => {
      if (getDocIdFromUrl() !== _tabCountDocId) return;
      const wid = getWidFromUrl();
      if (!wid) return;
      chrome.runtime.sendMessage({ type: "get-tab-count", docId: _tabCountDocId, wid }, (resp) => {
        if (resp && typeof resp.count === "number") {
          document.documentElement.dataset.oxtTabCount = String(resp.count);
          applyTabLimitGuard();
          console.log("[InsertTabGuard] Tab count fetched:", resp.count);
        }
      });
    }, 2000);

    // Start continuous polling after the initial scan finishes (8s + small buffer)
    _pollInterval = setInterval(() => {
      const currentDocId = getDocIdFromUrl();
      if (currentDocId !== docId) return; // doc changed, next runOnDocLoad will reset
      if (_scanning || _folderCreationInProgress) return; // skip if busy
      console.log("[Poll] Running periodic scan for", docId);
      autoScan();
    }, POLL_INTERVAL_MS);
  }

  // Check kill switch before doing anything — if background says disabled, bail out entirely
  chrome.runtime.sendMessage({ type: "check-kill-switch" }, async (resp) => {
    if (resp?.disabled) {
      _killSwitchActive = true;
      console.log("[Scanner] Kill switch active — content script disabled");
      return;
    }
    // Wait for setup check before scanning — prevents folder overlay from showing on new docs
    await maybeSetupDoc();
    runOnDocLoad();
    maybeHideToolbar();
  });

  // SPA navigation: background.js sends "spa-navigated" when URL changes
  chrome.runtime.onMessage.addListener(async (msg) => {
    if (_killSwitchActive) return;
    if (msg.type === "spa-navigated") {
      console.log("[Scanner] SPA navigation (tabs.onUpdated):", msg.url);
      _notifiedDocIds.clear(); // reset notification tracking for new doc
      removeFolderOverlay();
      await maybeSetupDoc();
      runOnDocLoad();
      maybeHideToolbar();
    }
  });

  // Fallback: poll URL every 2s in case tabs.onUpdated doesn't fire
  setInterval(() => {
    if (_killSwitchActive) return;
    const docId = getDocIdFromUrl();
    if (docId && docId !== _lastDocId) {
      console.log("[Scanner] URL poll detected new doc:", docId);
      removeFolderOverlay();
      runOnDocLoad();
    }
  }, 2000);

  // ---------------------------------------------------------------------------
  // Export Drawing detection — blocks export when no releases exist
  // ---------------------------------------------------------------------------
  // MutationObserver watches for Onshape's export modal (added dynamically).
  // Selectors discovered via observe-dom-changes + manual right-click → Export:
  //   Form:   form.export-dxf-or-dwg-dialog
  //   Filename: #drawing-export-filename-input
  // On detection: checks releases (API). If blocked: disables submit button.

  let _exportDetected = false;

  const exportObserver = new MutationObserver((mutations) => {
    if (_exportDetected || _killSwitchActive) return;
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

        const releaseCheck = new Promise(resolve =>
          chrome.runtime.sendMessage({ type: "check-releases", docId }, resolve)
        );

        releaseCheck.then((releaseResp) => {
          const noReleases = !releaseResp || !releaseResp.hasReleases;
          const staleRevision = !noReleases && !!releaseResp?.staleRevision;
          const shouldBlock = noReleases || staleRevision;

          if (!shouldBlock) {
            console.log(`[ExportDetect] Doc has ${releaseResp?.count || 0} release(s), up to date — export allowed`);
            return;
          }

          const modalContent = form.closest(".modal-content");
          if (!modalContent) return;
          const modalBody = modalContent.querySelector(".modal-body, .me-4");

          const bannerStyle = `
            background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
            padding: 10px 14px; margin: 0 16px 12px 16px; font-size: 13px;
            color: #92400e; font-weight: 500;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          `;

          // Banner 1: No releases
          if (noReleases) {
            console.log("[ExportDetect] No releases found, showing release banner");
            const banner = document.createElement("div");
            banner.id = "oxt-release-reminder";
            banner.style.cssText = bannerStyle;
            banner.textContent = "Please create a release before sending for manufacturing.";
            if (modalBody) {
              modalBody.parentNode.insertBefore(banner, modalBody);
            } else {
              modalContent.insertBefore(banner, modalContent.children[1] || null);
            }
          }

          // Banner 2: Changes since last release
          if (staleRevision) {
            console.log("[ExportDetect] Doc modified after last release — showing stale banner");
            const banner = document.createElement("div");
            banner.id = "oxt-stale-revision";
            banner.style.cssText = bannerStyle;
            banner.textContent = "Changes have been made since the last release. Please create a new release before exporting.";
            const anchor = modalContent.querySelector("#oxt-release-reminder");
            if (anchor && anchor.nextSibling) {
              anchor.parentNode.insertBefore(banner, anchor.nextSibling);
            } else if (modalBody) {
              modalBody.parentNode.insertBefore(banner, modalBody);
            } else {
              modalContent.insertBefore(banner, modalContent.children[1] || null);
            }
          }

          // Disable the Export/OK submit button
          const buttons = form.querySelectorAll("button");
          const btnTitle = noReleases
            ? "Release required before export"
            : "Create a new release to cover recent changes";
          for (const btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            if (text === "export" || text === "ok" || btn.type === "submit") {
              btn.disabled = true;
              btn.title = btnTitle;
              btn.style.opacity = "0.4";
              btn.style.cursor = "not-allowed";
              console.log(`[ExportDetect] Disabled button: "${btn.textContent.trim()}"`);
            }
          }
          // Block form submission directly
          form.addEventListener("submit", function blockSubmit(e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            console.log("[ExportDetect] Form submit blocked");
          }, true);
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

  // ---------------------------------------------------------------------------
  // Merge dialog blocker — blocks non-owners from merging INTO the main branch
  // ---------------------------------------------------------------------------
  // Selector confirmed via live DOM: div.modal.selective-preview-dialog.show
  // Header: h4.selective-preview-dialog-title — "Merging changes into <span.branch-1> from <span.branch-0>"
  // Target branch (INTO): span.branch-1[data-bs-original-title] in .modal-header
  // Merge button: button.submit-button (type=submit) — Cancel/X left enabled.
  // Only blocks when target branch name matches the main workspace (canDelete===false).
  // applyMergeBlock retries until Angular renders .modal-body and button.submit-button.

  function applyMergeBlock(modal, ownerName, attempts) {
    attempts = attempts || 0;
    const modalBody = modal.querySelector(".modal-body");
    const mergeBtn = modal.querySelector("button.submit-button");
    if (!modalBody || !mergeBtn) {
      if (attempts < 20) setTimeout(() => applyMergeBlock(modal, ownerName, attempts + 1), 50);
      return;
    }

    const banner = document.createElement("div");
    banner.id = "oxt-merge-blocker";
    banner.style.cssText = `
      background: #533a0f; border: 1px solid #f59e0b; border-radius: 4px;
      padding: 10px 14px; margin: 10px 16px; font-size: 13px;
      color: #f0c040; font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    const ownerStr = ownerName ? ` Contact ${ownerName}.` : " Contact the document owner.";
    banner.textContent = "You do not have permission to merge into the main branch." + ownerStr;
    modalBody.parentNode.insertBefore(banner, modalBody);

    mergeBtn.disabled = true;
    mergeBtn.style.opacity = "0.4";
    mergeBtn.style.cursor = "not-allowed";
    mergeBtn.title = "Merge to main not allowed — contact document owner";
    console.log(`[MergeBlock] Blocked after ${attempts} retries`);

    const form = modal.querySelector("form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        console.log("[MergeBlock] Form submit blocked");
      }, true);
    }
  }

  // Waits for first span.workspace-name in h4 (always the "into"/target branch) and
  // main workspace name, then checks permissions.
  // branch-0/branch-1 classes reflect workspace identity, not merge direction —
  // the first span.workspace-name in the h4 is always the INTO/target branch.
  // Retries up to 20x at 50ms intervals (Angular renders header async).
  function checkMergeTarget(modal, docId, attempts) {
    attempts = attempts || 0;
    const targetEl = modal.querySelector(".modal-header h4 span.workspace-name");
    if (!targetEl) {
      if (attempts < 20) setTimeout(() => checkMergeTarget(modal, docId, attempts + 1), 50);
      return;
    }
    const targetName = targetEl.dataset.bsOriginalTitle || targetEl.textContent.trim();
    const wid = getWidFromUrl() || "";

    chrome.runtime.sendMessage({ type: "check-main-workspace", docId, wid }, (resp) => {
      const mainName = resp && resp.mainName;
      if (!mainName || targetName !== mainName) {
        console.log(`[MergeBlock] Target "${targetName}" is not main ("${mainName}") — skip`);
        return;
      }
      console.log(`[MergeBlock] Target is main — checking permissions`);
      chrome.runtime.sendMessage({ type: "check-merge-allowed", docId }, (response) => {
        if (response && response.allowed) {
          console.log("[MergeBlock] User is allowed to merge to main");
          return;
        }
        console.log("[MergeBlock] User NOT allowed — waiting for modal content then blocking");
        chrome.runtime.sendMessage({ type: "get-doc-creator", docId }, (creatorResp) => {
          const ownerName = creatorResp && creatorResp.creator && creatorResp.creator.name;
          applyMergeBlock(modal, ownerName);
        });
      });
    });
  }

  (function initMergeBlocker() {
    let _lastModal = null;

    const observer = new MutationObserver(() => {
      if (_killSwitchActive) return;
      const modal = document.querySelector("div.modal.selective-preview-dialog.show");
      if (modal && modal !== _lastModal) {
        _lastModal = modal;
        if (!modal.dataset.oxtMergeGuarded) {
          modal.dataset.oxtMergeGuarded = "1";
          const docId = getDocIdFromUrl();
          if (!docId) return;
          checkMergeTarget(modal, docId);
        }
      } else if (!modal && _lastModal) {
        delete _lastModal.dataset.oxtMergeGuarded;
        _lastModal = null;
        console.log("[MergeBlock] Merge dialog closed");
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    console.log("[MergeBlock] Observer started");
  })();

  // ---------------------------------------------------------------------------
  // Merge owner selection overlay — triggered via popup "Set for This Doc" button
  // ---------------------------------------------------------------------------

  function showMergeOwnerOverlay(docId, docName, currentUser, members, currentOwners) {
    // Remove any existing overlay
    const existing = document.getElementById("oxt-merge-owner-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "oxt-merge-owner-overlay";
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5); z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #1a1a2e; border-radius: 8px; padding: 24px 28px;
      min-width: 360px; max-width: 440px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      border: 1px solid #333;
    `;

    const title = document.createElement("h3");
    title.textContent = "Select Merge Owners";
    title.style.cssText = "margin: 0 0 6px 0; font-size: 16px; color: #e0e0e0;";
    card.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.textContent = `Select exactly 1 merge owner for "${docName}"`;
    subtitle.style.cssText = "font-size: 12px; color: #888; margin-bottom: 16px;";
    card.appendChild(subtitle);

    // All team members as checkboxes — pre-check current owners
    const ownerIds = currentOwners.map(o => o.id || o.email);
    const checkboxes = [];
    for (const member of members) {
      const isChecked = ownerIds.includes(member.id) || ownerIds.includes(member.email);
      const row = document.createElement("label");
      row.style.cssText = "display: flex; align-items: center; gap: 8px; margin: 4px 0; padding: 6px 8px; cursor: pointer; border-radius: 4px;";
      row.addEventListener("mouseenter", () => row.style.background = "#16213e");
      row.addEventListener("mouseleave", () => row.style.background = "transparent");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isChecked;
      cb.style.cssText = "width: 16px; height: 16px; cursor: pointer; accent-color: #7ec8e3;";
      cb.dataset.email = member.email;
      cb.dataset.name = member.name;
      cb.dataset.userId = member.id;
      // Enforce max 1 selected
      cb.addEventListener("change", () => {
        if (cb.checked) {
          // Uncheck all others — only 1 allowed
          checkboxes.forEach(c => { if (c !== cb) c.checked = false; });
        }
        const checkedCount = checkboxes.filter(c => c.checked).length;
        subtitle.style.color = checkedCount === 1 ? "#95d5b2" : "#888";
      });
      row.appendChild(cb);
      const nameSpan = document.createElement("span");
      nameSpan.textContent = member.name + (member.id === currentUser.id ? " (you)" : "");
      nameSpan.style.cssText = "font-size: 14px; color: #e0e0e0;";
      row.appendChild(nameSpan);
      const emailSpan = document.createElement("span");
      emailSpan.textContent = member.email;
      emailSpan.style.cssText = "font-size: 11px; color: #666; margin-left: auto;";
      row.appendChild(emailSpan);
      card.appendChild(row);
      checkboxes.push(cb);
    }

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 10px; margin-top: 16px; justify-content: flex-end;";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    saveBtn.style.cssText = `
      padding: 8px 18px; border: none; border-radius: 4px;
      background: #1b4332; color: #95d5b2; font-size: 14px; cursor: pointer;
      font-weight: 500;
    `;
    saveBtn.addEventListener("click", () => {
      const selected = checkboxes.filter(cb => cb.checked);
      if (selected.length !== 1) {
        subtitle.textContent = "Please select exactly 1 owner.";
        subtitle.style.color = "#ff6b6b";
        return;
      }
      const owners = selected.map(cb => ({
        email: cb.dataset.email, name: cb.dataset.name, id: cb.dataset.userId,
      }));
      chrome.runtime.sendMessage({
        type: "save-merge-owners",
        docId: docId,
        docName: docName,
        owners: owners,
      }, () => {
        overlay.remove();
        showProgressToast("Merge owners saved");
        setTimeout(removeProgressToast, 3000);
      });
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
      padding: 8px 18px; border: none; border-radius: 4px;
      background: #333; color: #aaa; font-size: 14px; cursor: pointer;
      font-weight: 500;
    `;
    cancelBtn.addEventListener("click", () => overlay.remove());

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------------
  // Create dropdown guard — disable Document + Folder buttons on company homepage
  // Selector confirmed live 2026-04-29: button.create-new-document, button.create-new-folder
  // Dropdown: div.dropdown-menu.os-create-menu.create-new-type-menu.show
  // ---------------------------------------------------------------------------
  const COMPANY_NODE_ID = "6810c247e7c40668c32816a6";

  function initCreateDropdownGuard() {
    const isHomepage = () => window.location.href.includes(COMPANY_NODE_ID);

    function applyGuard(dropdown) {
      if (!isHomepage()) return;
      const docBtn = dropdown.querySelector("button.create-new-document");
      const folderBtn = dropdown.querySelector("button.create-new-folder");
      const importBtn = dropdown.querySelector("button.create-new-import");
      [docBtn, folderBtn, importBtn].forEach(btn => {
        if (!btn || btn.dataset.oxtCreateGuarded) return;
        btn.dataset.oxtCreateGuarded = "1";
        btn.style.opacity = "0.4";
        btn.style.pointerEvents = "none";
        btn.style.cursor = "not-allowed";
      });
    }

    let _lastDropdown = null;
    const observer = new MutationObserver(() => {
      const dropdown = document.querySelector(
        "div.dropdown-menu.os-create-menu.create-new-type-menu.show"
      );
      if (dropdown && dropdown !== _lastDropdown) {
        _lastDropdown = dropdown;
        applyGuard(dropdown);
      } else if (!dropdown && _lastDropdown) {
        _lastDropdown.querySelectorAll("[data-oxt-create-guarded]").forEach(btn => {
          btn.style.opacity = "";
          btn.style.pointerEvents = "";
          btn.style.cursor = "";
          delete btn.dataset.oxtCreateGuarded;
        });
        _lastDropdown = null;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  // ---------------------------------------------------------------------------
  // Version Description Enforcer — require description before creating version
  // ---------------------------------------------------------------------------

  function initVersionDescriptionEnforcer() {
    let _lastModal = null;

    const observer = new MutationObserver(() => {
      const modal = document.querySelector(
        "div.modal.version-or-workspace-dialog.show"
      );
      if (modal && modal !== _lastModal) {
        _lastModal = modal;
        delete modal.dataset.oxtVersionEnforced;
        waitForVersionForm(modal);
      } else if (!modal && _lastModal) {
        delete _lastModal.dataset.oxtVersionEnforced;
        _lastModal = null;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    console.log("[VersionDesc] Enforcer observer started");
  }

  function waitForVersionForm(modal, attempts) {
    attempts = attempts || 0;

    // Only target "Create version" dialogs, not workspace/edit dialogs
    const titleEl = modal.querySelector(".modal-title");
    if (!titleEl || !titleEl.textContent.includes("Create version")) {
      return; // not a Create Version dialog — ignore
    }

    const descField = modal.querySelector(".modal-body textarea");
    const submitBtn = modal.querySelector(".modal-footer button[type='submit']");

    if (!descField || !submitBtn) {
      if (attempts < 20) {
        setTimeout(() => waitForVersionForm(modal, attempts + 1), 50);
      }
      return;
    }

    if (modal.dataset.oxtVersionEnforced) return;
    modal.dataset.oxtVersionEnforced = "1";
    attachVersionDescriptionGuard(modal, descField, submitBtn);
  }

  function attachVersionDescriptionGuard(modal, descField, submitBtn) {
    let warningEl = null;

    // Dim the button initially since description starts empty
    function updateButtonState() {
      const hasDesc = !!descField.value.trim();
      submitBtn.style.opacity = hasDesc ? "" : "0.4";
      submitBtn.style.pointerEvents = hasDesc ? "" : "";
      // Keep pointer events so clicking still shows the warning
    }
    updateButtonState();

    function showWarning() {
      if (warningEl) return;
      warningEl = document.createElement("div");
      warningEl.textContent =
        "Please fill in the description with all changes made since the previous version.";
      warningEl.style.cssText =
        "color: #e74c3c; font-size: 13px; margin-top: 6px; font-weight: 500;";
      descField.parentElement.appendChild(warningEl);
    }

    function hideWarning() {
      if (warningEl) {
        warningEl.remove();
        warningEl = null;
      }
    }

    // Block submit if description is empty (capture phase fires before Onshape)
    submitBtn.addEventListener("click", (e) => {
      if (!descField.value.trim()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        showWarning();
        descField.focus();
      }
    }, true);

    // Also block form-level submit (Enter key, etc.)
    const form = modal.querySelector("form");
    if (form) {
      form.addEventListener("submit", (e) => {
        if (!descField.value.trim()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          showWarning();
          descField.focus();
        }
      }, true);
    }

    // Update button appearance and hide warning as user types
    descField.addEventListener("input", () => {
      updateButtonState();
      if (descField.value.trim()) {
        hideWarning();
      }
    });

    console.log("[VersionDesc] Guard attached to Create Version dialog");
  }

  // ---------------------------------------------------------------------------
  // Release branch guard — blocks release creation from non-main workspaces
  // ---------------------------------------------------------------------------
  // Selector confirmed via live DOM inspection: div.modal.release-dialog.show
  // Title confirmed: "Create Release candidate"
  // Action buttons: Save draft (.save-draft-btn), Apply/Submit (.btn-primary),
  //                 Release (.btn-success) — Close (.button-cancel) left enabled.
  // Banner inserted before .modal-footer (inside the release-dialog element).

  (function initReleaseBranchGuard() {
    let _lastModal = null;

    const observer = new MutationObserver(() => {
      if (_killSwitchActive) return;
      const modal = document.querySelector("div.modal.release-dialog.show");
      if (modal && modal !== _lastModal) {
        _lastModal = modal;
        if (!modal.dataset.oxtReleaseGuarded) {
          modal.dataset.oxtReleaseGuarded = "1";
          const docId = getDocIdFromUrl();
          const wid = getWidFromUrl();
          if (!docId || !wid) return;

          // Reset rollback bar to end of feature list for all Part Studios
          chrome.runtime.sendMessage({ type: "reset-partstudio-rollbacks", docId, wid }, (resp) => {
            if (resp?.ok) {
              console.log(`[RollbackReset] Reset ${resp.count} Part Studio(s)`);
            } else {
              console.log("[RollbackReset] Failed or no Part Studios:", resp?.error);
            }
          });

          chrome.runtime.sendMessage({ type: "check-main-workspace", docId, wid }, (resp) => {
            if (resp && resp.isMain) {
              console.log("[ReleaseGuard] On main workspace — release allowed");
              return;
            }

            console.log("[ReleaseGuard] Not on main workspace — blocking release");

            // Banner inserted just before the footer row
            const footer = modal.querySelector(".modal-footer");
            if (!footer) return;

            const banner = document.createElement("div");
            banner.id = "oxt-release-branch-banner";
            banner.style.cssText = `
              background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
              padding: 10px 14px; margin: 8px 16px; font-size: 13px;
              color: #92400e; font-weight: 500;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            banner.textContent = "Releases can only be created from the main branch. Switch to the main workspace and try again.";
            footer.parentNode.insertBefore(banner, footer);

            // Disable action buttons — leave Close (.button-cancel) enabled
            for (const btn of modal.querySelectorAll("button")) {
              const cls = btn.className;
              if (
                cls.includes("save-draft-btn") ||
                cls.includes("btn-primary") ||
                cls.includes("btn-success")
              ) {
                btn.disabled = true;
                btn.style.opacity = "0.4";
                btn.style.cursor = "not-allowed";
                btn.title = "Switch to main workspace to create a release";
                console.log(`[ReleaseGuard] Disabled: "${btn.textContent.trim()}"`);
              }
            }
          });
        }
      } else if (!modal && _lastModal) {
        delete _lastModal.dataset.oxtReleaseGuarded;
        _lastModal = null;
        console.log("[ReleaseGuard] Release dialog closed");
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    console.log("[ReleaseGuard] Observer started");
  })();

  // ---------------------------------------------------------------------------
  // Rollback reset — move all Part Studio rollback bars to end of feature list
  // when the Versions and History panel button is clicked.
  // ---------------------------------------------------------------------------

  (function initRollbackOnVersionsPanel() {
    // Event delegation — survives Angular re-renders. Capture phase so Angular
    // stop-propagation on the button doesn't swallow the event.
    document.addEventListener("click", (e) => {
      // The element itself carries data-bs-original-title; no closest() needed.
      const el = e.target;
      const tip = el.getAttribute("data-bs-original-title") || el.getAttribute("title") ||
                  el.parentElement?.getAttribute("data-bs-original-title") || "";
      if (tip !== "Versions and history") return;

      const docId = getDocIdFromUrl();
      const wid = getWidFromUrl();
      if (!docId || !wid) return;
      chrome.runtime.sendMessage({ type: "reset-partstudio-rollbacks", docId, wid }, (resp) => {
        if (resp?.ok) {
          console.log(`[RollbackReset] Reset ${resp.count} Part Studio(s) via Versions panel`);
        } else {
          console.log("[RollbackReset] Versions panel trigger failed:", resp?.error);
        }
      });
    }, true);

    console.log("[RollbackReset] Versions panel click delegation active");
  })();

  // ---------------------------------------------------------------------------
  // Parts materials guard — blocks release if any parts are missing materials
  // or still have a default "Part N" name.
  // ---------------------------------------------------------------------------
  // Runs alongside initReleaseBranchGuard on the same div.modal.release-dialog.show.
  // Uses dataset.oxtPartsGuarded to avoid double-running.
  // Fails open: if the API errors or returns no parts (e.g. Assembly tab), no block.

  (function initPartsMaterialsGuard() {
    let _lastModal = null;

    const observer = new MutationObserver(() => {
      if (_killSwitchActive) return;
      const modal = document.querySelector("div.modal.release-dialog.show");
      if (modal && modal !== _lastModal) {
        _lastModal = modal;
        if (!modal.dataset.oxtPartsGuarded) {
          modal.dataset.oxtPartsGuarded = "1";
          const docId = getDocIdFromUrl();
          const wid   = getWidFromUrl();
          const eid   = getEidFromUrl();
          if (!docId || !wid || !eid) return;

          chrome.runtime.sendMessage({ type: "check-parts-materials", docId, wid, eid }, (resp) => {
            if (!resp || !resp.issues || resp.issues.length === 0) {
              console.log("[PartsGuard] All parts OK — release allowed");
              return;
            }

            console.log("[PartsGuard] Parts issues found — blocking release:", resp.issues);

            const footer = modal.querySelector(".modal-footer");
            if (!footer) return;

            const banner = document.createElement("div");
            banner.id = "oxt-parts-banner";
            banner.style.cssText = `
              background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
              padding: 10px 14px; margin: 8px 16px; font-size: 13px;
              color: #92400e; font-weight: 500;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            const list = resp.issues.map(i => `• ${i}`).join("\n");
            banner.textContent = `Fix the following before releasing:\n${list}`;
            banner.style.whiteSpace = "pre-line";
            footer.parentNode.insertBefore(banner, footer);

            for (const btn of modal.querySelectorAll("button")) {
              const cls = btn.className;
              if (
                cls.includes("save-draft-btn") ||
                cls.includes("btn-primary") ||
                cls.includes("btn-success")
              ) {
                btn.disabled = true;
                btn.style.opacity = "0.4";
                btn.style.cursor = "not-allowed";
                btn.title = "Assign materials and rename all parts before releasing";
                console.log(`[PartsGuard] Disabled: "${btn.textContent.trim()}"`);
              }
            }
          });
        }
      } else if (!modal && _lastModal) {
        delete _lastModal.dataset.oxtPartsGuarded;
        _lastModal = null;
        console.log("[PartsGuard] Release dialog closed");
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    console.log("[PartsGuard] Observer started");
  })();

  // ---------------------------------------------------------------------------
  // Workspace protection guard — only doc creator can toggle protection
  // ---------------------------------------------------------------------------
  // Selector confirmed via live DOM: div.modal.workspace-permissions-dialog.show
  // Checkbox: #enable-workspace-protection
  // Apply:    #workspace-protection-apply (input[type=button])
  // Cancel/X: left enabled

  function initProtectionGuard() {
    let _lastModal = null;

    const observer = new MutationObserver(() => {
      if (_killSwitchActive) return;
      const modal = document.querySelector("div.modal.workspace-permissions-dialog.show");
      if (modal && modal !== _lastModal) {
        _lastModal = modal;
        if (!modal.dataset.oxtProtectionGuarded) {
          modal.dataset.oxtProtectionGuarded = "1";
          const docId = getDocIdFromUrl();
          if (!docId) return;

          Promise.all([
            new Promise(res => chrome.runtime.sendMessage({ type: "get-session-user" }, res)),
            new Promise(res => chrome.runtime.sendMessage({ type: "get-doc-creator", docId }, res)),
          ]).then(([sessionUser, creatorResp]) => {
            const creator = creatorResp?.creator;
            const isOwner = creator && sessionUser && creator.id === sessionUser.id;
            if (isOwner) {
              console.log("[ProtectionGuard] User is doc creator — access allowed");
              return;
            }

            console.log("[ProtectionGuard] User is not doc creator — blocking protection toggle");

            const footer = modal.querySelector(".modal-footer");
            const banner = document.createElement("div");
            banner.style.cssText = `
              background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
              padding: 10px 14px; margin: 8px 16px; font-size: 13px;
              color: #92400e; font-weight: 500;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            banner.textContent = "Only the document creator can change workspace protection settings.";
            if (footer) footer.parentNode.insertBefore(banner, footer);

            const checkbox = modal.querySelector("#enable-workspace-protection");
            if (checkbox) {
              checkbox.disabled = true;
              checkbox.style.opacity = "0.4";
              checkbox.style.cursor = "not-allowed";
            }

            const applyBtn = modal.querySelector("#workspace-protection-apply");
            if (applyBtn) {
              applyBtn.disabled = true;
              applyBtn.style.opacity = "0.4";
              applyBtn.style.cursor = "not-allowed";
              applyBtn.title = "Only the document creator can change workspace protection";
            }
          });
        }
      } else if (!modal && _lastModal) {
        delete _lastModal.dataset.oxtProtectionGuarded;
        _lastModal = null;
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    console.log("[ProtectionGuard] Observer started");
  }

  // ---------------------------------------------------------------------------
  // Insert tab limit guard — disables the insert-tab button when tabs >= 40
  // ---------------------------------------------------------------------------

  function applyTabLimitGuard() {
    const btn = document.querySelector('[data-bs-original-title="Insert new tab"]');
    if (!btn) return;
    const countStr = document.documentElement.dataset.oxtTabCount;
    const count = parseInt(countStr, 10);
    const overLimit = !isNaN(count) && count >= 40;
    if (overLimit) {
      if (!btn.dataset.oxtTabLimitDisabled) {
        btn.dataset.oxtTabLimitDisabled = "1";
        btn.style.opacity = "0.4";
        btn.style.pointerEvents = "none";
        btn.style.cursor = "not-allowed";
        console.log(`[InsertTabGuard] Button disabled — ${count} tabs (limit: 40)`);
      }
    } else {
      if (btn.dataset.oxtTabLimitDisabled) {
        delete btn.dataset.oxtTabLimitDisabled;
        btn.style.opacity = "";
        btn.style.pointerEvents = "";
        btn.style.cursor = "";
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Insert tab import guard — disable Import in insert-tab dropdown unless
  // the doc's top-level folder is "OTS Parts"
  // ---------------------------------------------------------------------------
  // Selector confirmed via live DOM observation:
  //   Dropdown:    ul.dropdown-menu.bottom-up  (added to DOM when insert button clicked)
  //   Import item: a#upload-button.dropdown-item  (inside a <li> in that ul)
  // ---------------------------------------------------------------------------
  function initInsertTabGuard() {
    function applyGuard() {
      const menu = document.querySelector("ul.dropdown-menu.bottom-up");
      if (!menu || menu.offsetHeight === 0) return;
      const importItem = menu.querySelector("a#upload-button");
      if (!importItem || importItem.dataset.oxtImportGuarded) return;
      importItem.dataset.oxtImportGuarded = "1";

      // Disable by default
      importItem.style.opacity = "0.4";
      importItem.style.pointerEvents = "none";
      importItem.style.cursor = "not-allowed";
      console.log("[InsertTabGuard] Import disabled by default");

      const docId = getDocIdFromUrl();
      if (!docId) return;

      chrome.runtime.sendMessage({ type: "get-top-folder", docId }, (resp) => {
        if (resp?.topFolderName === "OTS Parts") {
          importItem.style.opacity = "";
          importItem.style.pointerEvents = "";
          importItem.style.cursor = "";
          console.log("[InsertTabGuard] Import enabled — OTS Parts doc");
        } else {
          console.log("[InsertTabGuard] Import stays disabled — top folder: " + resp?.topFolderName);
        }
      });
    }

    // Watch for insert tab button click to eagerly fetch assembly count
    // so content-main.js assembly guard has fresh data before the dropdown renders
    function attachInsertBtnListener() {
      const btn = document.querySelector('[data-bs-original-title="Insert new tab"]');
      if (!btn || btn.dataset.oxtInsertListening) return;
      btn.dataset.oxtInsertListening = "1";

      // Capture-phase blocker: stop click before Bootstrap opens the dropdown
      btn.addEventListener("click", (e) => {
        const count = parseInt(document.documentElement.dataset.oxtTabCount, 10);
        if (!isNaN(count) && count >= 40) {
          e.stopImmediatePropagation();
          e.preventDefault();
          console.log("[InsertTabGuard] Click blocked — tab limit reached");
        }
      }, true);

      btn.addEventListener("click", () => {
        const docId = getDocIdFromUrl();
        const wid = getWidFromUrl();
        if (!docId || !wid) return;
        chrome.runtime.sendMessage({ type: "get-assembly-count", docId, wid }, (resp) => {
          if (resp && typeof resp.count === "number") {
            document.documentElement.dataset.oxtAssemblyCount = String(resp.count);
            console.log("[InsertTabGuard] Assembly count refreshed:", resp.count);
          }
        });
      }, true);
    }

    const observer = new MutationObserver(() => {
      if (_killSwitchActive) return;
      applyGuard();
      applyTabLimitGuard();
      attachInsertBtnListener();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    attachInsertBtnListener();
    applyTabLimitGuard();
    console.log("[InsertTabGuard] Observer started");
  }

  // ---------------------------------------------------------------------------
  // Rollback dialog inject — adds "Roll to end for all Part Studios" button
  // inside the Onshape release dialog when it opens.
  // ---------------------------------------------------------------------------
  (function initRollbackDialog() {
    const DIALOG_SEL  = "div.modal.release-dialog.show";
    const BTN_ID      = "oxt-rollback-btn";
    const STATUS_ID   = "oxt-rollback-status";

    function injectButton(dialog) {
      if (dialog.querySelector("#" + BTN_ID)) return; // already injected

      const btn = document.createElement("button");
      btn.id    = BTN_ID;
      btn.type  = "button";
      btn.textContent = "Roll to end for all Part Studios";
      btn.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "gap:6px",
        "margin:8px 0 4px",
        "padding:5px 12px",
        "border:1px solid #1565c0",
        "border-radius:4px",
        "background:#1a73e8",
        "color:#fff",
        "font-size:13px",
        "cursor:pointer",
        "white-space:nowrap",
      ].join(";");

      const status = document.createElement("span");
      status.id = STATUS_ID;
      status.style.cssText = "font-size:12px;color:#555;margin-left:6px";

      btn.addEventListener("click", () => {
        const docId = getDocIdFromUrl();
        const wid   = getWidFromUrl();
        if (!docId || !wid) {
          status.textContent = "Could not read doc/workspace from URL.";
          return;
        }
        btn.disabled = true;
        status.textContent = "Working…";
        chrome.runtime.sendMessage({ type: "reset-partstudio-rollbacks", docId, wid }, (resp) => {
          btn.disabled = false;
          if (resp?.ok) {
            status.textContent = `Done — reset ${resp.count} Part Studio(s).`;
            btn.style.background   = "#198754";
            btn.style.borderColor  = "#198754";
          } else {
            status.textContent = "Failed: " + (resp?.error || "unknown error");
            btn.style.background   = "#dc3545";
            btn.style.borderColor  = "#dc3545";
          }
        });
      });

      // Insert at top of the modal body so it's immediately visible
      const body = dialog.querySelector(".modal-body, .modal-content");
      if (body) {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = "padding:0 16px 4px";
        wrapper.appendChild(btn);
        wrapper.appendChild(status);
        body.insertAdjacentElement("afterbegin", wrapper);
      }
    }

    const observer = new MutationObserver(() => {
      const dialog = document.querySelector(DIALOG_SEL);
      if (dialog) injectButton(dialog);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    console.log("[RollbackDialog] Observer started");
  })();

  // Start interceptors
  initCreateDropdownGuard();
  initVersionDescriptionEnforcer();
  initProtectionGuard();
  initInsertTabGuard();

  // ---------------------------------------------------------------------------
  // SW keepalive — persistent port keeps the service worker from going idle
  // while an Onshape tab is open. Reconnects automatically if the SW restarts.
  // ---------------------------------------------------------------------------
  function connectKeepalive() {
    const port = chrome.runtime.connect({ name: "keepalive" });
    port.onDisconnect.addListener(connectKeepalive);
  }
  connectKeepalive();

})();
