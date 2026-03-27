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

// Interference Check button
document.getElementById("btnRunInterference").addEventListener("click", () => {
  const btn = document.getElementById("btnRunInterference");
  btn.disabled = true;
  btn.querySelector(".menu-desc").textContent = "Running interference check...";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) { btn.disabled = false; return; }
    const url = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    const widMatch = url.match(/\/w\/([a-f0-9]+)/);
    if (!docMatch || !widMatch) {
      btn.querySelector(".menu-desc").textContent = "Not an Onshape document";
      btn.disabled = false;
      return;
    }

    chrome.runtime.sendMessage({
      type: "check-interference",
      docId: docMatch[1],
      wid: widMatch[1],
    }, (response) => {
      btn.disabled = false;
      btn.querySelector(".menu-desc").textContent = "Check all assemblies in the current document for interferences";
    });
  });
});

// Check if opened via notification click — navigate to target section
chrome.storage.local.get("popupTargetSection", (data) => {
  if (data.popupTargetSection) {
    chrome.storage.local.remove("popupTargetSection");
    if (data.popupTargetSection === "scanner") {
      showSection("sectionScanner");
      loadLastScanForCurrentDoc();
    } else if (data.popupTargetSection === "violations") {
      showSection("sectionViolations");
      loadViolations();
    }
  }
  // Also check URL params (fallback when opened as tab)
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  if (section === "scanner") { showSection("sectionScanner"); loadLastScanForCurrentDoc(); }
  else if (section === "violations") { showSection("sectionViolations"); loadViolations(); }
});

// ---------------------------------------------------------------------------

const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];

// Returns { ok, badgeClass, badgeText, details[] } for a scan result
// Flags: illegal tabs (extra folders + root tabs), >1 assembly per folder
function validateFolders(result) {
  const folderData = result.folders || {};
  const folders = Object.keys(folderData);
  const rootTabs = result.root_tabs || [];
  const extra = folders.filter(f => !ALLOWED_FOLDERS.includes(f));
  const illegal = [...extra, ...rootTabs];
  const details = [];

  if (illegal.length > 0) {
    details.push({ text: "Illegal tabs: " + illegal.join(", "), color: "#ff6b6b" });
  }

  // Check assembly counts per folder (>1 not allowed)
  for (const [name, data] of Object.entries(folderData)) {
    const count = (typeof data === "object" && data.assemblies) || 0;
    if (count > 1) {
      details.push({ text: `${count} assemblies detected, please use only 1 assembly with multiple configurations instead.`, color: "#ff6b6b" });
    }
  }

  if (details.length === 0) {
    const label = folders.length > 0
      ? `${folders.length} folder${folders.length > 1 ? "s" : ""}`
      : "no folders";
    return { ok: true, badgeClass: "badge-ok", badgeText: label, details };
  }
  return {
    ok: false,
    badgeClass: "badge-err",
    badgeText: "Issues",
    details,
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

  // Show issue details (illegal tabs, assembly violations, etc.)
  for (const d of (v.details || [])) {
    const detailEl = document.createElement("div");
    detailEl.className = "result-item";
    detailEl.style.paddingLeft = "20px";
    detailEl.style.color = d.color || "#ff6b6b";
    detailEl.textContent = d.text;
    $resultList.appendChild(detailEl);
  }

  // Show legal folders as a single line
  const folders = Object.keys(result.folders || {});
  const legalFolders = folders.filter(f => ALLOWED_FOLDERS.includes(f));
  if (legalFolders.length > 0) {
    const legalEl = document.createElement("div");
    legalEl.className = "result-item";
    legalEl.style.paddingLeft = "20px";
    legalEl.style.color = "#95d5b2";
    legalEl.textContent = `Legal tabs: ${legalFolders.join(", ")}`;
    $resultList.appendChild(legalEl);
  }
}

// ---------------------------------------------------------------------------
// Violations display
// ---------------------------------------------------------------------------

function loadViolations() {
  chrome.storage.local.get(["violations", "interferenceResults"], (data) => {
    const violations = data.violations || {};
    const intResults = data.interferenceResults || {};
    const $list = document.getElementById("violationsList");
    const $none = document.getElementById("noViolations");
    $list.innerHTML = "";

    const docIds = Object.keys(violations);

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
        line.style.color = "#ff6b6b";
        line.textContent = item;
        $list.appendChild(line);
      }
    }

    // Interference results for current doc
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      let hasInterference = false;
      if (tabs.length > 0) {
        const url = tabs[0].url || "";
        const m = url.match(/\/documents\/([a-f0-9]+)/);
        if (m) {
          const currentDocId = m[1];
          const docInt = intResults[currentDocId];
          if (docInt && Object.keys(docInt.assemblies || {}).length > 0) {
            hasInterference = true;
            const intHeader = document.createElement("div");
            intHeader.className = "result-item";
            if (docIds.length > 0) intHeader.style.marginTop = "8px";
            const intTitle = document.createElement("span");
            intTitle.className = "result-name";
            intTitle.textContent = "Interference Check";
            intHeader.appendChild(intTitle);
            const intBadge = document.createElement("span");
            intBadge.className = "badge " + (docInt.totalInterferences > 0 ? "badge-warn" : "badge-ok");
            intBadge.textContent = docInt.totalInterferences > 0 ? docInt.totalInterferences : "OK";
            intHeader.appendChild(intBadge);
            const intTs = document.createElement("span");
            intTs.style.cssText = "font-size:9px;color:#666;margin-left:6px;";
            intTs.textContent = docInt.timestamp;
            intHeader.appendChild(intTs);
            $list.appendChild(intHeader);

            for (const [asmName, asmData] of Object.entries(docInt.assemblies)) {
              const line = document.createElement("div");
              line.className = "result-item";
              line.style.paddingLeft = "20px";
              if (asmData.count > 0) {
                line.style.color = "#ffa500";
                const pairs = asmData.interferences.join(", ");
                line.textContent = `${asmName}: ${asmData.count} interference${asmData.count > 1 ? "s" : ""} (${pairs})`;
              } else if (asmData.error) {
                line.style.color = "#ff6b6b";
                line.textContent = `${asmName}: Error - ${asmData.error}`;
              } else {
                line.style.color = "#95d5b2";
                line.textContent = `${asmName}: No interferences`;
              }
              $list.appendChild(line);
            }
          }
        }
      }

      $none.style.display = (docIds.length === 0 && !hasInterference) ? "block" : "none";
    });
  });
}
