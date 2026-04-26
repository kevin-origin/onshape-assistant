// popup.js — Onshape Assistant popup logic

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
document.getElementById("btnBackFromDrawing").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnBackFromScanner").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoInterference").addEventListener("click", () => {
  showSection("sectionInterference");
  loadInterferenceResults();
});
document.getElementById("btnBackFromInterference").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoMergePerms").addEventListener("click", () => {
  showSection("sectionMergePerms");
  loadMergePermissions();
});
document.getElementById("btnBackFromMergePerms").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoExport").addEventListener("click", () => showSection("sectionExport"));
document.getElementById("btnBackFromExport").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoExport3D").addEventListener("click", () => showSection("sectionExport3D"));
document.getElementById("btnBackFromExport3D").addEventListener("click", () => showSection("sectionExport"));
document.getElementById("btnGoExportBulk").addEventListener("click", () => {
  showSection("sectionExportBulk");
  loadExportElements();
});
document.getElementById("btnBackFromExportBulk").addEventListener("click", () => showSection("sectionExport"));

// Set merge permissions for current doc — triggers overlay in content script
document.getElementById("btnSetMergePerms").addEventListener("click", () => {
  const btn = document.getElementById("btnSetMergePerms");
  btn.disabled = true;
  btn.textContent = "Opening...";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) { btn.disabled = false; btn.textContent = "Set for This Doc"; return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: "show-merge-owner-popup" }, () => {
      btn.disabled = false;
      btn.textContent = "Set for This Doc";
      // Close popup so user sees the overlay
      window.close();
    });
  });
});

// Bulk Export — collect selections and send to background
document.getElementById("btnBulkExport").addEventListener("click", () => {
  if (!_exportData) return;
  const btn = document.getElementById("btnBulkExport");
  const $status = document.getElementById("exportStatus");
  const $log = document.getElementById("exportLog");
  const { did, wid } = _exportData;

  // Collect selected part studios with their checked parts
  const psMap = {};
  document.querySelectorAll(".part-export-cb:checked").forEach(cb => {
    const psId = cb.dataset.psId;
    const psCb = document.querySelector(`.ps-cb[data-ps-id="${psId}"]`);
    if (!psCb || !psCb.checked) return;
    if (!psMap[psId]) psMap[psId] = { psId, psName: psCb.dataset.psName, parts: [] };
    psMap[psId].parts.push({ partName: cb.dataset.partName, deterministicId: cb.dataset.deterministicId });
  });
  const selectedPartStudios = Object.values(psMap);

  const selectedDrawings = [];
  document.querySelectorAll(".drawing-export-cb:checked").forEach(cb => {
    selectedDrawings.push({ id: cb.dataset.drawingId, name: cb.dataset.drawingName });
  });

  if (selectedPartStudios.length === 0 && selectedDrawings.length === 0) {
    $status.style.display = "block";
    $status.style.color = "#ff6b6b";
    $status.textContent = "Nothing selected to export";
    return;
  }

  btn.disabled = true;
  $log.style.display = "block";
  $log.innerHTML = "";
  $status.style.display = "block";
  $status.style.color = "#7ec8e3";
  $status.textContent = "Exporting...";

  chrome.runtime.sendMessage({ type: "bulk-export", did, wid, selectedPartStudios, selectedDrawings });
});

// ---------------------------------------------------------------------------
// Export element loader + renderer
// ---------------------------------------------------------------------------

function loadExportElements() {
  const $panel = document.getElementById("exportElementsPanel");
  const $status = document.getElementById("exportStatus");
  const $log = document.getElementById("exportLog");
  _exportData = null;
  $panel.style.display = "none";
  $log.style.display = "none";
  $log.innerHTML = "";
  $status.style.display = "block";
  $status.style.color = "#7ec8e3";
  $status.textContent = "Loading elements...";

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) { $status.textContent = "No active tab"; return; }
    const url = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    const widMatch = url.match(/\/w\/([a-f0-9]+)/);
    if (!docMatch || !widMatch) {
      $status.textContent = "Not an Onshape workspace";
      return;
    }
    _exportData = { did: docMatch[1], wid: widMatch[1] };
    chrome.runtime.sendMessage({ type: "fetch-export-elements", did: docMatch[1], wid: widMatch[1] });
  });
}

