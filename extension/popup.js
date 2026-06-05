// popup.js — Onshape Assistant popup logic

// ---------------------------------------------------------------------------
// Section navigation
// ---------------------------------------------------------------------------

function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.getElementById("btnGoDrawing").addEventListener("click", () => {
  showSection("sectionDrawing");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    if (url.includes("cad.onshape.com/documents/") && url.includes("/w/") && url.includes("/e/")) {
      _drawingUrl = url.split("?")[0];
      $btnCreateDraw.click();
    }
  });
});
document.getElementById("btnGoFolderStructure").addEventListener("click", () => {
  showSection("sectionFolderStructure");
  loadLastScanForCurrentDoc();
});
document.getElementById("btnBackFromDrawing").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnBackFromFolderStructure").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoMergePerms").addEventListener("click", () => {
  showSection("sectionMergePerms");
  loadMergePermissions();
});
document.getElementById("btnBackFromMergePerms").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoExport").addEventListener("click", () => showSection("sectionExport"));
document.getElementById("btnBackFromExport").addEventListener("click", () => showSection("sectionMenu"));
document.getElementById("btnGoUrdf").addEventListener("click", () => {
  showSection("sectionUrdf");
  document.getElementById("urdfConfigPanel").style.display = "none";
  document.getElementById("urdfLog").style.display = "none";
  document.getElementById("urdfLog").innerHTML = "";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    if (url.includes("cad.onshape.com/documents/") && url.includes("/w/") && url.includes("/e/")) {
      _urdfUrl = url.split("?")[0];
      loadUrdfConfigs();
    } else {
      appendUrdfLog("Open an Onshape Assembly tab first", "log-err");
    }
  });
});
document.getElementById("btnBackFromUrdf").addEventListener("click", () => showSection("sectionExport"));
document.getElementById("btnGoExport3D").addEventListener("click", () => {
  showSection("sectionExport3D");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    if (url.includes("cad.onshape.com/documents/") && url.includes("/w/") && url.includes("/e/")) {
      _export3dUrl = url.split("?")[0];
      loadExport3dConfigs();
    }
  });
});
document.getElementById("btnBackFromExport3D").addEventListener("click", () => showSection("sectionExport"));
document.getElementById("btnGoExportBulk").addEventListener("click", () => {
  showSection("sectionExportBulk");
  loadExportElements();
});
document.getElementById("btnBackFromExportBulk").addEventListener("click", () => showSection("sectionExport"));
document.getElementById("btnGoBomGen").addEventListener("click", () => {
  showSection("sectionBomGen");
  document.getElementById("bomGenParamPanel").style.display = "none";
  document.getElementById("bomGenLog").style.display = "none";
  document.getElementById("bomGenLog").innerHTML = "";
  document.getElementById("fillBomLog").style.display = "none";
  document.getElementById("fillBomLog").innerHTML = "";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    if (url.includes("cad.onshape.com/documents/") && url.includes("/w/") && url.includes("/e/")) {
      _bomGenUrl = url.split("?")[0];
      loadBomConfigs();
    } else {
      appendBomLog("Open an Onshape Assembly tab first", "log-err");
    }
  });
});
document.getElementById("btnBackFromBomGen").addEventListener("click", () => showSection("sectionExport"));

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
    if (!psMap[psId]) {
      const cfgInputs = document.querySelectorAll(`[data-ps-config-wrap="${psId}"] .ps-config-input`);
      const cfgParts = [];
      cfgInputs.forEach(el => {
        const id = el.dataset.paramId;
        if (!id) return;
        if (el.type === "checkbox") cfgParts.push(`${id}=${el.checked}`);
        else if (el.value.trim()) cfgParts.push(`${id}=${el.value.trim()}`);
      });
      psMap[psId] = { psId, psName: psCb.dataset.psName, parts: [], configuration: cfgParts.join(";") };
    }
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

