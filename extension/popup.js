// popup.js — Onshape Tools popup logic

// ---------------------------------------------------------------------------
// Section navigation
// ---------------------------------------------------------------------------

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.getElementById("btnGoDrawing").addEventListener("click", () => showSection("sectionDrawing"));
document.getElementById("btnGoScanner").addEventListener("click", () => {
  showSection("sectionScanner");
  loadLastScanForCurrentDoc();
});
document.getElementById("btnGoViolations").addEventListener("click", () => {
  showSection("sectionViolations");
  loadViolations();
});
document.getElementById("btnBackFromDrawing").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnBackFromScanner").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnBackFromViolations").addEventListener("click", () => showSection("sectionMenu"));

// ---------------------------------------------------------------------------

const ALLOWED_FOLDERS = ["Parts", "Assemblies", "Drawings", "CAD Imports", "Feature Studios"];

// Returns { ok, badgeClass, badgeText, detail } for a scan result
// Missing folders = OK (subset is fine). Only flag EXTRA/unknown folders.
function validateFolders(result) {
  const folders = Object.keys(result.folders || {});
  if (folders.length === 0) {
    // No folders at all — that's fine (root-level tabs only)
    return { ok: true, badgeClass: "badge-ok", badgeText: "no folders", detail: null };
  }
  const extra = folders.filter(f => !ALLOWED_FOLDERS.includes(f));
  if (extra.length === 0) {
    return { ok: true, badgeClass: "badge-ok", badgeText: `${folders.length} folder${folders.length > 1 ? "s" : ""}`, detail: null };
  }
  return {
    ok: false,
    badgeClass: "badge-warn",
    badgeText: `${extra.length} extra`,
    detail: "extra: " + extra.join(", "),
  };
}

// Drawing Creator elements
const $partStudioUrl   = document.getElementById("partStudioUrl");
const $btnCreateDraw   = document.getElementById("btnCreateDrawings");
const $drawLog         = document.getElementById("drawLog");

// Scanner elements
const $btnRescan    = document.getElementById("btnRescan");
const $status       = document.getElementById("status");
const $results      = document.getElementById("results");
const $summaryText  = document.getElementById("summaryText");
const $resultList   = document.getElementById("resultList");

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

chrome.storage.local.get(["partStudioUrl"], (data) => {
  $partStudioUrl.value = data.partStudioUrl || "";
});

// ---------------------------------------------------------------------------
// Save config on change
// ---------------------------------------------------------------------------

$partStudioUrl.addEventListener("change", () => {
  chrome.storage.local.set({ partStudioUrl: $partStudioUrl.value.trim() });
});

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
  chrome.storage.local.set({ partStudioUrl: $partStudioUrl.value.trim() });

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
// Listen for messages from background.js
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "draw-log") {
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
// Load last scan result for current doc (from storage)
// ---------------------------------------------------------------------------

function loadLastScanForCurrentDoc() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    const url = tabs[0].url || "";
    const m = url.match(/\/documents\/([a-f0-9]+)/);
    if (!m) return;
    const docId = m[1];

    chrome.storage.local.get("docScanResults", (data) => {
      const results = data.docScanResults || {};
      if (results[docId]) {
        showSingleResult(results[docId]);
        $summaryText.textContent = "Last scan result";
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Scan This Doc
// ---------------------------------------------------------------------------

$btnRescan.addEventListener("click", () => {
  $btnRescan.disabled = true;
  showStatus("Scanning current doc...");

  chrome.runtime.sendMessage({ type: "rescan-active-tab" }, (response) => {
    $btnRescan.disabled = false;

    if (!response) {
      showStatus("No response -- is this an Onshape document?");
      return;
    }

    if (response.error) {
      showStatus("Error: " + response.error);
      return;
    }

    hideStatus();
    showSingleResult(response);
    $summaryText.textContent = `Scanned: ${response.doc_name || response.doc_id}`;
  });
});

// ---------------------------------------------------------------------------
// Results display
// ---------------------------------------------------------------------------

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