function renderExportElements(partStudios, drawings) {
  const $status = document.getElementById("exportStatus");
  const $panel = document.getElementById("exportElementsPanel");
  const $psList = document.getElementById("exportPsList");
  const $drawList = document.getElementById("exportDrawingsList");

  $psList.innerHTML = "";
  $drawList.innerHTML = "";

  const psWithParts = partStudios.filter(ps => ps.flatParts.length > 0);

  if (psWithParts.length === 0 && drawings.length === 0) {
    $status.textContent = "No exportable elements found";
    return;
  }

  $status.style.display = "none";
  $panel.style.display = "block";

  // Part Studios
  if (psWithParts.length === 0) {
    $psList.innerHTML = '<div style="color:#555;font-size:13px;padding:3px 0;">No flat patterns found</div>';
  }
  for (const ps of psWithParts) {
    const psRow = document.createElement("div");
    psRow.className = "part-item";
    const psCb = document.createElement("input");
    psCb.type = "checkbox";
    psCb.checked = true;
    psCb.className = "ps-cb";
    psCb.dataset.psId = ps.id;
    psCb.dataset.psName = ps.name;
    const psLabel = document.createElement("span");
    psLabel.style.fontWeight = "600";
    psLabel.textContent = ps.name;
    psRow.appendChild(psCb);
    psRow.appendChild(psLabel);
    const partContainer = document.createElement("div");
    partContainer.style.paddingLeft = "18px";
    psRow.addEventListener("click", (e) => {
      if (e.target !== psCb) psCb.checked = !psCb.checked;
      partContainer.style.display = psCb.checked ? "block" : "none";
    });
    $psList.appendChild(psRow);

    for (const part of ps.flatParts) {
      const partRow = document.createElement("div");
      partRow.className = "part-item";
      const partCb = document.createElement("input");
      partCb.type = "checkbox";
      partCb.checked = true;
      partCb.className = "part-export-cb";
      partCb.dataset.psId = ps.id;
      partCb.dataset.deterministicId = part.deterministicId;
      partCb.dataset.partName = part.partName;
      const partLabel = document.createElement("span");
      partLabel.textContent = part.partName;
      partRow.appendChild(partCb);
      partRow.appendChild(partLabel);
      partRow.addEventListener("click", (e) => { if (e.target !== partCb) partCb.checked = !partCb.checked; });
      partContainer.appendChild(partRow);
    }
    $psList.appendChild(partContainer);
  }

  // Drawings
  if (drawings.length === 0) {
    $drawList.innerHTML = '<div style="color:#555;font-size:13px;padding:3px 0;">No drawings found</div>';
  }
  for (const d of drawings) {
    const row = document.createElement("div");
    row.className = "part-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.className = "drawing-export-cb";
    cb.dataset.drawingId = d.id;
    cb.dataset.drawingName = d.name;
    const label = document.createElement("span");
    label.textContent = d.name;
    row.appendChild(cb);
    row.appendChild(label);
    row.addEventListener("click", (e) => { if (e.target !== cb) cb.checked = !cb.checked; });
    $drawList.appendChild(row);
  }
}