/**
 * Initiates the export elements flow: verifies a release exists (and is not stale)
 * before requesting part studio + drawing elements from background. Shows an error
 * in the status element if no release or stale revision is detected.
 */
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
    const did = docMatch[1];
    const wid = widMatch[1];
    _exportData = { did, wid };

    chrome.runtime.sendMessage({ type: "check-releases", docId: did }, (releaseResp) => {
      const noReleases = !releaseResp || !releaseResp.hasReleases;
      const staleRevision = !noReleases && !!releaseResp?.staleRevision;
      if (noReleases || staleRevision) {
        $status.style.color = "#f59e0b";
        $status.textContent = noReleases
          ? "Please create a release before exporting."
          : "Changes have been made since the last release. Please create a new release before exporting.";
        return;
      }
      chrome.runtime.sendMessage({ type: "fetch-export-elements", did, wid });
    });
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
    psRow.dataset.psEid = ps.id;
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
    // Config placeholder — populated when ps-configs-loaded fires for this eid
    const cfgWrap = document.createElement("div");
    cfgWrap.dataset.psConfigWrap = ps.id;
    cfgWrap.style.cssText = "padding-left:23px;margin-top:4px;display:none;";
    psRow.appendChild(cfgWrap);
    // Fetch configs for this PS
    chrome.runtime.sendMessage({ type: "fetch-ps-configs", did: _exportData?.did, wid: _exportData?.wid, eid: ps.id });
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

document.getElementById("btnSortTabs").addEventListener("click", () => {
  const btn = document.getElementById("btnSortTabs");
  btn.disabled = true;
  btn.textContent = "Sorting...";
  chrome.runtime.sendMessage({ type: "sort-tabs" }, (r) => {
    btn.disabled = false;
    btn.textContent = "Sort Tabs";
    if (r && r.error) {
      btn.textContent = "Error";
      setTimeout(() => { btn.textContent = "Sort Tabs"; }, 3000);
    }
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
      showSection("sectionFolderStructure");
      loadLastScanForCurrentDoc();
    }
  }
  // Also check URL params (fallback when opened as tab)
  const params = new URLSearchParams(window.location.search);
  const section = params.get("section");
  if (section === "scanner") { showSection("sectionFolderStructure"); loadLastScanForCurrentDoc(); }
});

// ---------------------------------------------------------------------------
// Folder Structure validation — ALLOWED_FOLDERS whitelist and scan result validator
// ---------------------------------------------------------------------------

const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];

/**
 * Validates a folder-structure scan result against compliance rules.
 * @param {object} result - Scan result from content.js (folders, root_tabs, totalAssemblies).
 * @returns {{ ok: boolean, badgeClass: string, badgeText: string, details: {text,color}[] }}
 *   ok=false if any illegal tabs, unlabeled root tabs, or >1 assembly per folder exist.
 */
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
let _export3dUrl    = "";
let _export3dEid    = "";
let _export3dConfig = "";

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

