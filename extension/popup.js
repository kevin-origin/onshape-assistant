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
document.getElementById("btnGoInterference").addEventListener("click", () => {
  showSection("sectionInterference");
  loadInterferenceResults();
});
document.getElementById("btnBackFromInterference").addEventListener("click", () => showSection("sectionMenu"));

// Interference Check — run button
document.getElementById("btnRunInterference").addEventListener("click", () => {
  const btn = document.getElementById("btnRunInterference");
  const $status = document.getElementById("interferenceStatus");
  btn.disabled = true;
  $status.style.display = "block";
  $status.textContent = "Running interference check...";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) { btn.disabled = false; $status.textContent = "No active tab"; return; }
    const url = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    const widMatch = url.match(/\/w\/([a-f0-9]+)/);
    if (!docMatch || !widMatch) {
      $status.textContent = "Not an Onshape document";
      btn.disabled = false;
      return;
    }

    chrome.runtime.sendMessage({
      type: "check-interference",
      docId: docMatch[1],
      wid: widMatch[1],
    });
    // Results arrive via storage — poll for completion
    const startTime = Date.now();
    const pollInterval = setInterval(() => {
      if (Date.now() - startTime > 120000) { clearInterval(pollInterval); btn.disabled = false; $status.textContent = "Timed out"; return; }
      chrome.storage.local.get("interferenceResults", (data) => {
        const results = data.interferenceResults || {};
        // Find result for this doc that's newer than when we started
        const docResult = results[docMatch[1]];
        if (docResult) {
          const resultTime = new Date();
          // Check if any assembly has results (not just errors)
          const hasResults = Object.values(docResult.assemblies || {}).some(a => a.count >= 0 && !a.error?.includes("not found"));
          if (hasResults || Object.keys(docResult.assemblies || {}).length > 0) {
            clearInterval(pollInterval);
            btn.disabled = false;
            $status.style.display = "none";
            loadInterferenceResults();
          }
        }
      });
    }, 2000);
  });
});

function loadInterferenceResults() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    const url = tabs[0].url || "";
    const m = url.match(/\/documents\/([a-f0-9]+)/);
    if (!m) return;
    const docId = m[1];

    chrome.storage.local.get("interferenceResults", (data) => {
      const results = data.interferenceResults || {};
      const $list = document.getElementById("interferenceResults");
      const $status = document.getElementById("interferenceStatus");
      $list.innerHTML = "";

      const docResult = results[docId];
      if (!docResult) {
        $list.innerHTML = '<div style="color:#666;font-size:13px;padding:10px 0;">No results yet. Click "Run Check" to scan.</div>';
        return;
      }

      // Timestamp
      const ts = document.createElement("div");
      ts.style.cssText = "font-size:11px;color:#666;margin-bottom:6px;";
      ts.textContent = "Last checked: " + docResult.timestamp;
      $list.appendChild(ts);

      // Summary
      const total = docResult.totalInterferences || 0;
      const summary = document.createElement("div");
      summary.className = "result-item";
      const sumName = document.createElement("span");
      sumName.className = "result-name";
      sumName.textContent = total > 0 ? `${total} interference(s) found` : "No interferences";
      summary.appendChild(sumName);
      const sumBadge = document.createElement("span");
      sumBadge.className = "badge " + (total > 0 ? "badge-warn" : "badge-ok");
      sumBadge.textContent = total > 0 ? total : "OK";
      summary.appendChild(sumBadge);
      $list.appendChild(summary);

      // Per-assembly results
      for (const [asmName, asmData] of Object.entries(docResult.assemblies || {})) {
        const line = document.createElement("div");
        line.className = "result-item";
        line.style.paddingLeft = "20px";
        if (asmData.error) {
          line.style.color = "#ff6b6b";
          line.textContent = `${asmName}: Error - ${asmData.error}`;
        } else if (asmData.count > 0) {
          line.style.color = "#ffa500";
          const pairs = asmData.interferences.join(", ");
          line.textContent = `${asmName}: ${asmData.count} interference${asmData.count > 1 ? "s" : ""} (${pairs})`;
        } else {
          line.style.color = "#95d5b2";
          line.textContent = `${asmName}: No interferences`;
        }
        $list.appendChild(line);
      }

      $status.style.display = "none";
    });
  });
}

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
const $partSelectPanel = document.getElementById("partSelectPanel");
const $partList        = document.getElementById("partList");
const $chkSelectAll    = document.getElementById("chkSelectAll");
const $chkWeldment     = document.getElementById("chkWeldment");
const $weldmentOpts    = document.getElementById("weldmentOpts");
const $weldmentName    = document.getElementById("weldmentName");
const $btnConfirm      = document.getElementById("btnConfirmDrawings");
const $btnCancel       = document.getElementById("btnCancelDrawings");

