// popup.js — Onshape Tab Folder Scanner popup logic

const $folderIds    = document.getElementById("folderIds");
const $dashboardUrl = document.getElementById("dashboardUrl");
const $btnScan      = document.getElementById("btnScan");
const $btnRescan    = document.getElementById("btnRescan");
const $status       = document.getElementById("status");
const $results      = document.getElementById("results");
const $summaryText  = document.getElementById("summaryText");
const $resultList   = document.getElementById("resultList");

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

chrome.storage.local.get(["folderIds", "dashboardUrl", "lastScanSummary"], (data) => {
  $folderIds.value    = (data.folderIds || []).join("\n");
  $dashboardUrl.value = data.dashboardUrl || "";

  if (data.lastScanSummary) {
    showSummary(data.lastScanSummary);
  }
});

// ---------------------------------------------------------------------------
// Save config on change
// ---------------------------------------------------------------------------

function saveConfig() {
  const ids = $folderIds.value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  chrome.storage.local.set({
    folderIds: ids,
    dashboardUrl: $dashboardUrl.value.trim(),
  });
}

$folderIds.addEventListener("change", saveConfig);
$dashboardUrl.addEventListener("change", saveConfig);

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function showStatus(msg) {
  $status.style.display = "block";
  $status.textContent = msg;
}

function hideStatus() {
  $status.style.display = "none";
}

// ---------------------------------------------------------------------------
// Scan All
// ---------------------------------------------------------------------------

$btnScan.addEventListener("click", () => {
  saveConfig();

  const ids = $folderIds.value.split("\n").map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    showStatus("Enter at least one folder ID");
    return;
  }

  const dashboardUrl = $dashboardUrl.value.trim();
  if (!dashboardUrl) {
    showStatus("Enter a dashboard URL");
    return;
  }

  $btnScan.disabled = true;
  $btnRescan.disabled = true;
  showStatus("Starting bulk scan...");

  chrome.runtime.sendMessage(
    {
      type: "start-bulk-scan",
      folderIds: ids,
      dashboardUrl: dashboardUrl,
    },
    (response) => {
      $btnScan.disabled = false;
      $btnRescan.disabled = false;

      if (!response) {
        showStatus("No response from background — try reloading extension");
        return;
      }

      if (response.error) {
        showStatus("Error: " + response.error);
        return;
      }

      showSummary(response);
    }
  );
});

// ---------------------------------------------------------------------------
// Listen for progress updates from background.js
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "scan-progress") {
    showStatus(msg.message);
  }
});

// ---------------------------------------------------------------------------
// Re-scan active tab
// ---------------------------------------------------------------------------

$btnRescan.addEventListener("click", () => {
  $btnRescan.disabled = true;
  showStatus("Scanning current doc...");

  chrome.runtime.sendMessage({ type: "rescan-active-tab" }, (response) => {
    $btnRescan.disabled = false;

    if (!response) {
      showStatus("No response — is this an Onshape document?");
      return;
    }

    if (response.error) {
      showStatus("Error: " + response.error);
      return;
    }

    showStatus(`Scanned: ${response.doc_name || response.doc_id}`);
    showSingleResult(response);
  });
});

// ---------------------------------------------------------------------------
// Results display
// ---------------------------------------------------------------------------

function showSummary(data) {
  $results.style.display = "block";

  const timestamp = data.timestamp || "";
  const total     = data.total || 0;
  const scanned   = data.scanned || 0;
  const errors    = data.errors || 0;

  let text = `${scanned} docs scanned`;
  if (errors > 0) text += `, ${errors} errors`;
  if (timestamp) text += ` -- ${timestamp}`;
  $summaryText.textContent = text;

  $resultList.innerHTML = "";
  const results = data.results || [];

  for (const r of results) {
    const folderCount = Object.keys(r.folders || {}).length;
    const el = document.createElement("div");
    el.className = "result-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "result-name";
    nameSpan.textContent = r.doc_name || r.doc_id;
    el.appendChild(nameSpan);

    const badge = document.createElement("span");
    if (folderCount > 0) {
      badge.className = "badge badge-ok";
      badge.textContent = `${folderCount} folder${folderCount > 1 ? "s" : ""}`;
    } else {
      badge.className = "badge badge-warn";
      badge.textContent = "no folders";
    }
    el.appendChild(badge);

    $resultList.appendChild(el);
  }

  // Show errors
  const errList = data.errors_list || data.errors_detail || [];
  // errors might just be a count from the summary
  if (typeof data.errors !== "number") return;

  hideStatus();
}

function showSingleResult(result) {
  $results.style.display = "block";
  $resultList.innerHTML = "";

  const folderCount = Object.keys(result.folders || {}).length;
  const el = document.createElement("div");
  el.className = "result-item";

  const nameSpan = document.createElement("span");
  nameSpan.className = "result-name";
  nameSpan.textContent = result.doc_name || result.doc_id;
  el.appendChild(nameSpan);

  const badge = document.createElement("span");
  if (folderCount > 0) {
    badge.className = "badge badge-ok";
    badge.textContent = `${folderCount} folder${folderCount > 1 ? "s" : ""}`;
  } else {
    badge.className = "badge badge-warn";
    badge.textContent = "no folders";
  }
  el.appendChild(badge);

  $resultList.appendChild(el);

  // Show folder details
  for (const [folder, tabs] of Object.entries(result.folders || {})) {
    const detail = document.createElement("div");
    detail.className = "result-item";
    detail.style.paddingLeft = "20px";
    detail.style.fontSize = "10px";
    detail.style.color = "#888";
    detail.textContent = `${folder}: ${tabs.join(", ")}`;
    $resultList.appendChild(detail);
  }

  if (result.root_tabs && result.root_tabs.length > 0) {
    const rootEl = document.createElement("div");
    rootEl.className = "result-item";
    rootEl.style.paddingLeft = "20px";
    rootEl.style.fontSize = "10px";
    rootEl.style.color = "#888";
    rootEl.textContent = `Root tabs: ${result.root_tabs.join(", ")}`;
    $resultList.appendChild(rootEl);
  }
}