// Generate Folders — opens folder creation overlay in content script
document.getElementById("btnGenerateFolders").addEventListener("click", () => {
  const btn = document.getElementById("btnGenerateFolders");
  btn.disabled = true;
  btn.textContent = "Opening...";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) { btn.disabled = false; btn.textContent = "Generate Folders"; return; }
    chrome.tabs.sendMessage(tabs[0].id, { type: "generate-folders" }, () => {
      btn.disabled = false;
      btn.textContent = "Generate Folders";
      window.close();
    });
  });
});

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
    }
  }
  // Also check URL params (fallback when opened as tab)
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  if (section === "scanner") { showSection("sectionScanner"); loadLastScanForCurrentDoc(); }
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
  let folderAssemblyFlagged = false;
  for (const [name, data] of Object.entries(folderData)) {
    const count = (typeof data === "object" && data.assemblies) || 0;
    if (count > 1) {
      details.push({ text: `${count} assemblies detected, please use only 1 assembly with multiple configurations instead.`, color: "#ff6b6b" });
      folderAssemblyFlagged = true;
    }
  }

  // Fallback: check totalAssemblies (catches assemblies at root level or non-standard folders)
  if (!folderAssemblyFlagged && result.totalAssemblies > 1) {
    details.push({ text: `${result.totalAssemblies} assemblies detected (including root level), please use only 1 assembly with multiple configurations instead.`, color: "#ff6b6b" });
  }

  if (folders.length === 0) {
    return { ok: false, badgeClass: "badge-err", badgeText: "No folders", details };
  }
  if (details.length === 0) {
    const label = `${folders.length} folder${folders.length > 1 ? "s" : ""}`;
    return { ok: true, badgeClass: "badge-ok", badgeText: label, details };
  }
  return {
    ok: false,
    badgeClass: "badge-err",
    badgeText: "Issues",
    details,
  };
}

// ---------------------------------------------------------------------------
// Export 3D (STEP / STL)
// ---------------------------------------------------------------------------

let _export3dFormat = "STEP";
let _export3dParts  = [];

const $btnFormatStep  = document.getElementById("btnFormatStep");
const $btnFormatStl   = document.getElementById("btnFormatStl");

function setExport3dFormat(fmt) {
  _export3dFormat = fmt;
  $btnFormatStep.style.background = fmt === "STEP" ? "#1b4332" : "#1a1a40";
  $btnFormatStep.style.color      = fmt === "STEP" ? "#95d5b2" : "#7ec8e3";
  $btnFormatStep.style.border     = fmt === "STEP" ? "none" : "1px solid #333";
  $btnFormatStl.style.background  = fmt === "STL"  ? "#1b4332" : "#1a1a40";
  $btnFormatStl.style.color       = fmt === "STL"  ? "#95d5b2" : "#7ec8e3";
  $btnFormatStl.style.border      = fmt === "STL"  ? "none" : "1px solid #333";
}

$btnFormatStep.addEventListener("click", () => setExport3dFormat("STEP"));
$btnFormatStl.addEventListener("click",  () => setExport3dFormat("STL"));