function loadExport3dConfigs() {
  const url = _export3dUrl;
  if (!url || !url.includes("cad.onshape.com/documents/")) {
    append3dLog("Not on a Part Studio tab", "log-err");
    return;
  }
  document.getElementById("export3dConfigPanel").style.display = "none";
  document.getElementById("export3dPartPanel").style.display = "none";
  document.getElementById("export3dLog").style.display = "none";
  document.getElementById("export3dLog").innerHTML = "";
  _export3dConfig = "";
  const eidMatch = url.match(/\/e\/([^/?#]+)/);
  _export3dEid = eidMatch ? eidMatch[1] : "";
  append3dLog("Fetching configuration...");
  chrome.runtime.sendMessage({ type: "fetch-ps-configs", url });
}

function loadExport3dParts() {
  const url = _export3dUrl;
  document.getElementById("export3dPartPanel").style.display = "none";
  document.getElementById("export3dLog").style.display = "none";
  document.getElementById("export3dLog").innerHTML = "";
  append3dLog("Fetching parts...");

  chrome.runtime.sendMessage({ type: "fetch-parts", url, configuration: _export3dConfig }, (response) => {
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
}

document.getElementById("chkExport3dSelectAll").addEventListener("change", (e) => {
  document.getElementById("export3dPartList").querySelectorAll(".export3d-part-cb")
    .forEach(cb => cb.checked = e.target.checked);
});

document.getElementById("btnLoadExport3dParts").addEventListener("click", () => {
  // Collect config values from the config panel
  const configParts = [];
  document.querySelectorAll("#export3dConfigList .ps-config-input").forEach(el => {
    const id = el.dataset.paramId;
    if (!id) return;
    if (el.type === "checkbox") configParts.push(`${id}=${el.checked}`);
    else if (el.value.trim()) configParts.push(`${id}=${el.value.trim()}`);
  });
  _export3dConfig = configParts.join(";");
  loadExport3dParts();
});

document.getElementById("btnRunExport3d").addEventListener("click", () => {
  const url = _export3dUrl;
  const boxes = document.getElementById("export3dPartList").querySelectorAll(".export3d-part-cb:checked");
  const selectedParts = Array.from(boxes).map(cb => _export3dParts[parseInt(cb.dataset.index)]);
  if (selectedParts.length === 0) { append3dLog("No parts selected", "log-err"); return; }

  const btn = document.getElementById("btnRunExport3d");
  btn.disabled = true;
  document.getElementById("export3dLog").innerHTML = "";
  append3dLog(`Exporting ${selectedParts.length} part(s) as ${_export3dFormat}...`);

  chrome.runtime.sendMessage({ type: "export-3d-parts", url, format: _export3dFormat, selectedParts, configuration: _export3dConfig }, (response) => {
    if (!response) { append3dLog("No response from background", "log-err"); btn.disabled = false; }
  });
});

// ---------------------------------------------------------------------------
// URDF Export
// ---------------------------------------------------------------------------

let _urdfUrl = "";
let _urdfKeepalivePort = null;

// Persist mesh quality selection
const $urdfMeshQuality = document.getElementById("urdfMeshQuality");
chrome.storage.local.get("urdfMeshQuality", (data) => {
  if (data.urdfMeshQuality) $urdfMeshQuality.value = data.urdfMeshQuality;
});
$urdfMeshQuality.addEventListener("change", () => {
  chrome.storage.local.set({ urdfMeshQuality: $urdfMeshQuality.value });
});

function appendUrdfLog(text, cls) {
  const $log = document.getElementById("urdfLog");
  $log.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = text;
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

function loadUrdfConfigs() {
  document.getElementById("urdfConfigPanel").style.display = "none";
  document.getElementById("urdfLog").style.display = "none";
  document.getElementById("urdfLog").innerHTML = "";
  appendUrdfLog("Fetching configurations...");
  chrome.runtime.sendMessage({ type: "fetch-urdf-configs", url: _urdfUrl });
}

function renderUrdfConfigs(params) {
  document.getElementById("urdfLog").style.display = "none";
  document.getElementById("urdfLog").innerHTML = "";
  const $list = document.getElementById("urdfConfigList");
  $list.innerHTML = "";
  if (params.length === 0) {
    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;color:#888;margin-bottom:8px;";
    info.textContent = "No configuration — default export will be generated.";
    $list.appendChild(info);
  } else {
    renderPsConfigInputs($list, params, "urdf-config-input");
  }
  document.getElementById("urdfConfigPanel").style.display = "block";
}

document.getElementById("btnGenerateUrdf").addEventListener("click", () => {
  if (!_urdfUrl) {
    appendUrdfLog("Open an Assembly tab first", "log-err");
    return;
  }
  const cfgParts = [];
  document.querySelectorAll(".urdf-config-input").forEach(el => {
    const id = el.dataset.paramId;
    if (!id) return;
    if (el.type === "checkbox") {
      cfgParts.push(`${id}=${el.checked}`);
    } else {
      if (el.tagName === "SELECT" || el.value.trim()) cfgParts.push(`${id}=${el.value.trim()}`);
    }
  });
  const configuration = cfgParts.join(";");
  const btn = document.getElementById("btnGenerateUrdf");
  btn.disabled = true;
  document.getElementById("urdfLog").innerHTML = "";
  appendUrdfLog("Starting URDF export...");
  // Open a persistent port — Chrome keeps the SW alive for the entire duration.
  _urdfKeepalivePort = chrome.runtime.connect({ name: "urdf-export-keepalive" });
  chrome.runtime.sendMessage({ type: "export-urdf", url: _urdfUrl, configuration, meshQuality: $urdfMeshQuality.value }, (response) => {
    if (!response) {
      appendUrdfLog("No response from background — try reloading extension", "log-err");
      btn.disabled = false;
    }
  });
});

// ---------------------------------------------------------------------------
// Drawing Creator elements — state variables and DOM refs for the drawing creation workflow
let _drawingUrl        = "";
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
  const url = _drawingUrl;
  if (!url || !url.includes("cad.onshape.com/documents/")) {
    $drawLog.innerHTML = "";
    appendDrawLog("Open a Part Studio to use the Drawing Generator", "log-err");
    return;
  }

  $btnCreateDraw.disabled = true;
  $drawLog.innerHTML = "";
  $partSelectPanel.style.display = "none";
  appendDrawLog("Fetching parts...");

  chrome.runtime.sendMessage({ type: "fetch-parts", url }, (response) => {
    $btnCreateDraw.disabled = false;
    if (!response || response.notPartStudio) {
      $drawLog.innerHTML = "";
      appendDrawLog("Open a Part Studio to use the Drawing Generator", "log-err");
      return;
    }
    if (response.error) {
      appendDrawLog(response.error, "log-err");
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
    url: _drawingUrl,
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
// Insert BOM Table
// ---------------------------------------------------------------------------

const $btnInsertTable    = document.getElementById("btnInsertTable");
const $insertTableStatus = document.getElementById("insertTableStatus");

$btnInsertTable.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    const widMatch = url.match(/\/w\/([a-f0-9]+)/);
    const eidMatch = url.match(/\/e\/([a-f0-9]+)/);
    if (!docMatch || !widMatch || !eidMatch) {
      $insertTableStatus.style.display = "block";
      $insertTableStatus.style.color = "#ff6b6b";
      $insertTableStatus.textContent = "Open a drawing tab first";
      return;
    }
    $btnInsertTable.disabled = true;
    $insertTableStatus.style.display = "block";
    $insertTableStatus.style.color = "#aaa";
    $insertTableStatus.textContent = "Starting...";
    chrome.runtime.sendMessage({
      type: "insert-bom-table",
      did: docMatch[1],
      wid: widMatch[1],
      eid: eidMatch[1]
    });
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "insert-bom-progress") {
    $insertTableStatus.style.display = "block";
    $insertTableStatus.style.color = "#aaa";
    $insertTableStatus.textContent = msg.message;
    return;
  }
  if (msg.type !== "insert-bom-done") return;
  $btnInsertTable.disabled = false;
  if (msg.error) {
    $insertTableStatus.style.color = "#ff6b6b";
    $insertTableStatus.textContent = "Error: " + msg.error;
  } else {
    $insertTableStatus.style.color = "#95d5b2";
    $insertTableStatus.textContent = msg.result;
  }
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
// BOM Generator
// ---------------------------------------------------------------------------

let _bomGenUrl = "";

function appendBomLog(text, cls) {
  const $log = document.getElementById("bomGenLog");
  $log.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = text;
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

function loadBomConfigs() {
  document.getElementById("bomGenParamPanel").style.display = "none";
  document.getElementById("bomGenLog").style.display = "none";
  document.getElementById("bomGenLog").innerHTML = "";
  appendBomLog("Fetching configurations...");
  chrome.runtime.sendMessage({ type: "fetch-bom-configs", url: _bomGenUrl });
}

/**
 * Renders Part Studio configuration parameter inputs into a container element.
 * Shared by Export 3D, BOM Generator, and URDF Export config panels.
 * @param {HTMLElement} $container - DOM element to render inputs into (cleared first).
 * @param {Array<{name,type,id,values?,defaultValue,unitSpec?}>} params - Config params from background.
 * @param {string} cssClass - CSS class applied to each input (used to collect values on submit).
 */
function renderPsConfigInputs($container, params, cssClass) {
  $container.innerHTML = "";
  params.forEach(param => {
    const row = document.createElement("div");
    row.style.marginBottom = "6px";
    const lbl = document.createElement("div");
    lbl.style.cssText = "font-size:11px;color:#aaa;margin-bottom:2px;";
    lbl.textContent = param.name;
    row.appendChild(lbl);
    if (param.type === "enum") {
      const sel = document.createElement("select");
      sel.dataset.paramId = param.id;
      sel.className = cssClass;
      param.values.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v.value;
        opt.textContent = v.label;
        if (v.value === param.defaultValue) opt.selected = true;
        sel.appendChild(opt);
      });
      row.appendChild(sel);
    } else if (param.type === "boolean") {
      const wrap = document.createElement("label");
      wrap.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;color:#e0e0e0;cursor:pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.paramId = param.id;
      cb.className = cssClass;
      cb.checked = param.defaultValue === "true";
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode("Enabled"));
      row.appendChild(wrap);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.dataset.paramId = param.id;
      inp.className = cssClass;
      inp.value = param.defaultValue || "";
      inp.placeholder = param.unitSpec || "value";
      row.appendChild(inp);
    }
    $container.appendChild(row);
  });
}

function renderBomConfigs(params) {
  document.getElementById("bomGenLog").style.display = "none";
  document.getElementById("bomGenLog").innerHTML = "";
  const $list = document.getElementById("bomGenParamList");
  $list.innerHTML = "";
  if (params.length === 0) {
    const info = document.createElement("div");
    info.style.cssText = "font-size:12px;color:#888;margin-bottom:8px;";
    info.textContent = "No configuration — default BOM will be generated.";
    $list.appendChild(info);
  } else {
    renderPsConfigInputs($list, params, "bom-config-input");
  }
  document.getElementById("bomGenParamPanel").style.display = "block";
}

document.getElementById("btnGenerateBomCsv").addEventListener("click", () => {
  const configParts = [];
  document.querySelectorAll(".bom-config-input").forEach(el => {
    const id = el.dataset.paramId;
    if (!id) return;
    if (el.type === "checkbox") {
      configParts.push(`${id}=${el.checked}`);
    } else {
      if (el.tagName === "SELECT" || el.value.trim()) configParts.push(`${id}=${el.value.trim()}`);
    }
  });
  const configuration = configParts.join(";");
  const btn = document.getElementById("btnGenerateBomCsv");
  btn.disabled = true;
  document.getElementById("bomGenLog").innerHTML = "";
  appendBomLog("Generating BOM...");
  chrome.runtime.sendMessage({ type: "export-bom-csv", url: _bomGenUrl, configuration }, (response) => {
    if (!response) { appendBomLog("No response from background", "log-err"); btn.disabled = false; }
  });
});

function appendFillBomLog(text, cls) {
  const $log = document.getElementById("fillBomLog");
  $log.style.display = "block";
  const line = document.createElement("div");
  line.className = "log-line" + (cls ? " " + cls : "");
  line.textContent = text;
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

document.getElementById("btnFillBom").addEventListener("click", () => {
  const btn = document.getElementById("btnFillBom");
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    const didM = url.match(/\/documents\/([a-f0-9]+)/);
    const widM = url.match(/\/w\/([a-f0-9]+)/);
    if (!didM || !widM) {
      appendFillBomLog("Open an Onshape workspace tab first", "log-err");
      return;
    }
    btn.disabled = true;
    document.getElementById("fillBomLog").innerHTML = "";
    appendFillBomLog("Running Fill BOM...");
    chrome.runtime.sendMessage({ type: "fill-bom", did: didM[1], wid: widM[1] }, (response) => {
      if (!response) { appendFillBomLog("No response from background", "log-err"); btn.disabled = false; }
    });
  });
});

// ---------------------------------------------------------------------------
// Listen for messages from background.js — routes progress/done events to UI update handlers
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
      append3dLog(`Done — ${msg.count || 0} file(s) downloading`, "log-ok");
    }
  } else if (msg.type === "notes-progress") {
    appendNotesLog(msg.message, msg.cls);
  } else if (msg.type === "notes-done") {
    document.getElementById("btnApplyNotes").disabled = false;
    appendNotesLog("Done", "log-ok");
  } else if (msg.type === "urdf-progress") {
    appendUrdfLog(msg.message, msg.cls);
  } else if (msg.type === "urdf-done") {
    if (_urdfKeepalivePort) { _urdfKeepalivePort.disconnect(); _urdfKeepalivePort = null; }
    document.getElementById("btnGenerateUrdf").disabled = false;
    if (msg.error) {
      appendUrdfLog("Error: " + msg.error, "log-err");
    } else {
      appendUrdfLog("Downloaded: " + (msg.zipName || "robot_urdf.zip"), "log-ok");
    }
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
      chrome.downloads.download({ url: "data:application/zip;base64," + msg.zipBase64, filename: msg.filename || "export.zip", saveAs: true });
    }
  } else if (msg.type === "ps-configs-loaded") {
    const { eid, params } = msg;
    if (eid === _export3dEid) {
      // 3D Export: show config panel or skip straight to parts
      document.getElementById("export3dLog").style.display = "none";
      document.getElementById("export3dLog").innerHTML = "";
      if (!params || params.length === 0) {
        loadExport3dParts();
      } else {
        renderPsConfigInputs(document.getElementById("export3dConfigList"), params, "ps-config-input");
        document.getElementById("export3dConfigPanel").style.display = "block";
      }
    } else {
      // Bulk Export: find the cfgWrap for this PS and inject config selects
      const wrap = document.querySelector(`[data-ps-config-wrap="${eid}"]`);
      if (wrap && params && params.length > 0) {
        renderPsConfigInputs(wrap, params, "ps-config-input");
        wrap.style.display = "block";
      }
    }
  } else if (msg.type === "ps-configs-error") {
    // Silently ignore per-PS config errors in bulk export; log for 3D export
    if (msg.eid === _export3dEid) {
      document.getElementById("export3dLog").style.display = "none";
      document.getElementById("export3dLog").innerHTML = "";
      append3dLog("Config fetch failed: " + msg.error + " — loading parts anyway", "log-err");
      loadExport3dParts();
    }
  } else if (msg.type === "urdf-configs-loaded") {
    if (msg.notAssembly) {
      document.getElementById("urdfLog").innerHTML = "";
      appendUrdfLog("Open an Assembly tab to use URDF Export", "log-err");
    } else {
      renderUrdfConfigs(msg.params || []);
    }
  } else if (msg.type === "urdf-configs-error") {
    appendUrdfLog("Error: " + msg.error, "log-err");
  } else if (msg.type === "bom-configs-loaded") {
    if (msg.notAssembly) {
      document.getElementById("bomGenLog").innerHTML = "";
      appendBomLog("Open an Assembly tab to use the BOM Generator", "log-err");
    } else {
      renderBomConfigs(msg.params || []);
    }
  } else if (msg.type === "bom-configs-error") {
    appendBomLog("Error: " + msg.error, "log-err");
  } else if (msg.type === "bom-export-progress") {
    appendBomLog(msg.message, msg.cls);
  } else if (msg.type === "bom-export-done") {
    document.getElementById("btnGenerateBomCsv").disabled = false;
    if (msg.error) {
      appendBomLog("Error: " + msg.error, "log-err");
    } else {
      appendBomLog(`Downloaded: ${msg.filename} (${msg.rows ?? 0} rows)`, "log-ok");
    }
  } else if (msg.type === "fill-bom-progress") {
    appendFillBomLog(msg.message, msg.cls);
  } else if (msg.type === "fill-bom-done") {
    document.getElementById("btnFillBom").disabled = false;
    if (msg.error) {
      appendFillBomLog("Error: " + msg.error, "log-err");
    } else {
      appendFillBomLog("Done.", "log-ok");
    }
  }
});

