// popup.js — Onshape Tools popup logic

// ---------------------------------------------------------------------------
// Section navigation
// ---------------------------------------------------------------------------

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.getElementById("btnGoDrawing").addEventListener("click", () => showSection("sectionDrawing"));
document.getElementById("btnGoScanner").addEventListener("click", () => showSection("sectionScanner"));
document.getElementById("btnGoViolations").addEventListener("click", () => {
  showSection("sectionViolations");
  loadViolations();
});
document.getElementById("btnBackFromDrawing").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnBackFromScanner").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnBackFromViolations").addEventListener("click", () => showSection("sectionMenu"));

// ---------------------------------------------------------------------------

const REQUIRED_FOLDERS = ["Parts", "Assemblies", "Drawings", "CAD Imports"];

// Returns { ok, badgeClass, badgeText, detail } for a scan result
function validateFolders(result) {
  const folders = Object.keys(result.folders || {});
  if (folders.length === 0) {
    return { ok: false, badgeClass: "badge-err", badgeText: "no folders", detail: null };
  }
  const missing = REQUIRED_FOLDERS.filter(f => !folders.includes(f));
  const extra   = folders.filter(f => !REQUIRED_FOLDERS.includes(f));
  if (missing.length === 0 && extra.length === 0) {
    return { ok: true, badgeClass: "badge-ok", badgeText: "4 folders", detail: null };
  }
  let detail = [];
  if (missing.length > 0) detail.push("missing: " + missing.join(", "));
  if (extra.length > 0)   detail.push("extra: " + extra.join(", "));
  return { ok: false, badgeClass: "badge-warn", badgeText: `${folders.length} folder${folders.length > 1 ? "s" : ""}`, detail: detail.join(" | ") };
}

// Drawing Creator elements
const $partStudioUrl   = document.getElementById("partStudioUrl");
const $btnCreateDraw   = document.getElementById("btnCreateDrawings");
const $drawLog         = document.getElementById("drawLog");

// Scanner elements
const $folderIds    = document.getElementById("folderIds");
const $btnScan      = document.getElementById("btnScan");
const $btnRescan    = document.getElementById("btnRescan");
const $status       = document.getElementById("status");
const $results      = document.getElementById("results");
const $summaryText  = document.getElementById("summaryText");
const $resultList   = document.getElementById("resultList");

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

chrome.storage.local.get(["folderIds", "lastScanSummary", "partStudioUrl"], (data) => {
  $folderIds.value    = (data.folderIds || []).join("\n");
  $partStudioUrl.value = data.partStudioUrl || "";

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
    partStudioUrl: $partStudioUrl.value.trim(),
  });
}

$folderIds.addEventListener("change", saveConfig);
$partStudioUrl.addEventListener("change", saveConfig);

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
// Drawing Creator
// ---------------------------------------------------------------------------

function appendDrawLog(text, cls) {
  $drawLog.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = text;
  $drawLog.appendChild(line);
  $drawLog.scrollTop = $drawLog.scrollHeight;
}

$btnCreateDraw.addEventListener("click", () => {
  saveConfig();

  const url = $partStudioUrl.value.trim();
  if (!url || !url.includes("cad.onshape.com/documents/")) {
    appendDrawLog("Enter a valid Part Studio URL", "log-err");
    return;
  }

  $btnCreateDraw.disabled = true;
  $drawLog.innerHTML = "";
  appendDrawLog("Starting drawing creation...");

  chrome.runtime.sendMessage({ type: "create-drawings", url }, (response) => {
    if (!response) {
      appendDrawLog("No response from background -- try reloading extension", "log-err");
      $btnCreateDraw.disabled = false;
    }
  });
});

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

  $btnScan.disabled = true;
  $btnRescan.disabled = true;
  showStatus("Starting bulk scan...");

  chrome.runtime.sendMessage(
    {
      type: "start-bulk-scan",
      folderIds: ids,
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
  } else if (msg.type === "draw-log") {
    appendDrawLog(msg.message, msg.cls);
  } else if (msg.type === "draw-done") {
    $btnCreateDraw.disabled = false;
    if (msg.error) {
      appendDrawLog("Error: " + msg.error, "log-err");
    }
  } else if (msg.type === "violations-updated") {
    if (document.getElementById("sectionViolations").classList.contains("active")) {
      loadViolations();
    }
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
    const v = validateFolders(r);
    const el = document.createElement("div");
    el.className = "result-item";

    const nameSpan = document.createElement("span");
    nameSpan.className = "result-name";
    nameSpan.textContent = r.doc_name || r.doc_id;
    el.appendChild(nameSpan);

    const badge = document.createElement("span");
    badge.className = "badge " + v.badgeClass;
    badge.textContent = v.badgeText;
    el.appendChild(badge);

    $resultList.appendChild(el);

    if (v.detail) {
      const detailEl = document.createElement("div");
      detailEl.className = "result-item";
      detailEl.style.paddingLeft = "20px";
      detailEl.style.fontSize = "10px";
      detailEl.style.color = "#f0c040";
      detailEl.textContent = v.detail;
      $resultList.appendChild(detailEl);
    }
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

  const v = validateFolders(result);
  const el = document.createElement("div");
  el.className = "result-item";

  const nameSpan = document.createElement("span");
  nameSpan.className = "result-name";
  nameSpan.textContent = result.doc_name || result.doc_id;
  el.appendChild(nameSpan);

  const badge = document.createElement("span");
  badge.className = "badge " + v.badgeClass;
  badge.textContent = v.badgeText;
  el.appendChild(badge);

  $resultList.appendChild(el);

  if (v.detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "result-item";
    detailEl.style.paddingLeft = "20px";
    detailEl.style.fontSize = "10px";
    detailEl.style.color = "#f0c040";
    detailEl.textContent = v.detail;
    $resultList.appendChild(detailEl);
  }

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

// ---------------------------------------------------------------------------
// Violations display
// ---------------------------------------------------------------------------

function loadViolations() {
  chrome.storage.local.get("violations", (data) => {
    const violations = data.violations || {};
    const $list = document.getElementById("violationsList");
    const $none = document.getElementById("noViolations");
    $list.innerHTML = "";

    const docIds = Object.keys(violations);
    if (docIds.length === 0) {
      $none.style.display = "block";
      return;
    }
    $none.style.display = "none";

    for (const docId of docIds) {
      const v = violations[docId];
      const header = document.createElement("div");
      header.className = "result-item";
      const nameSpan = document.createElement("span");
      nameSpan.className = "result-name";
      nameSpan.textContent = v.docName;
      header.appendChild(nameSpan);
      const badge = document.createElement("span");
      badge.className = "badge badge-err";
      badge.textContent = v.items.length;
      header.appendChild(badge);
      const ts = document.createElement("span");
      ts.style.cssText = "font-size:9px;color:#666;margin-left:6px;";
      ts.textContent = v.timestamp;
      header.appendChild(ts);
      $list.appendChild(header);

      for (const item of v.items) {
        const line = document.createElement("div");
        line.className = "result-item";
        line.style.paddingLeft = "20px";
        line.style.fontSize = "10px";
        line.style.color = "#ff6b6b";
        line.textContent = item;
        $list.appendChild(line);
      }

    }
  });
}