function append3dLog(text, cls) {
  const $log = document.getElementById("export3dLog");
  $log.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = text;
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

document.getElementById("btnLoadExport3dParts").addEventListener("click", () => {
  const url = document.getElementById("export3dUrl").value.trim();
  if (!url || !url.includes("cad.onshape.com/documents/")) {
    append3dLog("Enter a valid Part Studio URL", "log-err");
    return;
  }
  const btn = document.getElementById("btnLoadExport3dParts");
  btn.disabled = true;
  document.getElementById("export3dPartPanel").style.display = "none";
  document.getElementById("export3dLog").style.display = "none";
  document.getElementById("export3dLog").innerHTML = "";
  append3dLog("Fetching parts...");

  chrome.runtime.sendMessage({ type: "fetch-parts", url }, (response) => {
    btn.disabled = false;
    if (!response || response.error) {
      append3dLog(response ? response.error : "No response from background", "log-err");
      return;
    }
    _export3dParts = response.parts || [];
    if (_export3dParts.length === 0) {
      append3dLog("No parts found", "log-err");
      return;
    }
    document.getElementById("export3dLog").style.display = "none";
    document.getElementById("export3dLog").innerHTML = "";

    const $list = document.getElementById("export3dPartList");
    $list.innerHTML = "";
    document.getElementById("chkExport3dSelectAll").checked = true;
    _export3dParts.forEach((part, i) => {
      const div = document.createElement("div");
      div.className = "part-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.className = "export3d-part-cb";
      cb.dataset.index = i;
      const label = document.createElement("span");
      label.textContent = part.name || `Part ${i + 1}`;
      div.appendChild(cb);
      div.appendChild(label);
      div.addEventListener("click", (e) => {
        if (e.target !== cb) cb.checked = !cb.checked;
        const all = $list.querySelectorAll(".export3d-part-cb");
        document.getElementById("chkExport3dSelectAll").checked = Array.from(all).every(c => c.checked);
      });
      $list.appendChild(div);
    });
    document.getElementById("export3dPartPanel").style.display = "block";
  });
});

document.getElementById("chkExport3dSelectAll").addEventListener("change", (e) => {
  document.getElementById("export3dPartList").querySelectorAll(".export3d-part-cb")
    .forEach(cb => cb.checked = e.target.checked);
});

document.getElementById("btnRunExport3d").addEventListener("click", () => {
  const url = document.getElementById("export3dUrl").value.trim();
  const boxes = document.getElementById("export3dPartList").querySelectorAll(".export3d-part-cb:checked");
  const selectedParts = Array.from(boxes).map(cb => _export3dParts[parseInt(cb.dataset.index)]);
  if (selectedParts.length === 0) { append3dLog("No parts selected", "log-err"); return; }

  const btn = document.getElementById("btnRunExport3d");
  btn.disabled = true;
  document.getElementById("export3dLog").innerHTML = "";
  append3dLog(`Exporting ${selectedParts.length} part(s) as ${_export3dFormat}...`);

  chrome.runtime.sendMessage({ type: "export-3d-parts", url, format: _export3dFormat, selectedParts }, (response) => {
    if (!response) { append3dLog("No response from background", "log-err"); btn.disabled = false; }
  });
});

// ---------------------------------------------------------------------------
// Drawing Creator elements
const $partStudioUrl   = document.getElementById("partStudioUrl");
const $btnCreateDraw   = document.getElementById("btnCreateDrawings");
const $drawLog         = document.getElementById("drawLog");
const $partSelectPanel = document.getElementById("partSelectPanel");
const $partList        = document.getElementById("partList");
const $chkSelectAll    = document.getElementById("chkSelectAll");
const $btnConfirm      = document.getElementById("btnConfirmDrawings");
const $btnCancel       = document.getElementById("btnCancelDrawings");

// Cached parts list after fetch
let _fetchedParts = [];
// Cached export element data { did, wid }
let _exportData = null;

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

  $partSelectPanel.style.display = "none";
  $drawLog.innerHTML = "";
  $btnCreateDraw.disabled = true;

  appendDrawLog(`Creating drawings for ${selectedParts.length} part(s)...`);

  chrome.runtime.sendMessage({
    type: "create-drawings",
    url: $partStudioUrl.value.trim(),
    selectedParts: selectedParts,
    weldment: null,
  }, (response) => {
    if (!response) {
      appendDrawLog("No response from background -- try reloading extension", "log-err");
      $btnCreateDraw.disabled = false;
    }
  });
});

// ---------------------------------------------------------------------------
// Notes panel
// ---------------------------------------------------------------------------

let _notesDrawings = [];