// Cached parts list after fetch
let _fetchedParts = [];

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

// "Generate Drawings" — fetch parts and show selection panel
$btnCreateDraw.addEventListener("click", () => {
  chrome.storage.local.set({ partStudioUrl: $partStudioUrl.value.trim() });

  const url = $partStudioUrl.value.trim();
  if (!url || !url.includes("cad.onshape.com/documents/")) {
    appendDrawLog("Enter a valid Part Studio URL", "log-err");
    return;
  }

  $btnCreateDraw.disabled = true;
  $drawLog.innerHTML = "";
  $partSelectPanel.style.display = "none";
  appendDrawLog("Fetching parts...");

  chrome.runtime.sendMessage({ type: "fetch-parts", url }, (response) => {
    $btnCreateDraw.disabled = false;
    if (!response || response.error) {
      appendDrawLog(response ? response.error : "No response from background", "log-err");
      return;
    }
    _fetchedParts = response.parts || [];
    if (_fetchedParts.length === 0) {
      appendDrawLog("No parts found in Part Studio", "log-err");
      return;
    }
    $drawLog.style.display = "none";
    $drawLog.innerHTML = "";
    showPartSelection(_fetchedParts);
  });
});

function showPartSelection(parts) {
  $partList.innerHTML = "";
  $chkSelectAll.checked = true;
  $chkWeldment.checked = false;
  $weldmentOpts.classList.remove("active");
  $weldmentName.value = "";

  parts.forEach((part, i) => {
    const div = document.createElement("div");
    div.className = "part-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.index = i;
    cb.className = "part-cb";
    const label = document.createElement("span");
    label.textContent = part.name || `Part ${i + 1}`;
    div.appendChild(cb);
    div.appendChild(label);
    div.addEventListener("click", (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
      updateSelectAll();
    });
    $partList.appendChild(div);
  });

  $partSelectPanel.style.display = "block";
}

function updateSelectAll() {
  const boxes = $partList.querySelectorAll(".part-cb");
  const allChecked = Array.from(boxes).every(cb => cb.checked);
  $chkSelectAll.checked = allChecked;
}

$chkSelectAll.addEventListener("change", () => {
  const checked = $chkSelectAll.checked;
  $partList.querySelectorAll(".part-cb").forEach(cb => cb.checked = checked);
});

$chkWeldment.addEventListener("change", () => {
  $weldmentOpts.classList.toggle("active", $chkWeldment.checked);
});

// Cancel — hide panel
$btnCancel.addEventListener("click", () => {
  $partSelectPanel.style.display = "none";
  _fetchedParts = [];
});

// Confirm — send selected parts to background for drawing creation
$btnConfirm.addEventListener("click", () => {
  const boxes = $partList.querySelectorAll(".part-cb");
  const selectedParts = [];
  boxes.forEach(cb => {
    if (cb.checked) selectedParts.push(_fetchedParts[parseInt(cb.dataset.index)]);
  });

  if (selectedParts.length === 0) {
    appendDrawLog("No parts selected", "log-err");
    $drawLog.style.display = "block";
    return;
  }

  const isWeldment = $chkWeldment.checked;
  const weldmentDrawingName = $weldmentName.value.trim() || "Weldment Drawing";

  $partSelectPanel.style.display = "none";
  $drawLog.innerHTML = "";
  $btnCreateDraw.disabled = true;

  if (isWeldment) {
    appendDrawLog(`Weldment mode: ${selectedParts.length} part(s) -> "${weldmentDrawingName}"`);
    appendDrawLog("Sheet creation not yet implemented -- only individual drawings will be created for now");
  }

  appendDrawLog(`Creating drawings for ${selectedParts.length} part(s)...`);

  chrome.runtime.sendMessage({
    type: "create-drawings",
    url: $partStudioUrl.value.trim(),
    selectedParts: selectedParts,
    weldment: isWeldment ? { name: weldmentDrawingName } : null,
  }, (response) => {
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
  chrome.storage.local.get("violations", (data) => {
    const violations = data.violations || {};
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

    $none.style.display = docIds.length === 0 ? "block" : "none";
  });
}