// ---------------------------------------------------------------------------
// Load last scan result for current doc (from storage)
// ---------------------------------------------------------------------------

/**
 * Reads the cached scan result for the active tab's document from chrome.storage.local
 * and renders it immediately without re-scanning. Shown when the Folder Structure
 * section is opened so prior results are visible without a new scan.
 */
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

/**
 * Renders a single folder-structure scan result into the results panel.
 * Shows a validation badge, issue details (illegal tabs, assembly violations),
 * the list of legal folders, and the tab count usage line.
 * @param {object} result - Scan result object from content.js or storage cache.
 */
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

  // Tab count line
  if (result.totalElements != null) {
    const tabEl = document.createElement("div");
    tabEl.className = "result-item";
    tabEl.style.paddingLeft = "20px";
    tabEl.style.color = result.totalElements >= 40 ? "#ff6b6b"
                      : result.totalElements >= 35 ? "#f0c040"
                      : "#888";
    tabEl.textContent = `This document uses ${result.totalElements}/40 allocated tabs.`;
    $resultList.appendChild(tabEl);
  }
}

// ---------------------------------------------------------------------------
// Doc Permissions display + edit
// ---------------------------------------------------------------------------

/**
 * Loads and renders merge owner permissions for the currently active Onshape document.
 * Fetches session user + doc permissions in parallel; renders owner list with edit controls.
 * Edit controls are shown only if the session user is an owner of the document.
 */
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