document.getElementById("btnLoadDrawings").addEventListener("click", () => {
  const $items  = document.getElementById("notesDrawingItems");
  const $list   = document.getElementById("notesDrawingList");
  const $status = document.getElementById("notesDrawingStatus");
  $list.style.display   = "none";
  $items.innerHTML      = "";
  $status.style.display = "block";
  $status.textContent   = "Loading drawings...";
  $status.style.color   = "#666";
  _notesDrawings = [];

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) { $status.textContent = "No active tab"; return; }
    const url      = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    const widMatch = url.match(/\/w\/([a-f0-9]+)/);
    if (!docMatch || !widMatch) { $status.textContent = "Not an Onshape workspace"; return; }

    chrome.runtime.sendMessage({
      type: "fetch-drawing-elements",
      did: docMatch[1],
      wid: widMatch[1],
    }, (response) => {
      if (!response || response.error) {
        $status.textContent = response ? response.error : "No response";
        $status.style.color = "#ff6b6b";
        return;
      }
      _notesDrawings = response.drawings || [];
      if (_notesDrawings.length === 0) {
        $status.textContent = "No drawings found in this doc";
        return;
      }
      $status.style.display = "none";
      $list.style.display   = "block";

      _notesDrawings.forEach((d, i) => {
        const item = document.createElement("div");
        item.className = "notes-drawing-item";

        const header = document.createElement("div");
        header.className = "notes-drawing-header";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.className = "notes-drawing-cb";
        cb.dataset.index = i;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = d.name;

        header.appendChild(cb);
        header.appendChild(nameSpan);
        header.addEventListener("click", (e) => { if (e.target !== cb) cb.checked = !cb.checked; });

        const textInput = document.createElement("input");
        textInput.type = "text";
        textInput.className = "note-text-input";
        textInput.placeholder = "Note text...";

        item.appendChild(header);
        item.appendChild(textInput);
        $items.appendChild(item);
      });
    });
  });
});

document.getElementById("chkSelectAllDrawings").addEventListener("change", (e) => {
  document.querySelectorAll(".notes-drawing-cb").forEach(cb => cb.checked = e.target.checked);
});

document.getElementById("btnApplyNotes").addEventListener("click", () => {
  const $log = document.getElementById("notesLog");
  const $btn = document.getElementById("btnApplyNotes");
  const height = parseFloat(document.getElementById("noteTextHeight").value) || 4.0;

  const drawings = [];
  document.querySelectorAll("#notesDrawingItems .notes-drawing-item").forEach((item, i) => {
    const cb   = item.querySelector(".notes-drawing-cb");
    const text = item.querySelector(".note-text-input").value.trim();
    if (cb && cb.checked && text) {
      drawings.push({ ...(_notesDrawings[parseInt(cb.dataset.index)]), text });
    }
  });

  if (drawings.length === 0) {
    $log.style.display = "block";
    appendNotesLog("Select drawings and fill in note text", "log-err");
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    const url      = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    const widMatch = url.match(/\/w\/([a-f0-9]+)/);
    if (!docMatch || !widMatch) {
      appendNotesLog("Not an Onshape workspace", "log-err");
      $log.style.display = "block";
      return;
    }

    $log.innerHTML     = "";
    $log.style.display = "block";
    $btn.disabled      = true;
    appendNotesLog(`Applying notes to ${drawings.length} drawing(s)...`);

    chrome.runtime.sendMessage({
      type: "apply-drawing-notes",
      did: docMatch[1],
      wid: widMatch[1],
      drawings,
      height,
    });
  });
});

