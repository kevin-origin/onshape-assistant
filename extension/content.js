// content.js — Onshape Tab Folder Scanner
// Injected into Onshape document pages. Reads the tab bar DOM by clicking
// through folders and reporting the structure back to background.js.

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Release settings page guard — only Kevin's accounts may access
  // ---------------------------------------------------------------------------
  const RELEASE_URL = "/companySettings/6810c247e7c40668c32816a6/release";
  const ADMIN_EMAILS = ["kevin@origin.tech", "kevin@10xconstruction.ai"];

  if (window.location.pathname.startsWith(RELEASE_URL)) {
    chrome.runtime.sendMessage({ type: "get-session-user" }, (user) => {
      if (user && !user.error && ADMIN_EMAILS.includes(user.email?.toLowerCase())) {
        console.log("[ReleaseGuard] Admin access granted:", user.email);
        return; // allowed — do nothing
      }
      console.log("[ReleaseGuard] Blocked — unauthorized user:", user?.email || "unknown");
      // Full-page overlay preventing interaction
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#1a1a2e;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:system-ui,sans-serif;";
      overlay.innerHTML = `
        <div style="text-align:center;color:#e0e0e0;max-width:480px;padding:40px;">
          <div style="font-size:48px;margin-bottom:20px;">&#128274;</div>
          <h1 style="font-size:24px;margin:0 0 12px;color:#fff;">Access Restricted</h1>
          <p style="font-size:16px;line-height:1.5;color:#aaa;margin:0 0 24px;">
            Release management settings are restricted to administrators only.
            Contact your admin if you need access.
          </p>
          <button id="release-guard-back" style="padding:10px 28px;font-size:15px;border:none;border-radius:6px;background:#4a6cf7;color:#fff;cursor:pointer;">
            Go Back
          </button>
        </div>`;
      document.documentElement.appendChild(overlay);
      overlay.querySelector("#release-guard-back").addEventListener("click", () => {
        window.history.back();
      });
    });
    return; // stop all other content.js logic for this page
  }

  const CLICK_DELAY = 500;   // ms after clicking a folder before reading children
  const ROOT_DELAY  = 500;   // ms after clicking "All tabs" breadcrumb
  const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];
  const EXCLUDED_DOC_NAMES = ["OTS Parts"];  // shared library docs — skip all scanning/sorting/violations
  let _scanning = false;     // lock to prevent concurrent scans
  let _folderCreationInProgress = false; // suppress scans during folder creation
  let _unpackInProgress = false; // suppress scans during folder unpacking

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
  // Auto-scan logic — runs on every Onshape doc open
  // ---------------------------------------------------------------------------

  async function autoScan() {
    if (_folderCreationInProgress) {
      console.log("[Scanner] autoScan skipped: folder creation in progress");
      return;
    }
    if (_unpackInProgress) {
      console.log("[Scanner] autoScan skipped: folder unpack in progress");
      return;
    }
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
      // Store scan data for popup, but skip Chrome notification if overlay is showing
      // (the overlay IS the notification — user is already being prompted)
      sendScanResult(result, overlayShown);
    }

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

    // Auto-unpack illegal folders (names not in ALLOWED_FOLDERS)
    const illegalFolders = folders.filter(f => !ALLOWED_FOLDERS.includes(f));
    if (illegalFolders.length > 0 && !_unpackInProgress) {
      console.log("[Unpack] Found illegal folders:", illegalFolders);
      _unpackInProgress = true;
      showProgressToast("Unpacking illegal folders...");
      chrome.runtime.sendMessage({ type: "unpack-illegal-folders", folders: illegalFolders });
      return; // sort + re-scan will happen after unpack completes
    }

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

  // Show folder creation overlay only on new/empty documents.
  // Guard conditions: must have 0 folders, <5 root tabs (not a mature doc),
  // not already offered, and <=1 version (new docs have 0 or 1 auto-version).
  // Version count is read from chrome.storage (cached by checkDocViolations) —
  // zero extra API calls. If not yet cached (race with violations check),
  // waits 3s and retries; if still undefined, assumes brand-new doc.
  async function maybeOfferFolderCreation(scanResult) {
    const docId = scanResult.doc_id;
    if (!docId) { console.log("[FolderSetup] No docId"); return false; }

    const folders = Object.keys(scanResult.folders || {});
    const rootTabs = scanResult.root_tabs || [];
    console.log(`[FolderSetup] docId=${docId}, folders=${folders.length}, rootTabs=${rootTabs.length}`);

    if (folders.length > 0) { console.log("[FolderSetup] Skipped: has folders"); return false; }
    if (rootTabs.length >= 5) { console.log("[FolderSetup] Skipped: too many root tabs"); return false; }

    const stored = await chrome.storage.local.get("folderCreationOffered");
    const offered = stored.folderCreationOffered || [];
    if (offered.includes(docId)) { console.log("[FolderSetup] Skipped: already offered"); return false; }

    // Version count cached by checkDocViolations (zero extra API calls)
    const vcData = await chrome.storage.local.get("versionCounts");
    const versionCount = (vcData.versionCounts || {})[docId];
    console.log(`[FolderSetup] versionCount=${versionCount}`);
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
      background: #1a1a2e; border-radius: 8px; padding: 24px 28px;
      min-width: 340px; max-width: 420px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      border: 1px solid #333;
    `;

    const title = document.createElement("h3");
    title.textContent = "Set up folder structure";
    title.style.cssText = "margin: 0 0 16px 0; font-size: 16px; color: #e0e0e0;";
    card.appendChild(title);

    const checkboxes = [];
    for (const name of FOLDER_NAMES) {
      const label = document.createElement("label");
      label.style.cssText = "display: flex; align-items: center; gap: 8px; margin: 8px 0; font-size: 14px; color: #e0e0e0; cursor: pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = name;
      cb.style.cssText = "width: 16px; height: 16px; cursor: pointer; accent-color: #7ec8e3;";
      label.appendChild(cb);
      label.appendChild(document.createTextNode(name));
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
      background: #1b4332; color: #95d5b2; font-size: 14px; cursor: pointer;
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
          const [userResp, teamResp, permsData, creatorResp] = await Promise.all([
            new Promise(resolve => chrome.runtime.sendMessage({ type: "get-session-user" }, resolve)),
            new Promise(resolve => chrome.runtime.sendMessage({ type: "get-team-members" }, resolve)),
            chrome.storage.local.get("mergePermissions"),
            new Promise(resolve => chrome.runtime.sendMessage({ type: "get-doc-creator", docId }, resolve)),
          ]);
          if (!userResp || userResp.error) { sendResponse({ error: "No session user" }); return; }
          const members = teamResp?.members || [];
          if (members.length === 0) { sendResponse({ error: "No team members" }); return; }

          // If owners already set for this doc, only existing owners can edit
          const perms = (permsData.mergePermissions || {})[docId];
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

          // Auto-suggest 2 owners when none are set:
          // If doc creator is a real person (not company), pre-select creator + session user.
          // If doc creator is the company account, pre-select session user + first other member.
          if (currentOwners.length === 0 && members.length >= 2) {
            const creator = creatorResp && !creatorResp.error && !creatorResp.isCompany ? creatorResp : null;
            const suggestions = [];
            // Add doc creator if they're a real team member
            if (creator) {
              const creatorMember = members.find(m => m.id === creator.id || m.email === creator.email);
              if (creatorMember) suggestions.push(creatorMember);
            }
            // Add session user if not already added
            if (suggestions.length < 2) {
              const self = members.find(m => m.id === userResp.id || m.email === userResp.email);
              if (self && !suggestions.some(s => s.id === self.id)) suggestions.push(self);
            }
            // Fill remaining slot with the first other member
            if (suggestions.length < 2) {
              const other = members.find(m => !suggestions.some(s => s.id === m.id));
              if (other) suggestions.push(other);
            }
            currentOwners = suggestions;
          }

          showMergeOwnerOverlay(docId, docName, userResp, members, currentOwners);
          sendResponse({ ok: true });
        })();
        return true;
      }

    } else if (msg.type === "unpack-progress") {
      showProgressToast(`Unpacking folder: "${msg.name}"...`);

    } else if (msg.type === "unpack-done") {
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
  // Scan lifecycle: on each new doc, wait 8s (let Onshape SPA init), then:
  //   1. autoScan() — reads tab bar DOM, triggers sort if folders exist
  //   2. checkDocViolations — versions/parts/features/tabs limits (via background.js)
  //   3. Poll both every 10 min to catch changes made during the session.
  // Timers are cleared and re-created on SPA navigation (doc switch).
  let _lastDocId = null;
  let _scanTimer = null;
  let _violationsTimer = null;
  let _pollInterval = null;
  const POLL_INTERVAL_MS = 600000; // 10 min
  let _killSwitchActive = false; // set true if background says extension is disabled

  function runOnDocLoad() {
    if (_killSwitchActive) return;
    const docId = getDocIdFromUrl();
    if (!docId || docId === _lastDocId) return;
    _lastDocId = docId;
    console.log("[Scanner] Doc detected:", docId);

    // Cancel any pending timers/intervals from a previous doc
    if (_scanTimer) { clearTimeout(_scanTimer); _scanTimer = null; }
    if (_violationsTimer) { clearTimeout(_violationsTimer); _violationsTimer = null; }
    if (_notifyTimer) { clearTimeout(_notifyTimer); _notifyTimer = null; }
    if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; }

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
      if (EXCLUDED_DOC_NAMES.includes(docName)) {
        console.log(`[Scanner] Violations skipped: "${docName}" is in EXCLUDED_DOC_NAMES`);
        return;
      }
      if (docId) {
        chrome.runtime.sendMessage({ type: "check-versions", docId, docName, wid });
      }
    }, 8000);

    // Start continuous polling after the initial checks finish (8s + small buffer)
    _pollInterval = setInterval(() => {
      const currentDocId = getDocIdFromUrl();
      if (currentDocId !== docId) return; // doc changed, next runOnDocLoad will reset
      if (_scanning || _folderCreationInProgress) return; // skip if busy

      console.log("[Poll] Running periodic checks for", docId);

      // Re-run tab scanner
      autoScan();

      // Re-run violations check (skip excluded docs)
      const wid = getWidFromUrl();
      const docName = getDocName();
      if (!EXCLUDED_DOC_NAMES.includes(docName)) {
        chrome.runtime.sendMessage({ type: "check-versions", docId: currentDocId, docName, wid });
      }
    }, POLL_INTERVAL_MS);
  }

  // Check kill switch before doing anything — if background says disabled, bail out entirely
  chrome.runtime.sendMessage({ type: "check-kill-switch" }, (resp) => {
    if (resp?.disabled) {
      _killSwitchActive = true;
      console.log("[Scanner] Kill switch active — content script disabled");
      return;
    }
    // Initial page load (only if not killed)
    runOnDocLoad();
  });

  // SPA navigation: background.js sends "spa-navigated" when URL changes
  chrome.runtime.onMessage.addListener((msg) => {
    if (_killSwitchActive) return;
    if (msg.type === "spa-navigated") {
      console.log("[Scanner] SPA navigation (tabs.onUpdated):", msg.url);
      _notifiedDocIds.clear(); // reset notification tracking for new doc
      removeFolderOverlay();
      runOnDocLoad();
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
  // Export Drawing detection — blocks export when violations/no releases exist
  // ---------------------------------------------------------------------------
  // MutationObserver watches for Onshape's export modal (added dynamically).
  // Selectors discovered via observe-dom-changes + manual right-click → Export:
  //   Form:   form.export-dxf-or-dwg-dialog
  //   Filename: #drawing-export-filename-input
  // On detection: checks releases (API) + cached violations (zero API calls).
  // If blocked: disables submit button + intercepts form submit event.

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

        // Check releases AND violations/folder structure in parallel (zero extra API calls for violations)
        const releaseCheck = new Promise(resolve =>
          chrome.runtime.sendMessage({ type: "check-releases", docId }, resolve)
        );
        const exportCheck = new Promise(resolve =>
          chrome.runtime.sendMessage({ type: "check-export-allowed", docId }, resolve)
        );

        Promise.all([releaseCheck, exportCheck]).then(([releaseResp, exportResp]) => {
          const noReleases = !releaseResp || !releaseResp.hasReleases;
          const hasIssues = exportResp && exportResp.blocked;
          const shouldBlock = noReleases || hasIssues;

          if (!shouldBlock) {
            console.log(`[ExportDetect] Doc has ${releaseResp?.count || 0} release(s), no issues — export allowed`);
            return;
          }

          const modalContent = form.closest(".modal-content");
          if (!modalContent) return;
          const modalBody = modalContent.querySelector(".modal-body, .me-4");

          // Banner 1: No releases
          if (noReleases) {
            console.log("[ExportDetect] No releases found, showing release banner");
            const banner = document.createElement("div");
            banner.id = "oxt-release-reminder";
            banner.style.cssText = `
              background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
              padding: 10px 14px; margin: 0 16px 12px 16px; font-size: 13px;
              color: #92400e; font-weight: 500;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            banner.textContent = "Please create a release before sending for manufacturing.";
            if (modalBody) {
              modalBody.parentNode.insertBefore(banner, modalBody);
            } else {
              modalContent.insertBefore(banner, modalContent.children[1] || null);
            }
          }

          // Banner 2: Violations or folder structure issues
          if (hasIssues) {
            console.log("[ExportDetect] Violations/folder issues detected:", exportResp.issues);
            const banner2 = document.createElement("div");
            banner2.id = "oxt-export-issues";
            banner2.style.cssText = `
              background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px;
              padding: 10px 14px; margin: 0 16px 12px 16px; font-size: 13px;
              color: #92400e; font-weight: 500;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            `;
            banner2.textContent = "Violations or incorrect folder structure detected. Please resolve before exporting.";
            // Insert after the first banner (or before modal body if no release banner)
            const existingBanner = modalContent.querySelector("#oxt-release-reminder");
            if (existingBanner && existingBanner.nextSibling) {
              existingBanner.parentNode.insertBefore(banner2, existingBanner.nextSibling);
            } else if (modalBody) {
              modalBody.parentNode.insertBefore(banner2, modalBody);
            } else {
              modalContent.insertBefore(banner2, modalContent.children[1] || null);
            }
          }

          // Disable the Export/OK submit button
          const buttons = form.querySelectorAll("button");
          for (const btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            if (text === "export" || text === "ok" || btn.type === "submit") {
              btn.disabled = true;
              btn.title = noReleases ? "Release required before export" : "Resolve violations before export";
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
  // Merge dialog blocker — blocks non-owners from merging branches
  // ---------------------------------------------------------------------------
  // MutationObserver watches for any modal with "merge" in title/text.
  // On detection: asks background.js if session user is in the doc's merge
  // owners list (backend → local fallback, zero extra API calls).
  // If not allowed: inserts warning banner, disables submit button,
  // intercepts form submit. Resets when modal is removed from DOM.

  let _mergeDetected = false;

  const mergeObserver = new MutationObserver((mutations) => {
    if (_mergeDetected || _killSwitchActive) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (!node.querySelector) continue;

        // Look for modal with merge-related content
        const modal = node.classList?.contains("modal")
          ? node
          : node.querySelector?.(".modal");
        if (!modal) continue;

        // Check if this modal is about merging — check title element first, then full modal text
        const titleEl = modal.querySelector(".modal-title, .modal-header h4, .modal-header h3, .modal-header span");
        const titleText = (titleEl?.textContent || "").toLowerCase();
        const allText = (modal.textContent || "").toLowerCase();
        if (!titleText.includes("merge") && !allText.includes("merge")) continue;

        _mergeDetected = true;
        console.log("[MergeBlock] Merge dialog detected");

        const docId = getDocIdFromUrl();
        if (!docId) { _mergeDetected = false; continue; }

        // Ask background if current user is allowed
        chrome.runtime.sendMessage({
          type: "check-merge-allowed",
          docId: docId,
        }, (response) => {
          if (response && response.allowed) {
            console.log("[MergeBlock] User is allowed to merge");
            return;
          }

          console.log("[MergeBlock] User NOT allowed, blocking merge");
          const modalContent = modal.querySelector(".modal-content") || modal;

          // Show warning banner
          const banner = document.createElement("div");
          banner.id = "oxt-merge-blocker";
          banner.style.cssText = `
            background: #533a0f; border: 1px solid #f59e0b; border-radius: 4px;
            padding: 10px 14px; margin: 10px 16px; font-size: 13px;
            color: #f0c040; font-weight: 500;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          `;
          banner.textContent = "You do not have permission to merge branches. Contact the document owner.";

          const modalBody = modalContent.querySelector(".modal-body");
          if (modalBody) {
            modalBody.parentNode.insertBefore(banner, modalBody);
          } else {
            modalContent.insertBefore(banner, modalContent.children[1] || null);
          }

          // Disable all submit/action buttons in the modal
          const buttons = modal.querySelectorAll("button");
          for (const btn of buttons) {
            const text = btn.textContent.trim().toLowerCase();
            if (text === "merge" || text === "ok" || text === "apply" || btn.type === "submit") {
              btn.disabled = true;
              btn.title = "Merge not allowed — contact document owner";
              btn.style.opacity = "0.4";
              btn.style.cursor = "not-allowed";
              console.log(`[MergeBlock] Disabled button: "${btn.textContent.trim()}"`);
            }
          }

          // Block form submission
          const form = modal.querySelector("form");
          if (form) {
            form.addEventListener("submit", function blockMerge(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              console.log("[MergeBlock] Form submit blocked");
            }, true);
          }
        });

        // Reset flag when modal is removed
        const removeObserver = new MutationObserver(() => {
          if (!document.querySelector("#oxt-merge-blocker")) {
            _mergeDetected = false;
            removeObserver.disconnect();
            console.log("[MergeBlock] Merge dialog closed");
          }
        });
        removeObserver.observe(document.body, { childList: true, subtree: true });
        return;
      }
    }
  });

  mergeObserver.observe(document.body, { childList: true, subtree: true });

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
    subtitle.textContent = `Select exactly 2 merge owners for "${docName}"`;
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
      // Enforce max 2 selected
      cb.addEventListener("change", () => {
        const checkedCount = checkboxes.filter(c => c.checked).length;
        if (checkedCount > 2) { cb.checked = false; }
        subtitle.style.color = checkedCount === 2 ? "#95d5b2" : "#888";
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
      if (selected.length !== 2) {
        subtitle.textContent = "Please select exactly 2 owners.";
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
  // Create Document Interceptor — force folder selection for new documents
  // ---------------------------------------------------------------------------

  const ROBOTS_FOLDER_ID = "371921fef1883886aa1b6818";

  function initCreateDocInterceptor() {
    // Watch for the Create dropdown appearing anywhere in the DOM.
    // Use childList + subtree + attributes so we catch both fresh nodes
    // and the .show class being toggled on an existing dropdown.
    let _lastDropdown = null;
    const observer = new MutationObserver(() => {
      const dropdown = document.querySelector(
        "div.dropdown-menu.os-create-menu.create-new-type-menu.show"
      );
      if (dropdown && dropdown !== _lastDropdown) {
        // New dropdown appeared (or reappeared) — intercept it
        _lastDropdown = dropdown;
        delete dropdown.dataset.oxtIntercepted;
        waitForDocButton(dropdown);
      } else if (!dropdown && _lastDropdown) {
        // Dropdown closed — reset so next open is intercepted
        delete _lastDropdown.dataset.oxtIntercepted;
        _lastDropdown = null;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    console.log("[CreateDoc] Interceptor observer started");
  }

  function waitForDocButton(dropdown, attempts) {
    attempts = attempts || 0;
    const buttons = dropdown.querySelectorAll("button.dropdown-item");
    let docBtn = null;
    for (const btn of buttons) {
      if (btn.textContent.trim().startsWith("Document")) {
        docBtn = btn;
        break;
      }
    }
    if (!docBtn) {
      // Retry up to 500ms (10 attempts x 50ms) for Angular to populate buttons
      if (attempts < 10) {
        setTimeout(() => waitForDocButton(dropdown, attempts + 1), 50);
      }
      return;
    }
    // Mark so we don't re-intercept the same dropdown instance
    dropdown.dataset.oxtIntercepted = "1";
    attachDocumentIntercept(dropdown, docBtn);
  }

  function attachDocumentIntercept(dropdown, docBtn) {
    // Capture-phase listener on the button — fires before Onshape's handlers
    docBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      // Let Onshape close the dropdown naturally by simulating Escape
      dropdown.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", code: "Escape", keyCode: 27, bubbles: true,
      }));
      showCreateDocOverlay();
    }, true);
    console.log("[CreateDoc] Intercepted 'Document...' button");
  }

  // ---- Overlay UI ----

  function showCreateDocOverlay() {
    // Remove any existing overlay
    const existing = document.getElementById("oxt-create-doc-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "oxt-create-doc-overlay";
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 999999;
      background: rgba(0,0,0,0.6); display: flex;
      align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #1a1a2e; border-radius: 12px; padding: 28px 32px;
      min-width: 420px; max-width: 520px; color: #e0e0e0;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    `;

    // Close on backdrop click
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    // --- Step 1: Robot-related question ---
    showRobotQuestion(card, overlay);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  function showRobotQuestion(card, overlay) {
    card.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = "Create New Document";
    title.style.cssText = "margin: 0 0 6px; font-size: 20px; color: #fff;";
    card.appendChild(title);

    const subtitle = document.createElement("p");
    subtitle.textContent = "Is this document robot-related?";
    subtitle.style.cssText = "margin: 0 0 4px; font-size: 15px; color: #ccc;";
    card.appendChild(subtitle);

    const hint = document.createElement("p");
    hint.textContent = "Includes POCs, experiments, and anything robot-adjacent.";
    hint.style.cssText = "margin: 0 0 20px; font-size: 12px; color: #888;";
    card.appendChild(hint);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 12px; justify-content: center;";

    const yesBtn = makeButton("Yes", "#4a6cf7");
    const noBtn = makeButton("No", "#555");
    const cancelBtn = makeButton("Cancel", "#333", "#aaa");

    yesBtn.addEventListener("click", () => {
      showFolderPicker(card, overlay, true);
    });
    noBtn.addEventListener("click", () => {
      showFolderPicker(card, overlay, false);
    });
    cancelBtn.addEventListener("click", () => overlay.remove());

    btnRow.appendChild(yesBtn);
    btnRow.appendChild(noBtn);
    btnRow.appendChild(cancelBtn);
    card.appendChild(btnRow);
  }

  function showFolderPicker(card, overlay, isRobot) {
    card.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = "Create New Document";
    title.style.cssText = "margin: 0 0 16px; font-size: 20px; color: #fff;";
    card.appendChild(title);

    // Document name input
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Document name";
    nameLabel.style.cssText = "font-size: 13px; color: #aaa; display: block; margin-bottom: 4px;";
    card.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Enter document name...";
    nameInput.style.cssText = `
      width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #444;
      background: #111; color: #fff; font-size: 14px; margin-bottom: 14px;
      box-sizing: border-box; outline: none;
    `;
    nameInput.addEventListener("focus", () => { nameInput.style.borderColor = "#4a6cf7"; });
    nameInput.addEventListener("blur", () => { nameInput.style.borderColor = "#444"; });
    card.appendChild(nameInput);

    // Breadcrumb
    const breadcrumb = document.createElement("div");
    breadcrumb.style.cssText = `
      font-size: 12px; color: #888; margin-bottom: 8px;
      display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
    `;
    card.appendChild(breadcrumb);

    // Folder list container
    const listContainer = document.createElement("div");
    listContainer.style.cssText = `
      max-height: 260px; overflow-y: auto; border: 1px solid #333;
      border-radius: 6px; background: #111; margin-bottom: 14px;
    `;
    card.appendChild(listContainer);

    // Status
    const status = document.createElement("div");
    status.style.cssText = "font-size: 12px; color: #888; margin-bottom: 14px; min-height: 16px;";
    card.appendChild(status);

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display: flex; gap: 10px; justify-content: flex-end;";

    const cancelBtn = makeButton("Cancel", "#333", "#aaa");
    cancelBtn.addEventListener("click", () => overlay.remove());

    const backBtn = makeButton("Back", "#333", "#aaa");
    backBtn.addEventListener("click", () => showRobotQuestion(card, overlay));

    const createBtn = makeButton("Create here", "#4a6cf7");
    createBtn.style.display = "none"; // hidden until folder selected

    btnRow.appendChild(backBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(createBtn);
    card.appendChild(btnRow);

    // Navigation state
    const pathStack = []; // [{ name, id }]
    let currentFolderId = null;

    function updateBreadcrumb() {
      breadcrumb.innerHTML = "";
      const root = document.createElement("span");
      root.textContent = isRobot ? "Robots" : "Company";
      root.style.cssText = "cursor: pointer; color: #4a6cf7; text-decoration: underline;";
      root.addEventListener("click", () => {
        pathStack.length = 0;
        currentFolderId = null;
        loadFolders();
      });
      breadcrumb.appendChild(root);

      for (let i = 0; i < pathStack.length; i++) {
        const sep = document.createElement("span");
        sep.textContent = " > ";
        sep.style.color = "#555";
        breadcrumb.appendChild(sep);

        const crumb = document.createElement("span");
        crumb.textContent = pathStack[i].name;
        if (i < pathStack.length - 1) {
          crumb.style.cssText = "cursor: pointer; color: #4a6cf7; text-decoration: underline;";
          const idx = i;
          crumb.addEventListener("click", () => {
            currentFolderId = pathStack[idx].id;
            pathStack.length = idx + 1;
            loadFolders();
          });
        } else {
          crumb.style.color = "#ccc";
        }
        breadcrumb.appendChild(crumb);
      }
    }

    function loadFolders() {
      listContainer.innerHTML = "";
      status.textContent = "Loading folders...";
      createBtn.style.display = "inline-block"; // show "Create here" since they can create in current folder

      updateBreadcrumb();

      const msgType = currentFolderId ? "list-subfolders" : (isRobot ? "list-subfolders" : "list-company-folders");
      const msgPayload = currentFolderId
        ? { type: "list-subfolders", folderId: currentFolderId }
        : (isRobot
          ? { type: "list-subfolders", folderId: ROBOTS_FOLDER_ID }
          : { type: "list-company-folders" });

      chrome.runtime.sendMessage(msgPayload, (resp) => {
        if (chrome.runtime.lastError) {
          status.textContent = "Error: " + chrome.runtime.lastError.message;
          return;
        }
        if (resp.error) {
          status.textContent = "Error: " + resp.error;
          return;
        }

        let folders = resp.folders || [];
        // If top-level non-robot, exclude the Robots folder
        if (!isRobot && !currentFolderId) {
          folders = folders.filter(f => f.id !== ROBOTS_FOLDER_ID);
        }

        status.textContent = folders.length === 0
          ? "No subfolders. Click 'Create here' to place the document in the current folder."
          : folders.length + " folder(s)";

        if (folders.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = "No subfolders found";
          empty.style.cssText = "padding: 20px; text-align: center; color: #666;";
          listContainer.appendChild(empty);
          return;
        }

        for (const folder of folders) {
          const row = document.createElement("div");
          row.style.cssText = `
            display: flex; align-items: center; padding: 8px 12px;
            cursor: pointer; border-bottom: 1px solid #222;
            transition: background 0.15s;
          `;
          row.addEventListener("mouseenter", () => { row.style.background = "#222"; });
          row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });

          const icon = document.createElement("span");
          icon.textContent = "\uD83D\uDCC1";
          icon.style.cssText = "margin-right: 10px; font-size: 16px;";

          const name = document.createElement("span");
          name.textContent = folder.name;
          name.style.cssText = "flex: 1; font-size: 14px; color: #ddd;";

          const arrow = document.createElement("span");
          arrow.textContent = "\u25B6";
          arrow.style.cssText = "color: #666; font-size: 10px; margin-left: 8px;";

          row.appendChild(icon);
          row.appendChild(name);
          row.appendChild(arrow);

          // Double-click or arrow click to navigate into
          row.addEventListener("dblclick", () => navigateInto(folder));
          arrow.addEventListener("click", (e) => {
            e.stopPropagation();
            navigateInto(folder);
          });

          listContainer.appendChild(row);
        }
      });
    }

    function navigateInto(folder) {
      pathStack.push({ name: folder.name, id: folder.id });
      currentFolderId = folder.id;
      loadFolders();
    }

    function getTargetFolderId() {
      if (currentFolderId) return currentFolderId;
      return isRobot ? ROBOTS_FOLDER_ID : null;
    }

    createBtn.addEventListener("click", () => {
      const docName = nameInput.value.trim();
      if (!docName) {
        status.textContent = "Please enter a document name.";
        status.style.color = "#ff6b6b";
        nameInput.focus();
        return;
      }
      const targetFolder = getTargetFolderId();
      if (!targetFolder) {
        status.textContent = "Please select a folder first.";
        status.style.color = "#ff6b6b";
        return;
      }

      // Disable buttons, show spinner
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      createBtn.style.opacity = "0.6";
      cancelBtn.disabled = true;
      backBtn.disabled = true;
      status.textContent = "Creating document...";
      status.style.color = "#888";

      chrome.runtime.sendMessage({
        type: "create-doc-in-folder",
        name: docName,
        folderId: targetFolder,
      }, (resp) => {
        if (chrome.runtime.lastError) {
          status.textContent = "Error: " + chrome.runtime.lastError.message;
          status.style.color = "#ff6b6b";
          resetCreateBtn();
          return;
        }
        if (resp.error) {
          status.textContent = "Error: " + resp.error;
          status.style.color = "#ff6b6b";
          resetCreateBtn();
          return;
        }

        status.textContent = "Document created! Redirecting...";
        status.style.color = "#4ade80";
        if (resp.url) {
          setTimeout(() => {
            overlay.remove();
            window.location.href = resp.url;
          }, 600);
        } else {
          setTimeout(() => overlay.remove(), 1500);
        }
      });

      function resetCreateBtn() {
        createBtn.disabled = false;
        createBtn.textContent = "Create here";
        createBtn.style.opacity = "1";
        cancelBtn.disabled = false;
        backBtn.disabled = false;
      }
    });

    // Initial load
    loadFolders();
    // Focus the name input
    setTimeout(() => nameInput.focus(), 100);
  }

  function makeButton(text, bg, color) {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.style.cssText = `
      padding: 8px 20px; border: none; border-radius: 6px;
      background: ${bg}; color: ${color || "#fff"}; font-size: 14px;
      cursor: pointer; font-weight: 500; transition: opacity 0.15s;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "0.85"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "1"; });
    return btn;
  }

  // Start the interceptor
  initCreateDocInterceptor();

})();