// ---------------------------------------------------------------------------
// Doc whitelist toggle — only shown for kevin@origin.tech
// ---------------------------------------------------------------------------

/**
 * Admin-only: renders a toggle button to disable/re-enable the extension for the active doc.
 * Only visible when the session user is kevin@10xconstruction.ai or sai@origin.tech.
 * Sends set-doc-disabled messages to background which updates the Cloudflare KV disabled-docs list.
 */
function initDocWhitelistToggle() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs.length) return;
    const url = tabs[0].url || "";
    const docMatch = url.match(/\/documents\/([a-f0-9]+)/);
    if (!docMatch) return; // not an Onshape doc
    const docId = docMatch[1];

    // Check session user first — only render for Kevin
    chrome.runtime.sendMessage({ type: "get-session-user" }, (user) => {
      if (!user || !["kevin@10xconstruction.ai", "sai@origin.tech"].includes(user.email)) return;

      // Check current disabled state
      chrome.runtime.sendMessage({ type: "check-doc-disabled", docId }, (resp) => {
        const $section = document.getElementById("docWhitelistSection");
        const $status = document.getElementById("docWhitelistStatus");
        const $btn = document.getElementById("btnDocWhitelistToggle");

        function render(disabled) {
          $section.style.display = "block";
          if (disabled) {
            $status.textContent = "Extension DISABLED for this doc";
            $status.style.color = "#ff6b6b";
            $btn.textContent = "Re-enable";
            $btn.style.background = "#3a3a3a";
          } else {
            $status.textContent = "Extension active for this doc";
            $status.style.color = "#aaa";
            $btn.textContent = "Disable for this doc";
            $btn.style.background = "";
          }
        }

        let _disabled = resp?.disabled || false;
        render(_disabled);

        $btn.addEventListener("click", () => {
          $btn.disabled = true;
          const newDisabled = !_disabled;
          chrome.runtime.sendMessage({ type: "set-doc-disabled", docId, disabled: newDisabled }, (result) => {
            $btn.disabled = false;
            if (result?.ok) {
              _disabled = newDisabled;
              render(_disabled);
            } else {
              $status.textContent = "Error: " + (result?.error || "unknown");
              $status.style.color = "#ff6b6b";
            }
          });
        });
      });
    });
  });
}

initDocWhitelistToggle();