function appendNotesLog(text, cls) {
  const $log = document.getElementById("notesLog");
  $log.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = text;
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

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
  } else if (msg.type === "export-elements-loaded") {
    renderExportElements(msg.partStudios || [], msg.drawings || []);
  } else if (msg.type === "export-elements-error") {
    const $status = document.getElementById("exportStatus");
    $status.style.display = "block";
    $status.style.color = "#ff6b6b";
    $status.textContent = "Error: " + msg.error;
  } else if (msg.type === "bulk-export-progress") {
    const $log = document.getElementById("exportLog");
    $log.style.display = "block";
    const line = document.createElement("div");
    line.className = "log-line";
    line.textContent = msg.message;
    $log.appendChild(line);
    $log.scrollTop = $log.scrollHeight;
  } else if (msg.type === "export-3d-progress") {
    append3dLog(msg.message, msg.cls);
  } else if (msg.type === "export-3d-done") {
    document.getElementById("btnRunExport3d").disabled = false;
    if (msg.error) {
      append3dLog("Error: " + msg.error, "log-err");
    } else {
      (msg.files || []).forEach(f => {
        const a = document.createElement("a");
        a.href = "data:application/octet-stream;base64," + f.base64;
        a.download = f.name;
        a.click();
      });
      append3dLog(`Done — ${(msg.files || []).length} file(s) downloaded`, "log-ok");
    }
  } else if (msg.type === "notes-progress") {
    appendNotesLog(msg.message, msg.cls);
  } else if (msg.type === "notes-done") {
    document.getElementById("btnApplyNotes").disabled = false;
    appendNotesLog("Done", "log-ok");
  } else if (msg.type === "bulk-export-done") {
    const btn = document.getElementById("btnBulkExport");
    const $status = document.getElementById("exportStatus");
    btn.disabled = false;
    $status.style.display = "block";
    if (msg.error) {
      $status.textContent = "Error: " + msg.error;
      $status.style.color = "#ff6b6b";
    } else {
      $status.textContent = "Download ready";
      $status.style.color = "#95d5b2";
      // Trigger download via data URL
      const a = document.createElement("a");
      a.href = "data:application/zip;base64," + msg.zipBase64;
      a.download = msg.filename || "export.zip";
      a.click();
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
// Doc Permissions display + edit
// ---------------------------------------------------------------------------

function loadMergePermissions() {
  // Only show merge permissions for the currently open document
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const $list = document.getElementById("mergePermsList");
    const $none = document.getElementById("noMergePerms");
    $list.innerHTML = "";

    if (tabs.length === 0) {
      $none.textContent = "No active tab.";
      $none.style.display = "block";
      return;
    }
    const url = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    if (!docMatch) {
      $none.textContent = "Not an Onshape document.";
      $none.style.display = "block";
      return;
    }
    const docId = docMatch[1];

    // Fetch session user and merge permissions in parallel (backend + local fallback)
    Promise.all([
      new Promise(resolve => chrome.runtime.sendMessage({ type: "get-session-user" }, resolve)),
      new Promise(resolve => chrome.runtime.sendMessage({ type: "get-merge-perms", docId }, resolve)),
    ]).then(([sessionUser, permsResp]) => {
      const doc = (permsResp && permsResp.exists) ? permsResp.data : null;

      if (!doc) {
        $none.textContent = "No merge permissions set for this document.";
        $none.style.display = "block";
        return;
      }
      $none.style.display = "none";

      const owners = doc.owners || [];
      const isOwner = sessionUser && owners.some(o => o.email === sessionUser.email);

      // Doc header
      const header = document.createElement("div");
      header.className = "result-item";
      const nameSpan = document.createElement("span");
      nameSpan.className = "result-name";
      nameSpan.textContent = doc.docName || docId;
      header.appendChild(nameSpan);
      const badge = document.createElement("span");
      badge.className = "badge badge-ok";
      badge.textContent = `${owners.length} owner${owners.length !== 1 ? "s" : ""}`;
      header.appendChild(badge);
      $list.appendChild(header);

      // Owners list
      const ownerContainer = document.createElement("div");
      ownerContainer.id = `merge-owners-${docId}`;
      for (const owner of owners) {
        const line = document.createElement("div");
        line.className = "result-item";
        line.style.paddingLeft = "20px";
        line.style.color = "#95d5b2";
        line.textContent = `${owner.name} (${owner.email})`;
        ownerContainer.appendChild(line);
      }
      $list.appendChild(ownerContainer);

      // Timestamp
      if (doc.updatedAt) {
        const ts = document.createElement("div");
        ts.style.cssText = "font-size:10px;color:#555;padding:0 0 6px 20px;";
        ts.textContent = "Updated: " + doc.updatedAt;
        $list.appendChild(ts);
      }
    });
  });
}

