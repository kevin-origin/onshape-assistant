// background.js — Onshape Doc Scanner service worker
// Handles rescan requests, stores per-doc scan results, and drawing creation.
// No bulk scan — content.js auto-scans every doc on open.

const ONSHAPE_BASE = "https://cad.onshape.com";
const COMPANY_ID   = "6810c247e7c40668c32816a6";

// Cloudflare Worker sync backend for shared merge permissions
const SYNC_SERVER  = "https://onshape-assistant-sync.artilabot.workers.dev";
const SYNC_API_KEY = "artila-onshape-sync-2026";

async function syncFetch(path, options = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(`${SYNC_SERVER}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": SYNC_API_KEY,
        ...(options.headers || {}),
      },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.log("[Sync] fetch failed:", e.message);
    return null;
  }
}

// Scan timeout per document (ms) — if content.js doesn't respond in time
const DOC_SCAN_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// Session user cache (fetched once per service worker lifetime)
// ---------------------------------------------------------------------------

let _sessionUser = null; // { email, name, id }

async function getSessionUser() {
  if (_sessionUser) return _sessionUser;
  try {
    const data = await onshapeFetch("/api/v10/users/sessioninfo");
    _sessionUser = { email: data.email, name: data.name, id: data.id };
    console.log(`[Session] User: ${_sessionUser.name} (${_sessionUser.email})`);
    return _sessionUser;
  } catch (e) {
    console.error("[Session] Failed to get user info:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Top-level folder walk — walks parentId chain up to the root
// ---------------------------------------------------------------------------

async function getTopLevelFolder(docId) {
  const cacheKey = `topFolder_${docId}`;
  const cached = await new Promise(res => chrome.storage.local.get(cacheKey, res));
  if (cached[cacheKey] && (Date.now() - cached[cacheKey].ts < 3600000)) {
    console.log(`[TopFolder] Cache hit: ${docId} → ${cached[cacheKey].topFolderName}`);
    return cached[cacheKey];
  }

  const doc = await onshapeFetch(`/api/v10/documents/${docId}`);
  let currentId = doc.parentId;
  let topFolder = null;
  let depth = 0;

  while (currentId && depth < 10) {
    const folder = await onshapeFetch(`/api/v10/folders/${currentId}`);
    topFolder = folder;
    if (!folder.parentId || folder.jsonType !== "folder") break;
    currentId = folder.parentId;
    depth++;
  }

  const result = {
    topFolderName: topFolder?.name || null,
    topFolderId: topFolder?.id || null,
    ts: Date.now()
  };
  chrome.storage.local.set({ [cacheKey]: result });
  console.log(`[TopFolder] ${docId} → ${result.topFolderName} (${depth} hops)`);
  return result;
}

// ---------------------------------------------------------------------------
// Kill switch — deactivate extension for specific user accounts
// ---------------------------------------------------------------------------
//
// Three-layer design:
//   Layer 1 — chrome.storage.sync flag: instant on SW start, survives restarts/updates
//   Layer 2 — chrome.storage.local cache: fast offline check, valid for 90 min
//   Layer 3 — remote fetch from Cloudflare Worker: no new build needed to block/unblock
//
// To block a user: PUT /api/blocked-emails on the sync Worker (see onshape-assistant-sync/).
// Takes effect on all instances within one alarm cycle (60 min max).
// ---------------------------------------------------------------------------

const BLOCKED_EMAILS = []; // local fallback only — authoritative list is remote
let _extensionDisabled = false;

function applyKillSwitch(reason) {
  _extensionDisabled = true;
  chrome.action.setPopup({ popup: "" });
  chrome.action.disable();
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#888" });
  console.log(`[KillSwitch] Extension disabled (${reason})`);
}

// Layer 1: chrome.storage.sync flag — instant, offline, survives browser restarts
async function checkKillSwitchSync() {
  try {
    const { killSwitchActive } = await chrome.storage.sync.get("killSwitchActive");
    if (killSwitchActive) {
      applyKillSwitch("sync flag persisted");
      return true;
    }
  } catch (e) {
    console.error("[KillSwitch] sync check failed:", e.message);
  }
  return false;
}

// Layer 2: local cache — fast, offline, valid for 90 minutes
async function checkKillSwitchCache(email) {
  try {
    const { blockedEmailsCache, blockedEmailsFetchedAt } =
      await chrome.storage.local.get(["blockedEmailsCache", "blockedEmailsFetchedAt"]);
    if (!blockedEmailsCache || !blockedEmailsFetchedAt) return false;
    if (Date.now() - blockedEmailsFetchedAt > 90 * 60 * 1000) return false; // stale
    if (email && blockedEmailsCache.map(e => e.toLowerCase()).includes(email.toLowerCase())) {
      await chrome.storage.sync.set({ killSwitchActive: true });
      applyKillSwitch(`${email} — local cache`);
      return true;
    }
  } catch (e) {
    console.error("[KillSwitch] cache check failed:", e.message);
  }
  return false;
}

// Layer 3: remote fetch — block/unblock without a new build
async function refreshAndApplyKillSwitch() {
  try {
    const user = await getSessionUser();
    if (!user?.email) return;
    const email = user.email.toLowerCase();

    let blocked = BLOCKED_EMAILS;
    try {
      const res = await fetch(`${SYNC_SERVER}/api/blocked-emails`,
        { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        blocked = data.blocked || [];
        await chrome.storage.local.set({
          blockedEmailsCache: blocked,
          blockedEmailsFetchedAt: Date.now(),
        });
      }
    } catch (fetchErr) {
      console.warn("[KillSwitch] remote fetch failed, using fallback:", fetchErr.message);
      // Fall through — use local BLOCKED_EMAILS or cached list already in blocked
      const { blockedEmailsCache } = await chrome.storage.local.get("blockedEmailsCache");
      if (blockedEmailsCache) blocked = blockedEmailsCache;
    }

    if (blocked.map(e => e.toLowerCase()).includes(email)) {
      await chrome.storage.sync.set({ killSwitchActive: true });
      applyKillSwitch(`${email} — remote list`);
    } else {
      // Clear sync flag so removing an email from the remote list auto-unblocks within one cycle
      await chrome.storage.sync.remove("killSwitchActive");
      console.log("[KillSwitch] Not blocked:", email);
    }
  } catch (e) {
    console.error("[KillSwitch] remote check failed:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Doc whitelist — per-document disable list, admin-only writes
// ---------------------------------------------------------------------------

async function getDisabledDocs() {
  const { disabledDocsCache, disabledDocsFetchedAt } =
    await chrome.storage.local.get(["disabledDocsCache", "disabledDocsFetchedAt"]);
  if (disabledDocsCache && disabledDocsFetchedAt &&
      Date.now() - disabledDocsFetchedAt < 60 * 60 * 1000) {
    return disabledDocsCache;
  }
  try {
    const res = await fetch(`${SYNC_SERVER}/api/disabled-docs`);
    if (res.ok) {
      const data = await res.json();
      const docs = data.disabledDocs || [];
      await chrome.storage.local.set({ disabledDocsCache: docs, disabledDocsFetchedAt: Date.now() });
      return docs;
    }
  } catch (e) {
    console.warn("[DocWhitelist] fetch failed:", e.message);
  }
  return disabledDocsCache || [];
}

async function isDocDisabled(docId) {
  if (!docId) return false;
  const docs = await getDisabledDocs();
  return docs.includes(docId);
}

// Kill switch only runs on production builds.
// dev branch manifest has "dev_build": true — absent on main.
const IS_PRODUCTION_BUILD = !chrome.runtime.getManifest().dev_build;

// Always force-refresh the disabled-docs list on every SW startup (both dev and production).
// Busting the timestamp ensures we never serve a stale empty list after a doc is added.
chrome.storage.local.remove("disabledDocsFetchedAt", () => getDisabledDocs());

if (IS_PRODUCTION_BUILD) {
  // Startup: Layer 1 (instant, sync) → async Layer 3 (remote, non-blocking)
  checkKillSwitchSync().then(blocked => {
    if (!blocked) refreshAndApplyKillSwitch();
  });

  // Hourly alarm: keep blocked state and disabled-docs list current without waiting for a tab load
  chrome.alarms.create("kill-switch-refresh", { periodInMinutes: 60 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === "kill-switch-refresh") {
      refreshAndApplyKillSwitch();
      // Force-refresh disabled docs by busting cache timestamp first
      chrome.storage.local.remove("disabledDocsFetchedAt", () => getDisabledDocs());
    }
  });
} else {
  // Dev build — clear any persisted disabled state left by a previous production run
  chrome.action.enable();
  chrome.action.setPopup({ popup: "popup.html" });
  chrome.action.setBadgeText({ text: "" });
  chrome.storage.sync.remove("killSwitchActive");
  console.log("[KillSwitch] Dev build — kill switch inactive");
}

// ---------------------------------------------------------------------------
// Team members cache (fetched once per service worker lifetime)
// ---------------------------------------------------------------------------

let _teamMembers = null; // [{ email, name, id }]

async function getTeamMembers() {
  if (_teamMembers) return _teamMembers;
  try {
    const data = await onshapeFetch(`/api/v10/companies/${COMPANY_ID}/users?limit=50`);
    _teamMembers = (data.items || [])
      .map(item => ({
        email: item.user.email,
        name: `${item.user.firstName || ""} ${item.user.lastName || ""}`.trim() || item.user.name,
        id: item.user.id,
      }))
      // Filter out company account — not a real person, should never be a merge owner
      .filter(m => m.id !== COMPANY_ID);
    console.log(`[Team] ${_teamMembers.length} member(s) loaded (company account excluded)`);
    return _teamMembers;
  } catch (e) {
    console.error("[Team] Failed to fetch team members:", e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Onshape API via session cookies (no API keys, zero quota cost)
// ---------------------------------------------------------------------------
// GET requests use the user's browser session cookies (credentials: "include").
// POST requests additionally need the XSRF-TOKEN cookie sent as a header.
// This avoids consuming API key quota entirely — all calls are "free".

async function onshapeFetch(path) {
  const resp = await fetch(`${ONSHAPE_BASE}${path}`, {
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`Onshape ${path}: ${resp.status}`);
  return resp.json();
}

async function getXsrfToken() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: ONSHAPE_BASE, name: "XSRF-TOKEN" }, (cookie) => {
      resolve(cookie ? cookie.value : "");
    });
  });
}

async function onshapePost(path, body) {
  const xsrf = await getXsrfToken();
  const headers = { "Accept": "application/json", "Content-Type": "application/json" };
  if (xsrf) headers["X-XSRF-TOKEN"] = xsrf;
  const resp = await fetch(`${ONSHAPE_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Onshape POST ${path}: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Drawing Creator — create drawings for all parts in a Part Studio
// ---------------------------------------------------------------------------

const DRAWING_TEMPLATE = {
  templateDocumentId: "e4ecea9df80b53b39ab4fa38",
  templateWorkspaceId: "038996d814574f1d1d3b774a",
  templateElementId: "4a80b03c1485e714f587fb61",
};

function broadcastDrawLog(message, cls) {
  console.log(`[Drawing] ${message}`);
  chrome.runtime.sendMessage({ type: "draw-log", message, cls }).catch(() => {});
}

function parsePartStudioUrl(url) {
  // https://cad.onshape.com/documents/{docId}/w/{wid}/e/{eid}
  const m = url.match(/\/documents\/([^/]+)\/w\/([^/]+)\/e\/([^/?#]+)/);
  if (!m) return null;
  return { docId: m[1], wid: m[2], eid: m[3] };
}

// Pick the largest standard drawing scale that fits the part's bounding box.
// Onshape API returns bounding box in meters — multiply by 1000 to get mm.
// AVAILABLE = max mm a view can occupy on an A3 sheet after title block.
// Walk standard scales from largest (2:1) to smallest (1:50); first that fits wins.
function computeScale(bb) {
  const dx = (bb.highX - bb.lowX) * 1000;
  const dy = (bb.highY - bb.lowY) * 1000;
  const dz = (bb.highZ - bb.lowZ) * 1000;
  const largest = Math.max(dx, dy, dz);
  broadcastDrawLog(`  bbox: ${dx.toFixed(1)} x ${dy.toFixed(1)} x ${dz.toFixed(1)} mm, largest=${largest.toFixed(1)}`);
  if (largest < 0.1) {
    broadcastDrawLog("  bbox zero/tiny -- defaulting to 1:5", "log-err");
    return [1, 5];
  }
  const AVAILABLE = 100.0;
  const standards = [[2,1],[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],[1,10],[1,15],[1,20],[1,50]];
  for (const [num, den] of standards) {
    if (largest * num / den <= AVAILABLE) return [num, den];
  }
  return [1, 50];
}

// Poll Onshape drawing modify status until DONE/FAILED/timeout.
// Quirk: Onshape sometimes deletes the status endpoint after completion,
// returning 404. Three consecutive 404s = treat as success (modification finished
// and status was garbage-collected before we could read "DONE").
async function pollModify(docId, wid, drawingEid, mid, timeoutSec = 30) {
  const url = `/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modificationstatus/${mid}`;
  const deadline = Date.now() + timeoutSec * 1000;
  let notFound = 0;
  while (Date.now() < deadline) {
    try {
      const r = await onshapeFetch(url);
      const state = r.requestState || "";
      if (state === "DONE") return true;
      if (state === "FAILED") {
        broadcastDrawLog(`  modify FAILED: ${JSON.stringify(r).slice(0, 200)}`, "log-err");
        return false;
      }
    } catch (e) {
      if (e.message.includes("404")) {
        notFound++;
        if (notFound >= 3) {
          broadcastDrawLog(`  poll 404 x${notFound} -- assuming completed`);
          return true;
        }
      } else {
        broadcastDrawLog(`  poll error: ${e.message}`, "log-err");
        return false;
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  broadcastDrawLog(`  modify timed out after ${timeoutSec}s`, "log-err");
  return false;
}

let _drawingInProgress = false;

async function createDrawingsForUrl(url, selectedParts) {
  _drawingInProgress = true;
  const parsed = parsePartStudioUrl(url);
  if (!parsed) {
    broadcastDrawLog("Invalid Part Studio URL", "log-err");
    chrome.runtime.sendMessage({ type: "draw-done", error: "Invalid URL" }).catch(() => {});
    _drawingInProgress = false;
    return;
  }
  const { docId, wid, eid } = parsed;
  broadcastDrawLog(`Document: ${docId}`);
  broadcastDrawLog(`Workspace: ${wid}`);
  broadcastDrawLog(`Part Studio: ${eid}`);

  // Use pre-selected parts if provided, otherwise fetch (legacy fallback)
  let parts;
  if (selectedParts && selectedParts.length > 0) {
    parts = selectedParts;
    broadcastDrawLog(`${parts.length} part(s) selected`);
  } else {
    broadcastDrawLog("Fetching parts...");
    try {
      parts = await onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${eid}`);
    } catch (e) {
      broadcastDrawLog(`Failed to fetch parts: ${e.message}`, "log-err");
      chrome.runtime.sendMessage({ type: "draw-done", error: e.message }).catch(() => {});
      return;
    }
    if (!parts || parts.length === 0) {
      broadcastDrawLog("No parts found in Part Studio", "log-err");
      chrome.runtime.sendMessage({ type: "draw-done", error: "No parts" }).catch(() => {});
      return;
    }
    broadcastDrawLog(`Found ${parts.length} part(s)`);
  }
  let created = 0;
  let failed = 0;

  // 2. Create drawing for each part
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const partId = part.partId || "";
    const partName = part.name || "Part";
    if (!partId) { failed++; continue; }

    broadcastDrawLog(`[${i + 1}/${parts.length}] ${partName}`);

    // 2a. Create drawing element
    let drawingEid;
    try {
      const createBody = {
        drawingName: `Drawing - ${partName}`,
        elementId: eid,
        partId: partId,
        ...DRAWING_TEMPLATE,
      };
      const resp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/create`, createBody);
      drawingEid = resp.id || "";
      if (!drawingEid) throw new Error("No drawing element ID returned");
      broadcastDrawLog(`  drawing created: ${drawingEid}`);
    } catch (e) {
      broadcastDrawLog(`  create failed: ${e.message}`, "log-err");
      failed++;
      continue;
    }

    // 2b. Wait for drawing to initialize
    await new Promise(r => setTimeout(r, 3000));

    // 2c. Get bounding box + compute scale
    let scale = [1, 5];
    let bb = null;
    try {
      bb = await onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${eid}/partid/${encodeURIComponent(partId)}/boundingboxes?includeHidden=true`);
      scale = computeScale(bb);
    } catch (e) {
      broadcastDrawLog(`  bbox failed (${e.message}), using 1:5`, "log-err");
    }
    broadcastDrawLog(`  scale: ${scale[0]}:${scale[1]}`);

    const ref = { documentId: docId, workspaceId: wid, elementId: eid, partId: partId };

    // Look up flat pattern body (sheet metal parts only)
    let flatRef = null;
    try {
      const insParams = new URLSearchParams({ includeFlattenedBodies: "true", includeParts: "false", elementId: eid });
      const ins = await onshapeFetch(`/api/documents/d/${docId}/w/${wid}/insertables?${insParams}`);
      const fb = (ins.items || []).find(i => i.isFlattenedBody && i.unflattenedPartDeterministicId === partId);
      if (fb) {
        flatRef = { documentId: docId, workspaceId: wid, elementId: eid, partId: fb.deterministicId };
        broadcastDrawLog(`  flat body: ${fb.deterministicId}`);
      }
    } catch(e) {
      broadcastDrawLog(`  flat body lookup: ${e.message}`, "log-err");
    }

    // View positions: center the 4-view block within the usable A3 area.
    // A3 landscape 420×297mm. Onshape position coords: origin top-right, x leftward, y downward (meters).
    // Compute physical layout in mm (Y-up, origin bottom-left), then convert.
    // 2×2 grid layout:  [iso][top]   ← upper row (higher physical y)
    //                   [left][front] ← lower row
    // Col1 = depth D (left/iso), Col2 = W_F (front/top). Row2 = H_F (lower), Row1 = D (upper).
    const SW = 420, SH = 297;  // sheet dimensions mm
    // FALLBACK: defaults for ~60×85×29mm part at 1:10
    const FALLBACK = { front: { x: 0.1855, y: 0.1405 }, top: { x: 0.1855, y: 0.0635 }, left: { x: 0.250, y: 0.1405 }, iso: { x: 0.250, y: 0.0635 } };
    let FRONT_POS_M, TOP_POS_M, LEFT_POS_M, ISO_POS_M;
    if (bb) {
      const s   = scale[0] / scale[1];
      const W_F = (bb.highX - bb.lowX) * 1000 * s;  // front view width on paper (mm)
      const H_F = (bb.highY - bb.lowY) * 1000 * s;  // front view height on paper (mm)
      const D   = (bb.highZ - bb.lowZ) * 1000 * s;  // depth → top view height = left view width (mm)
      const GAP = 20;

      // Usable area in physical coords (mm, Y-up): A3 420×297, title block 65mm + 10mm margin at bottom
      const uL = 10, uR = 410, uBot = 75, uTop = 287;
      const uW = uR - uL, uH = uTop - uBot;   // 400 × 212 mm

      // Block: col1(D) + gap + col2(W_F) wide;  row2(H_F) + gap + row1(D) tall
      const blockW = D + GAP + W_F;
      const blockH = H_F + GAP + D;

      // Center block in usable area (physical coords)
      const bL   = uL   + Math.max(0, (uW - blockW) / 2);
      const bBot = uBot + Math.max(0, (uH - blockH) / 2);

      // Physical positions (mm from bottom-left, Y-up)
      const leftX  = bL + D / 2;                    // col1 center x (left/iso column)
      const frontX = bL + D + GAP + W_F / 2;        // col2 center x (front/top column)
      const frontY = bBot + H_F / 2;                // row2 center y (lower row)
      const topY   = bBot + H_F + GAP + D / 2;      // row1 center y (upper row)

      // Convert to Onshape position (origin top-right, x leftward, y downward, meters)
      FRONT_POS_M = { x: (SW - frontX) / 1000, y: (SH - frontY) / 1000 };
      TOP_POS_M   = { x: (SW - frontX) / 1000, y: (SH - topY)   / 1000 };
      LEFT_POS_M  = { x: (SW - leftX)  / 1000, y: (SH - frontY) / 1000 };
      ISO_POS_M   = { x: (SW - leftX)  / 1000, y: (SH - topY)   / 1000 };
    } else {
      FRONT_POS_M = FALLBACK.front;
      TOP_POS_M   = FALLBACK.top;
      LEFT_POS_M  = FALLBACK.left;
      ISO_POS_M   = FALLBACK.iso;
    }

    // Step 1: Create front + top + left + iso views
    try {
      const viewBody = {
        description: "Add views",
        jsonRequests: [{
          messageName: "onshapeCreateViews",
          formatVersion: "2021-01-01",
          views: [
            {
              viewType: "TopLevel",
              orientation: "front",
              scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
              reference: ref,
              position: FRONT_POS_M,
            },
            {
              viewType: "TopLevel",
              orientation: "top",
              scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
              reference: ref,
              position: TOP_POS_M,
            },
            {
              viewType: "TopLevel",
              orientation: "left",
              scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
              reference: ref,
              position: LEFT_POS_M,
            },
            {
              viewType: "TopLevel",
              orientation: "isometric",
              scale: { scaleSource: "Custom", numerator: scale[0], denominator: scale[1] },
              reference: ref,
              position: ISO_POS_M,
            },
          ],
        }],
      };
      const resp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modify`, viewBody);
      const mid = resp.id || "";
      if (mid) await pollModify(docId, wid, drawingEid, mid);
    } catch (e) {
      broadcastDrawLog(`  views failed: ${e.message}`, "log-err");
      failed++;
      continue;
    }

    // Step 1b: Enable view labels on Sheet 1 (showViewLabel ignored in create)
    try {
      const viewsResp = await onshapeFetch(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/views`);
      const viewList = viewsResp.items || [];
      if (viewList.length > 0) {
        // Identify view orientation from the 4x4 viewMatrix (column-major).
        // Isometric: has non-integer values (rotation angles).
        // Front: m[0]=1 (X right), m[6]=1 (Z up).
        // Top: m[0]=1 (X right), m[5]=1 (Y up, looking down Z).
        // Left: m[1]=+-1 (Y maps to X axis = rotated 90 deg around Z).
        function identifyView(v) {
          const m = v.viewMatrix || [];
          if (m.some(val => val !== 0 && val !== 1 && val !== -1)) return "Isometric";
          if (m[0] === 1 && m[6] === 1) return "Front";
          if (m[0] === 1 && m[5] === 1) return "Top";
          if (m[1] === -1 || m[1] === 1) return "Left";
          return "View";
        }
        const editViews = viewList.map((v) => ({
          viewId: v.viewId,
          showViewLabel: true,
          label: identifyView(v),
          name: identifyView(v),
          scale: { scaleSource: "Custom", numerator: scale[0], denumerator: scale[1] },
        }));
        const editBody = {
          description: "Enable view labels",
          jsonRequests: [{
            messageName: "onshapeEditViews",
            formatVersion: "2021-01-01",
            views: editViews,
          }],
        };
        const editResp = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modify`, editBody);
        const editMid = editResp.id || "";
        if (editMid) await pollModify(docId, wid, drawingEid, editMid);
        // Build viewPosMm: physical mm (Y-up, origin bottom-left) for addOverallDimensions.
        // Onshape position is (origin top-right, x leftward, y downward) in meters, so convert:
        //   physical_x = SW - pos.x*1000,  physical_y = SH - pos.y*1000
        const viewPosMm = {};
        const _toPhys = (pos) => ({ x: SW - pos.x * 1000, y: SH - pos.y * 1000 });
        for (const v of viewList) {
          if (v.position) {
            viewPosMm[v.viewId] = _toPhys(v.position);
          } else if (identifyView(v) === "Front") {
            viewPosMm[v.viewId] = _toPhys(FRONT_POS_M);
          } else if (identifyView(v) === "Top") {
            viewPosMm[v.viewId] = _toPhys(TOP_POS_M);
          } else if (identifyView(v) === "Left") {
            viewPosMm[v.viewId] = _toPhys(LEFT_POS_M);
          }
        }
        broadcastDrawLog(`  labels applied`);
        broadcastDrawLog(`  adding overall dimensions...`);
        await addOverallDimensions(docId, wid, drawingEid, scale, viewPosMm);
      }
    } catch (e) {
      broadcastDrawLog(`  labels failed: ${e.message}`, "log-err");
    }

    created++;
    broadcastDrawLog(`  done`, "log-ok");
  }

  broadcastDrawLog(`Complete: ${created} created, ${failed} failed`, created > 0 ? "log-ok" : "log-err");

  // Sort new drawings into Drawings folder
  if (created > 0) {
  }

  _drawingInProgress = false;
  chrome.runtime.sendMessage({ type: "draw-done", created, failed }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Auto-dimension helpers
// ---------------------------------------------------------------------------

// Add overall height + width dimensions to every non-isometric view on Sheet 1.
// All annotations are collected first, then submitted in ONE atomic modify call.
// This avoids Onshape's per-view lock that silently drops width annotations when
// they follow a height annotation for the same view in separate modify calls.
//
// Axis assignments for Y-up Onshape model space:
//   data[0] = X (width direction)
//   data[1] = Y (height direction)
//   data[2] = Z (depth direction — used only for front/back edge disambiguation)
//
// Parameters:
//   docId, wid, drawingEid — drawing coordinates
//   scale                  — [scaleNum, scaleDen] from computeScale()
async function addOverallDimensions(docId, wid, drawingEid, scale, viewPosMm = {}) {
  const [scaleNum, scaleDen] = scale;
  const sc = v => v * 1000 * scaleNum / scaleDen;
  const hA = 1, dA = 2, xA = 0;

  // Fetch all views; keep only Sheet 1 non-isometric views
  let viewList;
  try {
    const viewsResp = await onshapeFetch(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/views`);
    viewList = viewsResp.items || [];
  } catch (e) {
    broadcastDrawLog(`  dimensions: failed to fetch views: ${e.message}`, "log-err");
    return;
  }

  const targetViews = viewList.filter(v => {
    if ((v.sheetIndex || 0) !== 0) return false;
    const m = v.viewMatrix || [];
    return !m.some(val => val !== 0 && val !== 1 && val !== -1); // exclude iso
  });

  if (!targetViews.length) {
    broadcastDrawLog(`  dimensions: no non-iso views on sheet 1`, "log-err");
    return;
  }

  const annotations = [];

  for (const view of targetViews) {
    const vid = view.viewId;
    // Prefer view.position from this fetch (freshest); fall back to caller-passed viewPosMm.
    const vp = view.position;
    const knownPos = viewPosMm[vid] || {};
    const pos = {
      x: (vp?.x != null ? vp.x * 1000 : knownPos.x) || 0,
      y: (vp?.y != null ? vp.y * 1000 : knownPos.y) || 0,
    };

    let lines = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const j = await onshapeFetch(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/views/${vid}/jsongeometry`);
        lines = (j.bodyData || []).filter(e => e.type === "line");
      } catch (e) {
        broadcastDrawLog(`  dimensions: geometry failed for ${vid} (attempt ${attempt}): ${e.message}`, "log-err");
      }
      if (lines.length) break;
      if (attempt < 5) {
        broadcastDrawLog(`  dimensions: geometry not ready for ${vid}, retrying in 2s (attempt ${attempt}/5)...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!lines.length) {
      broadcastDrawLog(`  dimensions: geometry still empty for ${vid} after 5 attempts, skipping`, "log-err");
      continue;
    }

    const avgH  = e => (e.data.start[hA] + e.data.end[hA]) / 2;
    const avgD  = e => (e.data.start[dA] + e.data.end[dA]) / 2;
    const spanX = e => Math.abs(e.data.end[xA] - e.data.start[xA]);
    const spanH = e => Math.abs(e.data.end[hA] - e.data.start[hA]);

    const allGX = lines.flatMap(e => [e.data.start[xA], e.data.end[xA]]);
    const allGH = lines.flatMap(e => [e.data.start[hA], e.data.end[hA]]);

    // HEIGHT: topmost vs bottommost horizontal edge, sorted by depth to pick visible face
    const horiz = lines.filter(e => Math.abs(e.data.end[hA] - e.data.start[hA]) < 0.0001 && spanX(e) > 0.0001);
    if (horiz.length) {
      const minH = Math.min(...horiz.map(avgH));
      const maxH = Math.max(...horiz.map(avgH));
      const botCands = horiz.filter(e => Math.abs(avgH(e) - minH) < 0.0001);
      botCands.sort((a, b) => avgD(b) - avgD(a));
      const topCands = horiz.filter(e => Math.abs(avgH(e) - maxH) < 0.0001);
      topCands.sort((a, b) => avgD(a) - avgD(b));
      const bottomEdge = botCands[0];
      const topEdge    = topCands[0];
      const maxXval = Math.max(...allGX);
      const hTextPos = [pos.x + sc(maxXval) + 20, pos.y, 0];
      broadcastDrawLog(`  ${vid} HEIGHT ${((maxH - minH) * 1000).toFixed(1)}mm`);
      annotations.push({
        type: "Onshape::Dimension::LineToLine",
        lineToLineDimension: {
          edge1: { type: "Onshape::Reference::Edge", uniqueId: bottomEdge.uniqueId, viewId: vid },
          edge2: { type: "Onshape::Reference::Edge", uniqueId: topEdge.uniqueId,    viewId: vid },
          formatting: { dimdec: 2, dimlim: false, dimpost: "", dimtm: 0, dimtol: false, dimtp: 0, type: "Onshape::Formatting::Dimension" },
          textOverride: "",
          textPosition: { coordinate: hTextPos, type: "Onshape::Reference::Point" },
        },
      });
    }

    // WIDTH: leftmost vs rightmost vertical edge; fall back to all lines if no pure-vertical found
    const vert = lines.filter(e => spanX(e) < 0.0001 && spanH(e) > 0.0001);
    const srcLines = vert.length ? vert : lines;
    const allX     = srcLines.flatMap(e => [e.data.start[xA], e.data.end[xA]]);
    const minX     = Math.min(...allX);
    const maxX     = Math.max(...allX);
    const leftEdge  = srcLines.find(e => Math.abs(Math.min(e.data.start[xA], e.data.end[xA]) - minX) < 0.0001);
    const rightEdge = srcLines.find(e => Math.abs(Math.max(e.data.start[xA], e.data.end[xA]) - maxX) < 0.0001);
    if (leftEdge && rightEdge) {
      const maxHval  = Math.max(...allGH);
      const wTextPos = [pos.x + sc((minX + maxX) / 2), pos.y + sc(maxHval) + 20, 0];
      broadcastDrawLog(`  ${vid} WIDTH ${((maxX - minX) * 1000).toFixed(1)}mm`);
      annotations.push({
        type: "Onshape::Dimension::LineToLine",
        lineToLineDimension: {
          edge1: { type: "Onshape::Reference::Edge", uniqueId: leftEdge.uniqueId,  viewId: vid },
          edge2: { type: "Onshape::Reference::Edge", uniqueId: rightEdge.uniqueId, viewId: vid },
          formatting: { dimdec: 2, dimlim: false, dimpost: "", dimtm: 0, dimtol: false, dimtp: 0, type: "Onshape::Formatting::Dimension" },
          textOverride: "",
          textPosition: { coordinate: wTextPos, type: "Onshape::Reference::Point" },
        },
      });
    }
  }

  if (!annotations.length) {
    broadcastDrawLog(`  dimensions: no annotations built`, "log-err");
    return;
  }

  broadcastDrawLog(`  submitting ${annotations.length} dimension annotations`);
  try {
    const body = {
      description: "all dims",
      jsonRequests: [{ messageName: "onshapeCreateAnnotations", formatVersion: "2021-01-01", annotations }],
    };
    const r   = await onshapePost(`/api/v6/drawings/d/${docId}/w/${wid}/e/${drawingEid}/modify`, body);
    const mid = r.id || "";
    if (mid) await pollModify(docId, wid, drawingEid, mid);
    broadcastDrawLog(`  dimensions added`, "log-ok");
  } catch (e) {
    broadcastDrawLog(`  dimensions: modify failed: ${e.message}`, "log-err");
  }
}

// ---------------------------------------------------------------------------
// Tab navigation helpers
// ---------------------------------------------------------------------------

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      waitForTabLoad(tabId).then(resolve).catch(reject);
    });
  });
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve anyway, content script may still respond
    }, 15000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        // Extra delay for Onshape SPA to initialize
        setTimeout(resolve, 2000);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---------------------------------------------------------------------------
// Try sending scan message to a tab's content script
// Returns result or { __noConnection: true } if content script isn't there
// ---------------------------------------------------------------------------

function trySendScan(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ error: "Scan timed out" }), DOC_SCAN_TIMEOUT);
    chrome.tabs.sendMessage(tabId, { type: "scan-tab-folders" }, (result) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        resolve({ __noConnection: true, error: chrome.runtime.lastError.message });
      } else {
        resolve(result || { error: "No response" });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Store scan result per doc in chrome.storage.local
// ---------------------------------------------------------------------------

const ALLOWED_FOLDERS = ["Part Studios", "Assemblies", "Drawings", "CAD Imports", "Feature Studios", "Variable Studios"];

// Tracks docs already notified about high tab count this SW session (avoid spamming)
const _tabCountNotifiedDocs = new Set();

async function storeDocScanResult(result) {
  if (!result || !result.doc_id) return;
  console.log("[Scanner] storeDocScanResult called, wid=" + (result.wid || "none") +
    ", folders=" + Object.keys(result.folders || {}).join(","));

  // Enrich scan with assembly count from the elements API (1 call per doc).
  // Onshape API doesn't expose tab group (folder) membership, so we count total
  // assemblies and attribute them to the "Assemblies" folder if it exists
  if (result.wid) {
    try {
      const rawElements = await onshapeFetch(
        `/api/v10/documents/d/${result.doc_id}/w/${result.wid}/elements`
      );
      const elements = Array.isArray(rawElements) ? rawElements : (rawElements.items || []);
      const assemblies = elements.filter(e => e.elementType === "ASSEMBLY");
      console.log(`[Scanner] ${assemblies.length} assembly(s) found:`,
        assemblies.map(a => a.name));

      // Store assembly element IDs for interference checker (0 extra API calls)
      result.assemblyElements = assemblies.map(a => ({ id: a.id, name: a.name }));

      // Always store total assembly count at top level (catches root-level assemblies)
      result.totalAssemblies = assemblies.length;

      if (result.folders && result.folders["Assemblies"]) {
        result.folders["Assemblies"].assemblies = assemblies.length;
        console.log("[Scanner] Set Assemblies folder count to " + assemblies.length);
      }

      // Notify if doc has >= 35 elements (tabs) — once per SW session per doc
      result.totalElements = elements.length;
      if (elements.length >= 35 && elements.length < 40 && !_tabCountNotifiedDocs.has(result.doc_id)) {
        _tabCountNotifiedDocs.add(result.doc_id);
        const docName = result.doc_name || result.doc_id;
        chrome.notifications.create(`tab-count-${result.doc_id}-${Date.now()}`, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: docName,
          message: `You are approaching the limit of 35 tabs, split this document into multiple documents or the current one will be disabled.`,
        });
        console.log(`[Scanner] Tab count notification fired: ${elements.length} elements in ${result.doc_id}`);
      }
    } catch (e) {
      console.error("[Scanner] Elements API error:", e.message);
    }
  } else {
    console.log("[Scanner] Skipping API enrichment: no wid");
  }

  const data = await chrome.storage.local.get("docScanResults");
  const results = data.docScanResults || {};
  results[result.doc_id] = result;
  await chrome.storage.local.set({ docScanResults: results });
  console.log("[Scanner] Stored enriched result for " + result.doc_id);
}

// ---------------------------------------------------------------------------
// DOM automation: add drawing sheet via iframe injection
// ---------------------------------------------------------------------------

async function addSheetViaIframe(tabId) {
  // Poll for the drawing editor iframe (it loads after the parent page)
  let drawingFrame = null;
  for (let i = 0; i < 30; i++) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    drawingFrame = frames.find(f =>
      f.url.includes("onshape.com/editor") || f.url.includes("onshape.com/drawing")
    );
    if (drawingFrame) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!drawingFrame) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    console.log("[AddSheet] No drawing iframe found after 30s. Frames:", frames.map(f => f.url.slice(0, 120)));
    return { error: "Drawing editor iframe not found after 30s." };
  }

  console.log("[AddSheet] Found drawing iframe:", drawingFrame.url.slice(0, 120), "frameId:", drawingFrame.frameId);

  // Inject script into the drawing iframe to click "Add Sheet"
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [drawingFrame.frameId] },
    func: async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      // Wait for the Add Sheet button to appear (drawing editor loads async)
      let addBtn = null;
      for (let i = 0; i < 20; i++) {
        addBtn = document.querySelector(".xenon-dialog-addSheet");
        if (addBtn) break;
        await sleep(1000);
      }
      if (!addBtn) {
        // Dump what sheet-related elements exist for debugging
        const sheetEls = Array.from(document.querySelectorAll("[class*='sheet' i]"))
          .filter(el => el.offsetHeight > 0)
          .map(el => ({ cls: el.className.toString().slice(0, 100), text: el.textContent.trim().slice(0, 40) }));
        return { error: "Add Sheet button not found after 20s", sheetEls };
      }

      // Wait for editor to become fully interactive
      // The button appears in DOM before the editor is ready to handle clicks.
      // Wait for the drawing canvas to render (indicates editor is interactive).
      for (let i = 0; i < 30; i++) {
        const canvas = document.querySelector("canvas");
        if (canvas && canvas.offsetHeight > 100) break;
        await sleep(1000);
      }
      // Extra buffer after canvas renders
      await sleep(3000);

      const before = document.querySelector(".active_sheet_label")?.textContent.trim() || "";

      // Retry click up to 5 times — editor may not be interactive on first attempt
      let after = before;
      for (let attempt = 0; attempt < 5; attempt++) {
        // Re-query button each attempt (DOM may rebuild)
        const btn = document.querySelector(".xenon-dialog-addSheet");
        if (!btn) break;

        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const evtOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };
        btn.dispatchEvent(new MouseEvent("mousedown", evtOpts));
        await sleep(50);
        btn.dispatchEvent(new MouseEvent("mouseup", evtOpts));
        await sleep(50);
        btn.dispatchEvent(new MouseEvent("click", evtOpts));
        await sleep(4000);

        after = document.querySelector(".active_sheet_label")?.textContent.trim() || "";
        if (after !== before) break;
        // Wait longer before next retry
        await sleep(3000);
      }

      return { ok: before !== after, sheetBefore: before, sheetAfter: after };
    },
  });

  const result = results?.[0]?.result || { error: "No result from injected script" };
  console.log("[AddSheet] Result:", JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// CDP helpers — chrome.debugger wrappers for trusted input events
// ---------------------------------------------------------------------------

// Freeze screen: inject overlay into the PAGE's main world via Runtime.evaluate.
// Content script listeners can't block main-world events (isolated world), but
// Runtime.evaluate runs in the main world so capture-phase listeners here DO
// block Onshape's handlers. CDP synthetic events (Input.dispatch*) bypass the
// DOM entirely, so automation is unaffected.
// async function showCdpOverlay(tabId) {
//   // Visual overlay via content script (informational banner)
//   chrome.tabs.sendMessage(tabId, { type: "cdp-overlay-show" }).catch(() => {});
//   // Main-world input blocker via CDP — this is what actually freezes the page
//   try {
//     await cdpSend(tabId, "Runtime.evaluate", {
//       expression: `(() => {
//         if (document.getElementById("oxt-cdp-input-blocker")) return;
//         const blocker = document.createElement("div");
//         blocker.id = "oxt-cdp-input-blocker";
//         blocker.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;background:transparent;";
//         const events = ["click","dblclick","mousedown","mouseup","mousemove",
//           "keydown","keyup","keypress","wheel","scroll","contextmenu",
//           "touchstart","touchend","touchmove","pointerdown","pointerup","pointermove"];
//         events.forEach(evt => {
//           blocker.addEventListener(evt, e => {
//             e.preventDefault();
//             e.stopPropagation();
//             e.stopImmediatePropagation();
//           }, { capture: true });
//         });
//         document.documentElement.appendChild(blocker);
//       })()`,
//     });
//   } catch (_) {}
// }

// async function hideCdpOverlay(tabId) {
//   // Remove main-world input blocker
//   try {
//     await cdpSend(tabId, "Runtime.evaluate", {
//       expression: `(() => {
//         const b = document.getElementById("oxt-cdp-input-blocker");
//         if (b) b.remove();
//       })()`,
//     });
//   } catch (_) {}
//   // Remove visual overlay
//   chrome.tabs.sendMessage(tabId, { type: "cdp-overlay-hide" }).catch(() => {});
// }

function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function cdpClick(tabId, x, y) {
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, buttons: 0,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
  });
}

async function cdpRightClick(tabId, x, y) {
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, buttons: 0,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1,
  });
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1,
  });
}

async function cdpTypeText(tabId, text) {
  // Select all existing text first (Ctrl+A), then type
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", modifiers: 2, windowsVirtualKeyCode: 65, key: "a", code: "KeyA",
  });
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", modifiers: 2, windowsVirtualKeyCode: 65, key: "a", code: "KeyA",
  });
  await cdpSend(tabId, "Input.insertText", { text });
}

async function cdpPressKey(tabId, key, keyCode) {
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", windowsVirtualKeyCode: keyCode, key, code: key,
  });
  await cdpSend(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", windowsVirtualKeyCode: keyCode, key, code: key,
  });
}

// CDP drag uses a three-phase path (down → across → up) instead of a straight line.
// Straight-line drags between tabs cross intermediate folder drop zones, causing
// Onshape to "catch" the dragged tab in the wrong folder mid-path.
// Phase 1: drag down 120px below the tab bar (safe zone, no drop targets).
// Phase 2: slide horizontally to the target X (still below tab bar).
// Phase 3: drag up into the target folder's drop zone.
async function cdpDrag(tabId, fromX, fromY, toX, toY) {
  const dropY = fromY + 120;

  // Hover over source
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: fromX, y: fromY, button: "none", buttons: 0, pointerType: "mouse",
  });
  await new Promise(r => setTimeout(r, 100));

  // Press down on source
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse",
  });
  await new Promise(r => setTimeout(r, 200));

  // Phase 1: Drag DOWN (out of tab bar)
  for (let i = 1; i <= 4; i++) {
    const y = Math.round(fromY + (dropY - fromY) * (i / 4));
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: fromX, y, button: "left", buttons: 1, pointerType: "mouse",
    });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 100));

  // Phase 2: Move ACROSS horizontally (below the tab bar, no folders to snag)
  const hSteps = 8;
  for (let i = 1; i <= hSteps; i++) {
    const x = Math.round(fromX + (toX - fromX) * (i / hSteps));
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y: dropY, button: "left", buttons: 1, pointerType: "mouse",
    });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 100));

  // Phase 3: Drag UP into target folder
  for (let i = 1; i <= 4; i++) {
    const y = Math.round(dropY + (toY - dropY) * (i / 4));
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: toX, y, button: "left", buttons: 1, pointerType: "mouse",
    });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 150));

  // Release on target
  await cdpSend(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse",
  });
}

async function waitForElement(tabId, jsExpr, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await cdpSend(tabId, "Runtime.evaluate", {
      expression: jsExpr,
      returnByValue: true,
    });
    if (res.result && res.result.value) return res.result.value;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery helper — dump context menu DOM after right-clicking tab bar
// Run once to find selectors for "Create folder" menu item.
// Triggered by message type "discover-context-menu" from content.js or console.
// ---------------------------------------------------------------------------

async function discoverContextMenu(tabId) {
  console.log("[CDP-Discovery] Attaching debugger to tab", tabId);
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });

    // Find tab bar area coordinates
    const tabBarPos = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const selectors = ['.os-tab-bar-scroll-container', '.os-tab-bar', '.os-tab-bar-tabs', '[class*="tab-bar"]', '[class*="tabbar"]'];
        let bar = null;
        for (const sel of selectors) {
          bar = document.querySelector(sel);
          if (bar && bar.offsetHeight > 0) break;
          bar = null;
        }
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        return { x: r.left + 80, y: r.top + r.height / 2 };
      })()`,
      returnByValue: true,
    });

    if (!tabBarPos.result?.value) {
      console.log("[CDP-Discovery] Tab bar not found");
      return { error: "Tab bar not found" };
    }

    const { x, y } = tabBarPos.result.value;
    console.log("[CDP-Discovery] Right-clicking at", x, y);
    await cdpRightClick(tabId, x, y);

    // Wait for context menu to appear
    await new Promise(r => setTimeout(r, 1000));

    // Dump all context menu elements
    const menuDump = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const items = document.querySelectorAll(
          '[class*="context-menu"] *, [class*="contextmenu"] *, [class*="dropdown-menu"] *, [class*="popover"] li, [class*="popup"] li, [role="menu"] *, [role="menuitem"]'
        );
        const results = [];
        for (const el of items) {
          if (el.offsetHeight === 0) continue;
          const text = el.textContent.trim();
          if (!text || text.length > 100) continue;
          const r = el.getBoundingClientRect();
          results.push({
            tag: el.tagName,
            cls: el.className.toString().slice(0, 150),
            text: text.slice(0, 80),
            role: el.getAttribute('role') || '',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
        return results;
      })()`,
      returnByValue: true,
    });

    // Dismiss the menu with Escape
    await cdpPressKey(tabId, "Escape", 27);

    const menuItems = menuDump.result?.value || [];
    console.log("[CDP-Discovery] Context menu items:", JSON.stringify(menuItems, null, 2));
    return { items: menuItems };
  } catch (e) {
    console.error("[CDP-Discovery] Error:", e.message);
    return { error: e.message };
  } finally {
    chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Folder creation orchestrator — creates tab folders via CDP
// ---------------------------------------------------------------------------

async function createTabFolders(tabId, senderTabId, folderNames) {
  console.log("[CDP-Folders] Starting folder creation:", folderNames);
  // showCdpOverlay(senderTabId);

  function sendProgress(index, total, name, status) {
    chrome.tabs.sendMessage(senderTabId, {
      type: "folder-creation-progress",
      index, total, name, status,
    }).catch(() => {});
  }

  function sendDone(success, error) {
    chrome.tabs.sendMessage(senderTabId, {
      type: "folder-creation-done",
      success, error,
    }).catch(() => {});
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    // await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: true });

    // Wait for debugger banner to appear and page layout to stabilize
    await new Promise(r => setTimeout(r, 500));

    for (let i = 0; i < folderNames.length; i++) {
      const name = folderNames[i];
      sendProgress(i + 1, folderNames.length, name, "creating");
      console.log(`[CDP-Folders] Creating folder ${i + 1}/${folderNames.length}: ${name}`);

      // Step a: Find the "Insert new tab" button (+ icon near tab bar)
      const insertBtn = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          // Search by Bootstrap tooltip attribute (confirmed from DOM observation)
          const byTooltip = document.querySelector('[data-bs-original-title="Insert new tab"], [title="Insert new tab"]');
          if (byTooltip && byTooltip.offsetHeight > 0) {
            const r = byTooltip.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), method: "tooltip" };
          }
          // Fallback: find "+" button or insert icon near the tab bar
          const tabBar = document.querySelector('.os-tab-bar-tab');
          if (!tabBar) return null;
          const tabR = tabBar.getBoundingClientRect();
          // Look for small buttons/icons near the tab bar
          const candidates = document.querySelectorAll('button, [role="button"], .os-icon, [class*="insert"], [class*="add"]');
          for (const el of candidates) {
            if (el.offsetHeight === 0) continue;
            const r = el.getBoundingClientRect();
            const title = el.getAttribute('data-bs-original-title') || el.getAttribute('title') || '';
            const aria = el.getAttribute('aria-label') || '';
            const text = el.textContent.trim();
            // Must be near the tab bar vertically, and look like an add/insert button
            if (Math.abs(r.top - tabR.top) < 30 && r.width < 50 && r.height < 50) {
              if (text === '+' || title.toLowerCase().includes('insert') || title.toLowerCase().includes('new tab') || aria.toLowerCase().includes('insert')) {
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), method: "scan", title, text: text.slice(0, 20) };
              }
            }
          }
          // Last resort: dump nearby small buttons for diagnostic
          const nearby = [];
          for (const el of candidates) {
            if (el.offsetHeight === 0) continue;
            const r = el.getBoundingClientRect();
            if (Math.abs(r.top - tabR.top) < 50 && r.width < 60) {
              nearby.push({ cls: (el.className||'').toString().slice(0, 100), title: el.getAttribute('data-bs-original-title') || el.getAttribute('title') || '', x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
            }
          }
          return { error: "not-found", nearby: nearby.slice(0, 10) };
        })()`,
        returnByValue: true,
      });

      const btnInfo = insertBtn.result?.value;
      if (!btnInfo || btnInfo.error) {
        console.log("[CDP-Folders] Insert button search:", JSON.stringify(btnInfo));
        throw new Error("'Insert new tab' button not found. See console for nearby elements.");
      }

      console.log(`[CDP-Folders] Found insert button via ${btnInfo.method} at (${btnInfo.x}, ${btnInfo.y})`);

      // Step b: Click the "Insert new tab" button to open dropdown
      await cdpClick(tabId, btnInfo.x, btnInfo.y);
      await new Promise(r => setTimeout(r, 1000));

      // Step c: Find "Folder" option in the dropdown menu
      const folderOption = await waitForElement(tabId, `(() => {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          if (el.offsetHeight === 0 || el.children.length > 3) continue;
          const text = el.textContent.trim().toLowerCase();
          if (text === 'folder' || text === 'tab group' || text === 'create folder' || text === 'new folder') {
            const r = el.getBoundingClientRect();
            if (r.width > 30 && r.height > 10) {
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() };
            }
          }
        }
        return null;
      })()`, 3000);

      if (!folderOption) {
        // Dump what appeared in the dropdown for diagnostic
        const dropDiag = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const items = [];
            const all = document.querySelectorAll('*');
            for (const el of all) {
              if (el.offsetHeight === 0 || el.children.length > 3) continue;
              const text = el.textContent.trim();
              if (!text || text.length > 60 || text.length < 2) continue;
              const style = getComputedStyle(el);
              const pos = style.position;
              const z = parseInt(style.zIndex) || 0;
              const r = el.getBoundingClientRect();
              // Look for menu-like items (positioned, or in a dropdown area)
              if ((pos === 'absolute' || pos === 'fixed') && z > 0 && r.width > 50 && r.height < 400) {
                items.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0, 100), text: text.slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
              }
            }
            return items.slice(0, 20);
          })()`,
          returnByValue: true,
        });
        console.log("[CDP-Folders] Dropdown items:", JSON.stringify(dropDiag.result?.value, null, 2));
        await cdpPressKey(tabId, "Escape", 27);
        throw new Error("'Folder' option not found in dropdown. See console.");
      }

      console.log(`[CDP-Folders] Found folder option: "${folderOption.text}" at (${folderOption.x}, ${folderOption.y})`);

      // Step d: Click "Folder" option
      await cdpClick(tabId, folderOption.x, folderOption.y);

      // Step e: Wait for rename input to appear
      const renameInput = await waitForElement(tabId, `(() => {
        const input = document.querySelector('.rename-tab-input, .os-tab-name-input, input[class*="rename"]');
        if (input && input.offsetHeight > 0) {
          const r = input.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      })()`, 5000);

      if (!renameInput) {
        await cdpPressKey(tabId, "Escape", 27);
        throw new Error(`Rename input not found after creating folder "${name}"`);
      }

      console.log(`[CDP-Folders] Rename input at (${renameInput.x}, ${renameInput.y})`);

      // Step f: Click input to focus, select all, type folder name, press Enter
      await cdpClick(tabId, renameInput.x, renameInput.y);
      await new Promise(r => setTimeout(r, 200));
      await cdpTypeText(tabId, name);
      await new Promise(r => setTimeout(r, 300));
      await cdpPressKey(tabId, "Enter", 13);

      // Step g: Wait for folder to appear in DOM
      const folderAppeared = await waitForElement(tabId, `(() => {
        const tabs = document.querySelectorAll('.os-tab-name');
        for (const t of tabs) {
          if (t.textContent.trim() === ${JSON.stringify(name)}) return true;
        }
        return null;
      })()`, 3000);

      if (folderAppeared) {
        console.log(`[CDP-Folders] Folder "${name}" confirmed in DOM`);
      } else {
        console.log(`[CDP-Folders] Warning: folder "${name}" not confirmed, continuing`);
      }

      // Pause before next folder
      await new Promise(r => setTimeout(r, 800));
    }

    console.log("[CDP-Folders] All folders created successfully");

    // --- Move all stray root-level tabs into their matching folders ---
    // Reuses TAB_ICON_FOLDER_MAP defined at module level (line ~1948)

    // Gather all root-level non-folder tabs and their types via data-icon-src
    const strayTabs = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const results = [];
        const tabs = document.querySelectorAll('.os-tab-bar-tab');
        for (const tab of tabs) {
          if (tab.classList.contains('os-tab-bar-tab-group')) continue;
          if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
          const nameEl = tab.querySelector('.os-tab-name');
          if (!nameEl) continue;
          const name = nameEl.textContent.trim();
          const iconSrc = tab.getAttribute('data-icon-src') || '';
          const r = tab.getBoundingClientRect();
          if (r.width === 0) continue;
          results.push({ name, iconSrc, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        }
        return results;
      })()`,
      returnByValue: true,
    });

    const strays = strayTabs.result?.value || [];
    console.log(`[CDP-Folders] Found ${strays.length} stray root tab(s):`, strays.map(s => `${s.name} (${s.iconSrc})`));

    for (const stray of strays) {
      const targetFolder = TAB_ICON_FOLDER_MAP[stray.iconSrc];
      if (!targetFolder) {
        console.log(`[CDP-Folders] No folder mapping for "${stray.name}" (icon: ${stray.iconSrc}), skipping`);
        continue;
      }
      if (!folderNames.includes(targetFolder)) {
        console.log(`[CDP-Folders] Folder "${targetFolder}" wasn't created, skipping "${stray.name}"`);
        continue;
      }

      sendProgress(folderNames.length, folderNames.length, stray.name, "moving");
      console.log(`[CDP-Folders] Moving "${stray.name}" into "${targetFolder}"`);

      // Find target folder position (re-query each time since positions shift after moves)
      const tgtResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            const container = t.closest('.os-tab-bar-tab');
            if (container && container.classList.contains('os-tab-bar-tab-group') && t.textContent.trim() === ${JSON.stringify(targetFolder)}) {
              const r = container.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      // Re-query source position too (may have shifted)
      const srcResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          for (const tab of tabs) {
            if (tab.classList.contains('os-tab-bar-tab-group')) continue;
            if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const r = tab.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const src = srcResult.result?.value;
      const tgt = tgtResult.result?.value;

      if (!src) {
        console.log(`[CDP-Folders] Tab "${stray.name}" no longer at root, skipping`);
        continue;
      }
      if (!tgt) {
        console.log(`[CDP-Folders] Folder "${targetFolder}" not found for move, skipping`);
        continue;
      }

      console.log(`[CDP-Folders] Dragging from (${src.x},${src.y}) to (${tgt.x},${tgt.y})`);
      await cdpDrag(tabId, src.x, src.y, tgt.x, tgt.y);
      await new Promise(r => setTimeout(r, 800));

      // Verify the tab moved
      const verified = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            if (t.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const container = t.closest('.os-tab-bar-tab');
              const parent = container?.parentElement?.closest('.os-tab-bar-tab-group');
              return { moved: !!parent };
            }
          }
          return { moved: false, reason: "tab-not-found" };
        })()`,
        returnByValue: true,
      });
      const v = verified.result?.value;
      if (v?.moved) {
        console.log(`[CDP-Folders] "${stray.name}" successfully moved`);
      } else {
        console.log(`[CDP-Folders] "${stray.name}" move not confirmed:`, JSON.stringify(v));
      }
    }

    // Move default tabs into their folders (debugger still attached)
    await sortDefaultTabs(tabId);

    sendDone(true);
  } catch (e) {
    console.error("[CDP-Folders] Error:", e.message);
    // Try to dismiss any open menus/dialogs
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendDone(false, e.message);
  } finally {
    // try { await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: false }); } catch (_) {}
    // hideCdpOverlay(senderTabId);
    chrome.debugger.detach({ tabId }, () => {});
  }
}

// Move default Onshape tabs into their folders after folder creation
async function sortDefaultTabs(tabId) {
  const defaults = [
    { name: "Part Studio 1", folder: "Part Studios" },
    { name: "Assembly 1", folder: "Assemblies" },
  ];

  await new Promise(r => setTimeout(r, 500)); // Let folders settle

  for (const { name, folder } of defaults) {
    const positions = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        let src = null, tgt = null;
        const tabs = document.querySelectorAll('.os-tab-bar-tab');
        for (const tab of tabs) {
          if (tab.classList.contains('os-tab-bar-tab-group')) {
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(folder)} && tab.offsetWidth > 0) {
              const r = tab.getBoundingClientRect();
              tgt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
            continue;
          }
          if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
          const nameEl = tab.querySelector('.os-tab-name');
          if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(name)} && tab.offsetWidth > 0) {
            const r = tab.getBoundingClientRect();
            src = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return (src && tgt) ? { src, tgt } : null;
      })()`,
      returnByValue: true,
    });

    const pos = positions.result?.value;
    if (!pos) {
      console.log(`[CDP-Folders] Default tab "${name}" or folder "${folder}" not found, skipping`);
      continue;
    }

    console.log(`[CDP-Folders] Moving "${name}" -> "${folder}"`);
    await cdpDrag(tabId, pos.src.x, pos.src.y, pos.tgt.x, pos.tgt.y);
    await new Promise(r => setTimeout(r, 800));
  }
}

// ---------------------------------------------------------------------------
// New-doc setup: create initial version + enable workspace protection
// ---------------------------------------------------------------------------

async function createInitialVersion(docId, wid) {
  console.log(`[NewDocSetup] Creating initial version for ${docId}`);
  try {
    const result = await onshapePost(`/api/v10/documents/d/${docId}/versions`, {
      name: "V1",
      documentId: docId,
      workspaceId: wid,
    });
    console.log(`[NewDocSetup] Version created: ${result.id || result.name || "ok"}`);
    return { ok: true, versionId: result.id };
  } catch (e) {
    console.error(`[NewDocSetup] Version creation failed: ${e.message}`);
    return { error: e.message };
  }
}

async function createDevelopmentBranch(docId, versionId) {
  console.log(`[NewDocSetup] Creating Development branch from version ${versionId}`);
  try {
    const result = await onshapePost(`/api/v10/documents/d/${docId}/workspaces`, {
      name: "B1",
      versionId: versionId,
    });
    console.log(`[NewDocSetup] Branch created: ${result.id || "ok"}`);
    return { ok: true, workspaceId: result.id };
  } catch (e) {
    console.error(`[NewDocSetup] Branch creation failed: ${e.message}`);
    return { error: e.message };
  }
}

async function enableWorkspaceProtection(tabId, senderTabId) {
  console.log("[NewDocSetup] Enabling workspace protection via CDP");
  // showCdpOverlay(senderTabId);

  function sendSetupProgress(message) {
    chrome.tabs.sendMessage(senderTabId, {
      type: "setup-new-doc-progress",
      message,
    }).catch(() => {});
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    // await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: true });

    // Wait for debugger banner to appear and layout to stabilize
    await new Promise(r => setTimeout(r, 500));

    // Step 1: Check if workspace is already protected (lock icon visible)
    const alreadyProtected = await waitForElement(tabId, `(() => {
      const lock = document.querySelector('svg.branch-lock-icon');
      return lock && lock.offsetWidth > 0 ? true : null;
    })()`, 500);

    if (alreadyProtected) {
      console.log("[NewDocSetup] Workspace already protected, skipping");
      return { ok: true, skipped: true };
    }

    sendSetupProgress("Opening versions panel...");

    // Step 2: Click "Versions and history" panel button
    const vhBtn = await waitForElement(tabId, `(() => {
      // Search by tooltip
      const byTooltip = document.querySelector('[data-bs-original-title="Versions and history"], [title="Versions and history"]');
      if (byTooltip && byTooltip.offsetHeight > 0) {
        const r = byTooltip.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      // Fallback: search panel selector buttons
      const btns = document.querySelectorAll('.os-panel-selector-button');
      for (const btn of btns) {
        const tip = btn.getAttribute('data-bs-original-title') || btn.getAttribute('title') || '';
        if (tip.includes('ersion')) {
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    })()`, 5000);

    if (!vhBtn) throw new Error("Versions and history button not found");

    console.log(`[NewDocSetup] Versions button at (${vhBtn.x}, ${vhBtn.y})`);
    await cdpClick(tabId, vhBtn.x, vhBtn.y);
    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Right-click on workspace "Main"
    sendSetupProgress("Right-clicking workspace...");

    const wsMain = await waitForElement(tabId, `(() => {
      const spans = document.querySelectorAll('span.workspace-name');
      for (const s of spans) {
        if (s.offsetHeight > 0 && s.textContent.trim() === 'Main') {
          const r = s.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: s.textContent.trim() };
        }
      }
      return null;
    })()`, 5000);

    if (!wsMain) throw new Error("Workspace name element not found in versions panel");

    console.log(`[NewDocSetup] Workspace "${wsMain.text}" at (${wsMain.x}, ${wsMain.y})`);
    await cdpRightClick(tabId, wsMain.x, wsMain.y);
    await new Promise(r => setTimeout(r, 800));

    // Step 4: Click "Workspace protection..." in context menu
    sendSetupProgress("Opening protection dialog...");

    const protectItem = await waitForElement(tabId, `(() => {
      const items = document.querySelectorAll('.dropdown-item, [role="menuitem"], .dropdown-menu a, .dropdown-menu li');
      for (const el of items) {
        const text = el.textContent.trim().toLowerCase();
        if (text.includes('workspace protection') || text.includes('protect')) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 5) {
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() };
          }
        }
      }
      return null;
    })()`, 3000);

    if (!protectItem) {
      await cdpPressKey(tabId, "Escape", 27);
      throw new Error("'Workspace protection...' menu item not found");
    }

    console.log(`[NewDocSetup] Protection item "${protectItem.text}" at (${protectItem.x}, ${protectItem.y})`);
    await cdpClick(tabId, protectItem.x, protectItem.y);
    await new Promise(r => setTimeout(r, 1000));

    // Step 5: Wait for protection dialog to appear
    const dialogReady = await waitForElement(tabId, `(() => {
      const dialog = document.querySelector('.workspace-permissions-dialog, .modal.workspace-permissions-dialog, [class*="workspace-permissions"]');
      return dialog && dialog.offsetHeight > 0 ? true : null;
    })()`, 5000);

    if (!dialogReady) throw new Error("Workspace protection dialog did not appear");

    // Step 6: Check the "Enable workspace protection" checkbox
    sendSetupProgress("Enabling protection...");

    const checkbox = await waitForElement(tabId, `(() => {
      const cb = document.querySelector('#enable-workspace-protection');
      if (cb && cb.offsetHeight > 0) {
        const r = cb.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), checked: cb.checked };
      }
      return null;
    })()`, 3000);

    if (!checkbox) throw new Error("Enable workspace protection checkbox not found");

    if (!checkbox.checked) {
      console.log(`[NewDocSetup] Clicking checkbox at (${checkbox.x}, ${checkbox.y})`);
      await cdpClick(tabId, checkbox.x, checkbox.y);
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log("[NewDocSetup] Checkbox already checked");
    }

    // Step 7: Wait for Apply button to become enabled, then click it
    const applyBtn = await waitForElement(tabId, `(() => {
      const btn = document.querySelector('#workspace-protection-apply');
      if (btn && btn.offsetHeight > 0 && !btn.disabled) {
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    })()`, 3000);

    if (!applyBtn) throw new Error("Apply button not found or still disabled");

    console.log(`[NewDocSetup] Clicking Apply at (${applyBtn.x}, ${applyBtn.y})`);
    await cdpClick(tabId, applyBtn.x, applyBtn.y);
    await new Promise(r => setTimeout(r, 1500));

    // Step 8: Verify success — look for success message bubble or lock icon
    const success = await waitForElement(tabId, `(() => {
      const bubble = document.querySelector('.osx-message-bubble-inner-container');
      if (bubble && bubble.textContent.includes('protection settings updated')) return 'bubble';
      const lock = document.querySelector('svg.branch-lock-icon');
      if (lock && lock.offsetWidth > 0) return 'lock';
      return null;
    })()`, 5000);

    if (success) {
      console.log(`[NewDocSetup] Workspace protection enabled (confirmed via ${success})`);
    } else {
      console.log("[NewDocSetup] Warning: protection confirmation not detected, may still have worked");
    }

    // Step 9: Close the versions panel by clicking the button again
    const vhBtnClose = await cdpSend(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const byTooltip = document.querySelector('[data-bs-original-title="Versions and history"], [title="Versions and history"]');
        if (byTooltip && byTooltip.offsetHeight > 0) {
          const r = byTooltip.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const closePos = vhBtnClose.result?.value;
    if (closePos) {
      await cdpClick(tabId, closePos.x, closePos.y);
    }

    sendSetupProgress("Workspace protection enabled");
    setTimeout(() => {
      chrome.tabs.sendMessage(senderTabId, { type: "remove-progress-toast" }).catch(() => {});
    }, 3000);
    return { ok: true };

  } catch (e) {
    console.error("[NewDocSetup] Error:", e.message);
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendSetupProgress(`Error: ${e.message}`);
    setTimeout(() => {
      chrome.tabs.sendMessage(senderTabId, { type: "remove-progress-toast" }).catch(() => {});
    }, 5000);
    return { error: e.message };
  } finally {
    // try { await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: false }); } catch (_) {}
    // hideCdpOverlay(senderTabId);
    chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Unpack Illegal Folders — CDP right-click > Unpack on non-standard folders
// ---------------------------------------------------------------------------

let _unpackInProgress = false;

async function unpackIllegalFolders(tabId, senderTabId, folderNames) {
  if (_unpackInProgress) {
    console.log("[Unpack] Already in progress, skipping");
    return;
  }
  _unpackInProgress = true;

  // Wait for sort to finish if in progress
  for (let i = 0; i < 60 && _sortingInProgress; i++) {
    await new Promise(r => setTimeout(r, 500));
  }

  // showCdpOverlay(senderTabId);
  let needsDetach = false;
  let unpacked = 0;

  function sendProgress(name) {
    chrome.tabs.sendMessage(senderTabId, { type: "unpack-progress", name }).catch(() => {});
  }
  function sendDone(count, error) {
    chrome.tabs.sendMessage(senderTabId, { type: "unpack-done", count, error }).catch(() => {});
  }

  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    needsDetach = true;
    // await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: true });

    // Wait for debugger banner to settle
    await new Promise(r => setTimeout(r, 500));

    for (const folderName of folderNames) {
      sendProgress(folderName);
      console.log(`[Unpack] Unpacking folder: "${folderName}"`);

      // Step 1: Find the folder element and get its bounding rect center
      const folderPos = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab-group');
          for (const tab of tabs) {
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(folderName)}) {
              const r = tab.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const pos = folderPos.result?.value;
      if (!pos) {
        console.log(`[Unpack] Folder "${folderName}" not found in DOM, skipping`);
        continue;
      }

      // Step 2: Right-click the folder to open context menu
      await cdpRightClick(tabId, pos.x, pos.y);
      await new Promise(r => setTimeout(r, 800));

      // Step 3: Find "Unpack" menu item in the context menu
      // DOM structure (from observer): ul.context-menu-list.context-menu-root
      //   > li.context-menu-item > span.context-menu-item-span (text: "Unpack")
      const unpackItem = await waitForElement(tabId, `(() => {
        const menuItems = document.querySelectorAll('ul.context-menu-root li.context-menu-item');
        for (const item of menuItems) {
          if (item.offsetHeight === 0) continue;
          const span = item.querySelector('span.context-menu-item-span');
          if (span && span.textContent.trim() === 'Unpack') {
            const r = item.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: span.textContent.trim() };
          }
        }
        return null;
      })()`, 3000);

      if (!unpackItem) {
        // Log all visible menu items for debugging
        const menuDump = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const items = [];
            const candidates = document.querySelectorAll('ul.context-menu-root li.context-menu-item span.context-menu-item-span');
            for (const el of candidates) {
              if (el.offsetHeight === 0) continue;
              items.push(el.textContent.trim());
            }
            return items;
          })()`,
          returnByValue: true,
        });
        console.log(`[Unpack] "Unpack" menu item not found for "${folderName}". Visible menu items:`, menuDump.result?.value);
        // Dismiss the context menu
        await cdpPressKey(tabId, "Escape", 27);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      console.log(`[Unpack] Found "${unpackItem.text}" at (${unpackItem.x}, ${unpackItem.y})`);

      // Step 4: Click the Unpack menu item
      await cdpClick(tabId, unpackItem.x, unpackItem.y);
      await new Promise(r => setTimeout(r, 500));

      unpacked++;
      console.log(`[Unpack] "${folderName}" unpacked successfully`);
    }

    console.log(`[Unpack] Done: ${unpacked}/${folderNames.length} folders unpacked`);
    sendDone(unpacked, null);

    // Chain: sort stray tabs using the same CDP session (no extra attach/detach)
    if (unpacked > 0) {
      await new Promise(r => setTimeout(r, 500)); // Let DOM settle
      await sortStrayTabs(tabId, senderTabId, true);
    }

  } catch (e) {
    console.error("[Unpack] Error:", e.message);
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendDone(unpacked, e.message);
  } finally {
    _unpackInProgress = false;
    if (needsDetach) {
      // try { await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: false }); } catch (_) {}
      // hideCdpOverlay(senderTabId);
      chrome.debugger.detach({ tabId }, () => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Tab Sorter — persistent, moves stray root-level tabs into matching folders
// Runs independently of folder creation: after every scan, or on demand.
// ---------------------------------------------------------------------------

// Maps Onshape tab data-icon-src attribute to folder name (from DOM observation).
// Used by both createTabFolders() and sortStrayTabs().
const TAB_ICON_FOLDER_MAP = {
  "partstudio": "Part Studios",
  "assembly": "Assemblies",
  "drawing": "Drawings",
  "feature-studio-element": "Feature Studios",
  "variable-studio-element": "Variable Studios",
};

let _sortingInProgress = false;

async function sortStrayTabs(tabId, senderTabId, alreadyAttached = false) {
  if (_sortingInProgress) {
    console.log("[TabSort] Already sorting, skipping");
    return { sorted: 0, skipped: 0, reason: "already-sorting" };
  }
  _sortingInProgress = true;

  function sendSortProgress(name) {
    chrome.tabs.sendMessage(senderTabId, { type: "tab-sort-progress", name }).catch(() => {});
  }
  function sendSortDone(sorted, skipped) {
    chrome.tabs.sendMessage(senderTabId, { type: "tab-sort-done", sorted, skipped }).catch(() => {});
  }

  // if (!alreadyAttached) showCdpOverlay(senderTabId);
  let needsDetach = false;
  let sorted = 0;
  let skipped = 0;

  try {
    // Lightweight pre-check via executeScript (no debugger needed)
    const preCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const folders = [];
        const strays = [];
        const tabs = document.querySelectorAll('.os-tab-bar-tab');
        for (const tab of tabs) {
          const nameEl = tab.querySelector('.os-tab-name');
          if (!nameEl) continue;
          const name = nameEl.textContent.trim();
          if (tab.classList.contains('os-tab-bar-tab-group')) {
            folders.push(name);
          } else if (!tab.parentElement?.closest('.os-tab-bar-tab-group')) {
            const iconSrc = tab.getAttribute('data-icon-src') || '';
            strays.push({ name, iconSrc });
          }
        }
        return { folders, strays };
      },
    });

    const { folders, strays } = preCheck?.[0]?.result || { folders: [], strays: [] };
    if (folders.length === 0) {
      console.log("[TabSort] No folders exist, nothing to sort");
      return { sorted: 0, skipped: 0, reason: "no-folders" };
    }

    // Log ALL strays for diagnostics
    console.log(`[TabSort] All stray tabs (${strays.length}):`, strays.map(s => `"${s.name}" (iconSrc: "${s.iconSrc}")`));

    const movable = strays.filter(s => {
      const target = TAB_ICON_FOLDER_MAP[s.iconSrc];
      return target && folders.includes(target);
    });
    const unmapped = strays.filter(s => {
      const target = TAB_ICON_FOLDER_MAP[s.iconSrc];
      return !target || !folders.includes(target);
    });
    if (unmapped.length > 0) {
      console.log(`[TabSort] ${unmapped.length} UNMAPPED stray tab(s) (no folder mapping, will stay at root):`,
        unmapped.map(s => `"${s.name}" (iconSrc: "${s.iconSrc}")`));
    }
    if (movable.length === 0) {
      console.log("[TabSort] No stray tabs to sort (all unmapped)");
      return { sorted: 0, skipped: 0, reason: "none-stray" };
    }

    console.log(`[TabSort] ${movable.length} movable stray tab(s):`, movable.map(s => `${s.name} -> ${TAB_ICON_FOLDER_MAP[s.iconSrc]}`));

    // Attach debugger only when we actually have tabs to move
    if (alreadyAttached) {
      // Caller already attached — don't attach or detach here
      needsDetach = false;
    } else {
      await new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      needsDetach = true;
      // await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: true });
    }

    for (const stray of movable) {
      const targetFolder = TAB_ICON_FOLDER_MAP[stray.iconSrc];
      sendSortProgress(stray.name);
      console.log(`[TabSort] Moving "${stray.name}" -> "${targetFolder}"`);

      // Fresh source position (layout shifts after each drag)
      const srcResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          for (const tab of tabs) {
            if (tab.classList.contains('os-tab-bar-tab-group')) continue;
            if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const r = tab.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      const tgtResult = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            const container = t.closest('.os-tab-bar-tab');
            if (container && container.classList.contains('os-tab-bar-tab-group') && t.textContent.trim() === ${JSON.stringify(targetFolder)}) {
              const r = container.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      let src = srcResult.result?.value;
      const tgt = tgtResult.result?.value;
      // Retry once after 500ms if source not found (DOM reflow after prior drag)
      if (!src) {
        await new Promise(r => setTimeout(r, 500));
        const retry = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const tabs = document.querySelectorAll('.os-tab-bar-tab');
            for (const tab of tabs) {
              if (tab.classList.contains('os-tab-bar-tab-group')) continue;
              if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
              const nameEl = tab.querySelector('.os-tab-name');
              if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
                const r = tab.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
            }
            return null;
          })()`,
          returnByValue: true,
        });
        src = retry.result?.value;
        if (src) console.log(`[TabSort] "${stray.name}" found on retry`);
      }
      if (!src) { console.log(`[TabSort] "${stray.name}" no longer at root, skipping`); skipped++; continue; }
      if (!tgt) { console.log(`[TabSort] Folder "${targetFolder}" not found, skipping`); skipped++; continue; }

      console.log(`[TabSort] Dragging (${src.x},${src.y}) -> (${tgt.x},${tgt.y})`);
      await cdpDrag(tabId, src.x, src.y, tgt.x, tgt.y);
      await new Promise(r => setTimeout(r, 800));

      // Verify
      const verified = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-name');
          for (const t of tabs) {
            if (t.textContent.trim() === ${JSON.stringify(stray.name)}) {
              const container = t.closest('.os-tab-bar-tab');
              return !!container?.parentElement?.closest('.os-tab-bar-tab-group');
            }
          }
          return false;
        })()`,
        returnByValue: true,
      });
      if (verified.result?.value) {
        console.log(`[TabSort] "${stray.name}" moved successfully`); sorted++;
      } else {
        console.log(`[TabSort] "${stray.name}" move not confirmed`); skipped++;
      }
    }

    // Re-scan: check for any remaining strays and do a second pass
    if (skipped > 0) {
      await new Promise(r => setTimeout(r, 500));
      const rescan = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          const strays = [];
          for (const tab of tabs) {
            if (tab.classList.contains('os-tab-bar-tab-group')) continue;
            if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
            const nameEl = tab.querySelector('.os-tab-name');
            const iconSrc = tab.getAttribute('data-icon-src') || '';
            if (nameEl && tab.offsetWidth > 0) strays.push({ name: nameEl.textContent.trim(), iconSrc });
          }
          return strays;
        })()`,
        returnByValue: true,
      });
      const remaining = (rescan.result?.value || []).filter(s => TAB_ICON_FOLDER_MAP[s.iconSrc] && folders.includes(TAB_ICON_FOLDER_MAP[s.iconSrc]));
      if (remaining.length > 0) {
        console.log(`[TabSort] Re-scan: ${remaining.length} stray(s) still at root, second pass`);
        for (const stray of remaining) {
          const targetFolder = TAB_ICON_FOLDER_MAP[stray.iconSrc];
          const srcR = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const tabs = document.querySelectorAll('.os-tab-bar-tab');
              for (const tab of tabs) {
                if (tab.classList.contains('os-tab-bar-tab-group')) continue;
                if (tab.parentElement?.closest('.os-tab-bar-tab-group')) continue;
                const nameEl = tab.querySelector('.os-tab-name');
                if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(stray.name)}) {
                  const r = tab.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
              }
              return null;
            })()`,
            returnByValue: true,
          });
          const tgtR = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const tabs = document.querySelectorAll('.os-tab-name');
              for (const t of tabs) {
                const container = t.closest('.os-tab-bar-tab');
                if (container && container.classList.contains('os-tab-bar-tab-group') && t.textContent.trim() === ${JSON.stringify(targetFolder)}) {
                  const r = container.getBoundingClientRect();
                  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                }
              }
              return null;
            })()`,
            returnByValue: true,
          });
          const s = srcR.result?.value, t = tgtR.result?.value;
          if (s && t) {
            console.log(`[TabSort] Re-scan: dragging "${stray.name}" -> "${targetFolder}"`);
            await cdpDrag(tabId, s.x, s.y, t.x, t.y);
            await new Promise(r => setTimeout(r, 800));
            sorted++;
            skipped--;
          }
        }
      }
    }

    console.log(`[TabSort] Done: ${sorted} moved, ${skipped} skipped`);
    sendSortDone(sorted, skipped);
    return { sorted, skipped };
  } catch (e) {
    console.error("[TabSort] Error:", e.message);
    return { sorted, skipped, error: e.message };
  } finally {
    _sortingInProgress = false;
    if (needsDetach) {
      // try { await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: false }); } catch (_) {}
    }
    // if (!alreadyAttached) hideCdpOverlay(senderTabId);
    if (needsDetach) chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Interference Detection — CDP automation for assembly interference checks
// ---------------------------------------------------------------------------

let _interferenceInProgress = false;

async function checkInterference(tabId, senderTabId, docId, wid) {
  if (_interferenceInProgress) {
    console.log("[Interference] Already in progress, skipping");
    return;
  }
  // Wait for tab sort to finish (up to 30s)
  for (let i = 0; i < 60 && _sortingInProgress; i++) {
    await new Promise(r => setTimeout(r, 500));
  }
  _interferenceInProgress = true;
  // showCdpOverlay(senderTabId);

  function sendProgress(message) {
    chrome.tabs.sendMessage(senderTabId, { type: "interference-progress", message }).catch(() => {});
  }
  function sendDone(results) {
    chrome.tabs.sendMessage(senderTabId, { type: "interference-done", results }).catch(() => {});
  }

  let needsDetach = false;

  try {
    // Get assembly elements from stored scan results (0 API calls)
    const data = await chrome.storage.local.get("docScanResults");
    const docScan = (data.docScanResults || {})[docId];
    const assemblyElements = docScan?.assemblyElements || [];

    if (assemblyElements.length === 0) {
      console.log("[Interference] No assemblies found for", docId);
      sendDone({ totalInterferences: 0, assemblies: {} });
      return;
    }

    console.log(`[Interference] Checking ${assemblyElements.length} assembly(s):`,
      assemblyElements.map(a => a.name));
    sendProgress(`Starting interference check (${assemblyElements.length} assembly${assemblyElements.length > 1 ? "s" : ""})...`);

    // Attach debugger
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    needsDetach = true;
    // await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: true });

    // Wait for debugger banner to appear and page layout to stabilize
    await new Promise(r => setTimeout(r, 500));

    const results = { assemblies: {}, totalInterferences: 0 };

    // Check if assemblies are inside a folder — look for "Assemblies" folder tab
    // (queried AFTER debugger banner settles so coordinates are accurate)
    const folder = await waitForElement(tabId, `(() => {
      const tabs = document.querySelectorAll('.os-tab-bar-tab-group');
      for (const t of tabs) {
        const nameEl = t.querySelector('.os-tab-name');
        if (nameEl && nameEl.textContent.trim() === 'Assemblies' && t.offsetWidth > 0) {
          const r = t.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    })()`, 2000);

    let enteredFolder = false;

    if (folder) {
      // Enter the Assemblies folder to reveal assembly tabs
      console.log(`[Interference] Entering Assemblies folder at (${folder.x}, ${folder.y})`);
      await cdpClick(tabId, folder.x, folder.y);
      // Wait for folder contents to render (assembly tabs appear inside)
      const folderReady = await waitForElement(tabId, `(() => {
        const tabs = document.querySelectorAll('.os-tab-bar-tab[data-icon-src="assembly"]');
        for (const t of tabs) {
          if (t.offsetWidth > 0) return true;
        }
        return null;
      })()`, 5000);
      if (folderReady) {
        enteredFolder = true;
        console.log("[Interference] Assemblies folder contents loaded");
      } else {
        console.log("[Interference] Assemblies folder contents did not load, trying without folder");
      }
    } else {
      console.log("[Interference] No Assemblies folder found, looking for assembly tabs at root");
    }

    for (let i = 0; i < assemblyElements.length; i++) {
      const asm = assemblyElements[i];
      sendProgress(`Checking interference: ${asm.name} (${i + 1}/${assemblyElements.length})...`);
      console.log(`[Interference] ${i + 1}/${assemblyElements.length}: ${asm.name}`);

      try {
        // Find assembly tab — poll up to 3s (may still be rendering after folder entry)
        const tabPos = await waitForElement(tabId, `(() => {
          const tabs = document.querySelectorAll('.os-tab-bar-tab');
          for (const t of tabs) {
            if (t.classList.contains('os-tab-bar-tab-group')) continue;
            const nameEl = t.querySelector('.os-tab-name');
            const iconSrc = t.getAttribute('data-icon-src') || '';
            if (nameEl && nameEl.textContent.trim() === ${JSON.stringify(asm.name)} && iconSrc === 'assembly' && t.offsetWidth > 0) {
              const r = t.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          return null;
        })()`, 3000);

        if (!tabPos) {
          console.log(`[Interference] Tab "${asm.name}" not found after 3s, skipping`);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Tab not found" };
          continue;
        }

        // Click assembly tab to activate
        await cdpClick(tabId, tabPos.x, tabPos.y);

        // Wait for assembly to load: poll for "Show analysis tools" button (up to 15s)
        const analysisBtn = await waitForElement(tabId, `(() => {
          const btn = document.querySelector('[data-bs-original-title="Show analysis tools"], [title="Show analysis tools"]');
          if (btn && btn.offsetWidth > 0) {
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return null;
        })()`, 15000);

        if (!analysisBtn) {
          console.log(`[Interference] Analysis tools button not found for "${asm.name}"`);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Analysis tools not found" };
          continue;
        }

        // Click "Show analysis tools"
        await cdpClick(tabId, analysisBtn.x, analysisBtn.y);

        // Wait for "Interference detection..." menu item (up to 3s)
        const interferenceItem = await waitForElement(tabId, `(() => {
          const items = document.querySelectorAll('span.context-menu-item-span');
          for (const item of items) {
            if (item.textContent.trim().toLowerCase().includes('interference')) {
              const r = item.getBoundingClientRect();
              if (r.width > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: item.textContent.trim() };
            }
          }
          return null;
        })()`, 3000);

        if (!interferenceItem) {
          console.log(`[Interference] Interference menu item not found for "${asm.name}"`);
          await cdpPressKey(tabId, "Escape", 27);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Menu item not found" };
          continue;
        }

        console.log(`[Interference] Opening interference dialog`);
        await cdpClick(tabId, interferenceItem.x, interferenceItem.y);

        // Wait for interference detection dialog (up to 5s)
        const dialogFound = await waitForElement(tabId, `(() => {
          const dialog = document.querySelector('#interference-detection-dialog');
          if (dialog && dialog.offsetWidth > 0) return true;
          return null;
        })()`, 5000);

        if (!dialogFound) {
          console.log(`[Interference] Dialog not found for "${asm.name}"`);
          await cdpPressKey(tabId, "Escape", 27);
          results.assemblies[asm.name] = { interferences: [], count: 0, error: "Dialog not found" };
          continue;
        }

        // Check if instances are already populated (auto-populated in manual flow)
        const hasInstances = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const dialog = document.querySelector('#interference-detection-dialog');
            if (!dialog) return 0;
            const container = dialog.querySelector('[data-parameter-id="bodiesToCheck"]');
            if (!container) return 0;
            return container.querySelectorAll('.os-selection-item-line').length;
          })()`,
          returnByValue: true,
        });
        const instanceCount = hasInstances.result?.value || 0;
        console.log(`[Interference] Instances already populated: ${instanceCount}`);

        if (instanceCount === 0) {
          // Click the bodiesToCheck area to activate selection mode
          const bodiesToCheck = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const dialog = document.querySelector('#interference-detection-dialog');
              if (!dialog) return null;
              const el = dialog.querySelector('[data-parameter-id="bodiesToCheck"]');
              if (el && el.offsetWidth > 0) {
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              }
              return null;
            })()`,
            returnByValue: true,
          });

          if (bodiesToCheck.result?.value) {
            console.log(`[Interference] Clicking bodiesToCheck at (${bodiesToCheck.result.value.x}, ${bodiesToCheck.result.value.y})`);
            await cdpClick(tabId, bodiesToCheck.result.value.x, bodiesToCheck.result.value.y);
            await new Promise(r => setTimeout(r, 500));

            // Click the top-level assembly entry text in the sidebar (right side to avoid left icons)
            const asmEntry = await cdpSend(tabId, "Runtime.evaluate", {
              expression: `(() => {
                const dialog = document.querySelector('#interference-detection-dialog');
                const labels = document.querySelectorAll('.os-list-item-label');
                for (const el of labels) {
                  if (dialog && dialog.contains(el)) continue;
                  if (el.offsetWidth === 0) continue;
                  const text = el.textContent.trim();
                  if (text === ${JSON.stringify(asm.name)}) {
                    const r = el.getBoundingClientRect();
                    return { text, x: Math.round(r.right - 20), y: Math.round(r.top + r.height / 2) };
                  }
                }
                return null;
              })()`,
              returnByValue: true,
            });

            if (asmEntry.result?.value) {
              console.log(`[Interference] Clicking assembly entry: "${asmEntry.result.value.text}" at (${asmEntry.result.value.x}, ${asmEntry.result.value.y})`);
              await cdpClick(tabId, asmEntry.result.value.x, asmEntry.result.value.y);
            }

            // Wait for instances to populate (up to 5s)
            const populated = await waitForElement(tabId, `(() => {
              const dialog = document.querySelector('#interference-detection-dialog');
              if (!dialog) return null;
              const container = dialog.querySelector('[data-parameter-id="bodiesToCheck"]');
              if (!container) return null;
              const items = container.querySelectorAll('.os-selection-item-line');
              return items.length > 0 ? items.length : null;
            })()`, 5000);
            console.log(`[Interference] ${populated || 0} instance(s) selected`);
          }
        }

        // Wait for interference results to compute (poll interferenceBodies for up to 20s)
        console.log("[Interference] Waiting for results to compute...");
        let resultsReady = false;
        for (let poll = 0; poll < 20; poll++) {
          await new Promise(r => setTimeout(r, 1000));
          const snap = await cdpSend(tabId, "Runtime.evaluate", {
            expression: `(() => {
              const dialog = document.querySelector('#interference-detection-dialog');
              if (!dialog) return { open: false };
              const container = dialog.querySelector('[data-parameter-id="interferenceBodies"]');
              const items = container ? container.querySelectorAll('.os-selection-item-line').length : 0;
              const noInt = !!dialog.querySelector('[title="No interferences"]');
              const text = dialog.textContent.toLowerCase();
              const noIntText = text.includes('no interference');
              return { open: true, items, noInt: noInt || noIntText };
            })()`,
            returnByValue: true,
          });
          const s = snap.result?.value || {};
          if (!s.open) { console.log("[Interference] Dialog closed unexpectedly"); break; }
          if (s.items > 0 || s.noInt) { resultsReady = true; break; }
        }

        // Read interference results from dialog
        const intResult = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const dialog = document.querySelector('#interference-detection-dialog');
            if (!dialog) return { interferences: [], count: 0 };
            // "No interferences" indicator
            if (dialog.querySelector('[title="No interferences"]')) return { interferences: [], count: 0 };
            // Read interference pairs from results list
            const container = dialog.querySelector('[data-parameter-id="interferenceBodies"]');
            const items = (container || dialog).querySelectorAll('.os-selection-item-line');
            const pairs = [];
            for (const item of items) {
              const text = item.textContent.trim();
              if (text) pairs.push(text);
            }
            // Fallback: check text content for "no interference"
            if (pairs.length === 0 && dialog.textContent.toLowerCase().includes('no interference')) {
              return { interferences: [], count: 0 };
            }
            return { interferences: pairs, count: pairs.length };
          })()`,
          returnByValue: true,
        });

        const intData = intResult.result?.value || { interferences: [], count: 0 };
        results.assemblies[asm.name] = intData;
        results.totalInterferences += intData.count;
        console.log(`[Interference] ${asm.name}: ${intData.count} interference(s)`, intData.interferences);

        // Close dialog
        const closeBtnPos = await cdpSend(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const dialog = document.querySelector('#interference-detection-dialog');
            if (!dialog) return null;
            const btn = dialog.querySelector('.btn-close.ns-dialog-button-close')
              || dialog.querySelector('.btn-close')
              || dialog.querySelector('[class*="close"]');
            if (btn && btn.offsetWidth > 0) {
              const r = btn.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
            return null;
          })()`,
          returnByValue: true,
        });

        if (closeBtnPos.result?.value) {
          await cdpClick(tabId, closeBtnPos.result.value.x, closeBtnPos.result.value.y);
        } else {
          await cdpPressKey(tabId, "Escape", 27);
        }
        await new Promise(r => setTimeout(r, 500));

      } catch (asmErr) {
        console.error(`[Interference] Error on "${asm.name}":`, asmErr.message);
        results.assemblies[asm.name] = { interferences: [], count: 0, error: asmErr.message };
        try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
      }
    }

    // Navigate back to root if we entered a folder
    if (enteredFolder) {
      const allTabsBtn = await cdpSend(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const crumbs = document.querySelectorAll('.os-tab-bar-breadcrumb');
          for (const c of crumbs) {
            if (c.getAttribute('title') === 'All tabs' || c.textContent.trim() === 'All tabs') {
              const r = c.getBoundingClientRect();
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            }
          }
          if (crumbs.length > 0) {
            const r = crumbs[0].getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
          return null;
        })()`,
        returnByValue: true,
      });
      if (allTabsBtn.result?.value) {
        await cdpClick(tabId, allTabsBtn.result.value.x, allTabsBtn.result.value.y);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Store results in chrome.storage.local
    const stored = await chrome.storage.local.get("interferenceResults");
    const allResults = stored.interferenceResults || {};
    allResults[docId] = {
      timestamp: new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata",
      }),
      assemblies: results.assemblies,
      totalInterferences: results.totalInterferences,
    };
    await chrome.storage.local.set({ interferenceResults: allResults });

    sendDone(results);

    // Browser notification if interferences found
    if (results.totalInterferences > 0) {
      const docName = docScan?.doc_name || docId;
      const affectedCount = Object.values(results.assemblies).filter(a => a.count > 0).length;
      chrome.notifications.create(`interference-${docId}-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: docName,
        message: `${results.totalInterferences} interference(s) detected in ${affectedCount} assembl${affectedCount === 1 ? "y" : "ies"}`,
      });
    }

    console.log(`[Interference] Done: ${results.totalInterferences} total across ${assemblyElements.length} assembly(s)`);

  } catch (e) {
    console.error("[Interference] Fatal error:", e.message);
    try { await cdpPressKey(tabId, "Escape", 27); } catch (_) {}
    sendDone({ totalInterferences: 0, assemblies: {}, error: e.message });
  } finally {
    _interferenceInProgress = false;
    if (needsDetach) {
      // try { await cdpSend(tabId, "Input.setIgnoreInputEvents", { ignore: false }); } catch (_) {}
    }
    // hideCdpOverlay(senderTabId);
    if (needsDetach) chrome.debugger.detach({ tabId }, () => {});
  }
}

// ---------------------------------------------------------------------------
// Bulk Exporter
// ---------------------------------------------------------------------------

// Export flat-pattern DXFs for the provided selection.
// selectedPartStudios: [{ psId, psName, parts: [{partName, deterministicId}] }]
// Returns array of { name: 'dxf/<safeName>.dxf', data: Uint8Array }.
async function bulkExportFlatPatterns(did, wid, selectedPartStudios) {
  const enc = new TextEncoder();

  // Fetch microversion once (plain-text endpoint)
  const mvResp = await fetch(`${ONSHAPE_BASE}/api/v14/documents/d/${did}/w/${wid}/microversion`, {
    credentials: "include",
    headers: { Accept: "text/plain, */*" },
  });
  if (!mvResp.ok) throw new Error(`Microversion fetch failed: ${mvResp.status}`);
  const microversion = (await mvResp.text()).trim();
  console.log("[BulkExport] Microversion:", microversion);

  const xsrf = await getXsrfToken();
  const files = [];

  for (const ps of selectedPartStudios) {
    console.log("[BulkExport]", ps.psName, "parts:", ps.parts.length);
    chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `${ps.psName}: ${ps.parts.length} flat pattern(s)` }).catch(() => {});

    for (const item of ps.parts) {
      const body = {
        format: "DXF",
        microversion,
        view: "1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1",
        destinationName: (item.partName || "FlatPattern") + "_export",
        version: "Release 14",
        units: "millimeter",
        flatten: "true",
        includeBendCenterlines: "true",
        includeSketches: "true",
        sheetMetalFlat: "true",
        triggerAutoDownload: "true",
        storeInDocument: "false",
        configuration: ps.configuration || "",
        cloudStorageAccountId: "",
        cloudObjectId: "",
        partIds: item.deterministicId,
      };
      try {
        const r = await fetch(
          `${ONSHAPE_BASE}/api/documents/d/${did}/w/${wid}/e/${ps.psId}/exportinternal`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              Accept: "application/json, text/plain, */*",
              "Content-Type": "application/json;charset=UTF-8",
              "X-XSRF-TOKEN": xsrf,
            },
            body: JSON.stringify(body),
          }
        );
        if (!r.ok) {
          const errBody = await r.text();
          console.warn("[BulkExport] DXF failed:", item.partName, r.status, errBody.slice(0, 200));
          chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  SKIP ${item.partName} (${r.status})` }).catch(() => {});
          continue;
        }
        const dxfText = await r.text();
        const safeName = (item.partName || "FlatPattern").replace(/[^a-zA-Z0-9_\-]/g, "_") + ".dxf";
        files.push({ name: "dxf/" + safeName, data: enc.encode(dxfText) });
        console.log("[BulkExport] DXF ok:", safeName, dxfText.length, "bytes");
        chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  DXF: ${safeName}` }).catch(() => {});
      } catch (e) {
        console.warn("[BulkExport] DXF error:", item.partName, e.message);
        chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  ERROR ${item.partName}: ${e.message}` }).catch(() => {});
      }
    }
  }

  return files;
}

// Export drawings as PDFs for the provided selection.
// selectedDrawings: [{ id, name }]
// Returns array of { name: 'pdf/<safeName>.pdf', data: Uint8Array }.
async function bulkExportDrawingPdfs(did, wid, selectedDrawings) {
  console.log("[BulkExport] Drawing elements:", selectedDrawings.map(e => e.name));
  chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `${selectedDrawings.length} drawing(s) to export` }).catch(() => {});

  // Fire all PDF translation jobs in parallel
  const jobs = await Promise.all(selectedDrawings.map(async el => {
    try {
      const job = await onshapePost(
        `/api/v6/drawings/d/${did}/w/${wid}/e/${el.id}/translations`,
        { formatName: "PDF", storeInDocument: false }
      );
      return { name: el.name, jobId: job.id, documentId: job.documentId || did };
    } catch (e) {
      console.warn("[BulkExport] PDF job failed:", el.name, e.message);
      chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  PDF job failed: ${el.name}` }).catch(() => {});
      return null;
    }
  }));

  // 3. Poll + collect binary
  const files = [];
  for (const job of jobs.filter(Boolean)) {
    let t;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      t = await onshapeFetch(`/api/v6/translations/${job.jobId}`);
      if (t.requestState !== "ACTIVE") break;
    }
    if (!t || t.requestState !== "DONE" || !t.resultExternalDataIds?.length) {
      console.warn("[BulkExport] PDF failed:", job.name, t?.requestState, t?.failureReason || "");
      chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  PDF failed: ${job.name}` }).catch(() => {});
      continue;
    }
    try {
      const resp = await fetch(
        `${ONSHAPE_BASE}/api/v6/documents/d/${t.documentId || did}/externaldata/${t.resultExternalDataIds[0]}`,
        { credentials: "include" }
      );
      if (!resp.ok) throw new Error(`blob fetch ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      const safeName = (job.name || "Drawing").replace(/[^a-zA-Z0-9_\-]/g, "_") + ".pdf";
      files.push({ name: "pdf/" + safeName, data });
      console.log("[BulkExport] PDF ok:", safeName, data.length, "bytes");
      chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  PDF: ${safeName}` }).catch(() => {});
    } catch (e) {
      console.warn("[BulkExport] PDF blob error:", job.name, e.message);
      chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `  PDF blob error: ${job.name}` }).catch(() => {});
    }
  }

  return files;
}

// Pure-JS ZIP builder — no dependencies.
function crc32(buf) {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const locals = [], dirs = [];
  let off = 0;
  for (const { name, data } of files) {
    const nb = enc.encode(name), crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length + data.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nb.length, true); lh.set(nb, 30); lh.set(data, 30 + nb.length);
    locals.push(lh);
    const cd = new Uint8Array(46 + nb.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true); cv.setUint32(42, off, true); cd.set(nb, 46);
    dirs.push(cd); off += lh.length;
  }
  const cdOff = off, cdSize = dirs.reduce((s, d) => s + d.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdOff, true);
  const all = [...locals, ...dirs, eocd];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let pos = 0; for (const a of all) { out.set(a, pos); pos += a.length; }
  return out;
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

// ---------------------------------------------------------------------------
// URDF Export
// ---------------------------------------------------------------------------

function urdfSafeName(s) {
  return String(s || "link").replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\-]/g, "");
}
function urdfEscXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Row-major 4×4 occurrence transform → [roll, pitch, yaw] (radians)
// Onshape layout: [r00,r01,r02,tx, r10,r11,r12,ty, r20,r21,r22,tz, 0,0,0,1]
// R[i,j] = t[i*4+j]
function urdfRotToRpy(t) {
  const R00=t[0], R10=t[4], R20=t[8];
  const R01=t[1], R11=t[5], R21=t[9];
  const R22=t[10];
  const pitch = Math.atan2(-R20, Math.sqrt(R00*R00 + R10*R10));
  const cp = Math.cos(pitch);
  const yaw  = Math.abs(cp) < 1e-6 ? Math.atan2(-R01, R11) : Math.atan2(R10 / cp, R00 / cp);
  const roll = Math.abs(cp) < 1e-6 ? 0 : Math.atan2(R21 / cp, R22 / cp);
  return [roll, pitch, yaw];
}

// Row-major 4×4 matrix multiply: C = A * B
function urdfMat4Mul(A, B) {
  const C = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++)
        C[i*4+j] += A[i*4+k] * B[k*4+j];
  return C;
}

// Invert a rigid-body 4×4 transform (row-major): R^T for rotation, -R^T*t for translation.
function urdfMat4RigidInv(T) {
  const inv = new Array(16).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      inv[i*4+j] = T[j*4+i];
  inv[3]  = -(inv[0]*T[3] + inv[1]*T[7]  + inv[2]*T[11]);
  inv[7]  = -(inv[4]*T[3] + inv[5]*T[7]  + inv[6]*T[11]);
  inv[11] = -(inv[8]*T[3] + inv[9]*T[7]  + inv[10]*T[11]);
  inv[15] = 1;
  return inv;
}

// Build a row-major 4×4 rigid transform from matedCS { xAxis, yAxis, zAxis, origin }.
// matedCS defines a frame in the part's local space; columns of R = [xAxis | yAxis | zAxis].
function urdfMatedCSToMat4(cs) {
  const x = cs.xAxis || [1,0,0], y = cs.yAxis || [0,1,0], z = cs.zAxis || [0,0,1];
  const o = cs.origin || [0,0,0];
  return [
    x[0], y[0], z[0], o[0],
    x[1], y[1], z[1], o[1],
    x[2], y[2], z[2], o[2],
    0,    0,    0,    1,
  ];
}

// Evaluate a simple Onshape expression or pre-evaluated numeric to a float in SI units.
// Handles plain numbers (SI: rad for angles, m for lengths), "N deg"/"N°" → rad,
// "N mm" → m, "N cm" → m, "N in" → m.  Returns NaN for unrecognised strings.
function evalLimitExpr(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return NaN;
  const s = String(v).trim();
  const m = s.match(/^([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s*(deg|°|rad|mm|cm|in|m)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  switch ((m[2] || "").toLowerCase()) {
    case "deg": case "°": return n * Math.PI / 180;
    case "mm":            return n / 1000;
    case "cm":            return n / 100;
    case "in":            return n * 0.0254;
    default:              return n;   // rad, m, or bare number — already SI
  }
}

// Extract mate feature parameters into a flat { parameterId: value } map.
// - BTMParameterBoolean:          p.message.value (JS boolean)
// - BTMParameterNullableQuantity: p.message.value (pre-evaluated SI float) || p.message.expression
// - BTMParameterConfigured:       best-effort — expression/value from first values[] entry
//   (not configuration-aware; evalLimitExpr returns NaN for unresolvable exprs → default applied)
function extractMateParams(featureMessage) {
  const params = {};
  for (const p of featureMessage.parameters || []) {
    const pid = p.message?.parameterId;
    if (!pid) continue;
    let val = p.message?.value ?? p.message?.expression;
    if (val === undefined && p.message?.values?.length) {
      // BTMParameterConfigured — use the first configured value's expression as a best-effort default.
      val = p.message.values[0]?.message?.value?.message?.expression
         ?? p.message.values[0]?.message?.value?.message?.value;
    }
    if (val !== undefined) params[pid] = val;
  }
  return params;
}

async function generateUrdf(did, wid, eid, configuration) {
  const bcast = (msg, cls) =>
    chrome.runtime.sendMessage({ type: "urdf-progress", message: msg, cls }).catch(() => {});

  const cfgParam = configuration ? `&configuration=${encodeURIComponent(configuration)}` : "";
  bcast("Fetching assembly definition...");
  // includeMateFeatures/includeMateConnectors ensure rootAssembly.features is populated;
  // includeNonSolids captures surface bodies that may appear in mates.
  const asmDef = await onshapeFetch(
    `/api/v9/assemblies/d/${did}/w/${wid}/e/${eid}` +
    `?includeMateFeatures=true&includeMateConnectors=true&includeNonSolids=true${cfgParam}`
  );
  const robotName = urdfSafeName(asmDef.name || "robot");

  // Pin to the assembly's microversion so the features fetch is consistent with
  // the occurrences snapshot even if the document is edited during export.
  const microVid = asmDef.rootAssembly?.documentMicroversion;
  bcast("Fetching assembly features...");
  const featEndpoint = microVid
    ? `/api/v9/assemblies/d/${did}/m/${microVid}/e/${eid}/features`
    : `/api/v9/assemblies/d/${did}/w/${wid}/e/${eid}/features`;
  const featResp = await onshapeFetch(featEndpoint);
  const features = featResp.features || [];

  // Fetch current mate positions (offsets) so limit values can be adjusted to be
  // relative to the assembly's rest position (URDF convention: 0 = rest).
  // This endpoint only works against a workspace, not a microversion.
  bcast("Fetching mate values...");
  const mateValuesMap = {}; // mateName → { rotationZ?, translationZ? }
  try {
    const mv = await onshapeFetch(
      `/api/v9/assemblies/d/${did}/w/${wid}/e/${eid}/matevalues`
    );
    // Onshape returns either "mateValues" or "matedValues" depending on API version.
    const entries = mv?.mateValues ?? mv?.matedValues ?? [];
    for (const entry of entries) {
      if (entry.mateName) mateValuesMap[entry.mateName] = entry;
    }
    bcast(`  ${Object.keys(mateValuesMap).length} mate value(s) loaded.`);
  } catch (e) {
    bcast(`  NOTE: mate values unavailable — limits not offset-adjusted (${e.message})`, "log-warn");
  }

  // ---------------------------------------------------------------------------
  // Build full instance + occurrence maps covering all sub-assembly depths
  // ---------------------------------------------------------------------------

  // Index sub-assemblies by "documentId:elementId" for recursive lookup
  const subAsmByElemKey = {};
  for (const sa of asmDef.subAssemblies || []) {
    subAsmByElemKey[`${sa.documentId || did}:${sa.elementId}`] = sa;
  }

  // Recursively index ALL instances (root + every sub-assembly depth) by instance ID
  const allInstById = {};
  function indexInstances(instances) {
    for (const inst of instances) {
      allInstById[inst.id] = inst;
      if (inst.type === "Assembly") {
        const sa = subAsmByElemKey[`${inst.documentId || did}:${inst.elementId}`];
        if (sa) indexInstances(sa.instances || []);
      }
    }
  }
  indexInstances(asmDef.rootAssembly?.instances || []);

  // Build occurrence map keyed on full path string; collect all leaf Part occurrences.
  // rootAssembly.occurrences already contains ALL occurrences at every nesting depth
  // with world-frame transforms pre-computed by Onshape.
  const occByKey = {};    // path string → occurrence
  const allPartOccs = []; // { occ, inst, key } for every part occurrence
  for (const occ of asmDef.rootAssembly?.occurrences || []) {
    const key      = occ.path.join("/");
    occByKey[key]  = occ;
    const leafInst = allInstById[occ.path[occ.path.length - 1]];
    if (leafInst?.type === "Part") allPartOccs.push({ occ, inst: leafInst, key });
  }

  bcast(`${allPartOccs.length} part occurrence(s), ${features.length} feature(s)`);

  // Assign unique link names — keyed on occurrence key (not instance id) so that
  // the same part geometry placed multiple times gets distinct link names
  const usedLinkNames = new Set();
  const occLinkName   = new Map(); // occKey → unique link name
  for (const { inst, key } of allPartOccs) {
    let base = urdfSafeName(inst.name || inst.id) || "link";
    let name = base, suffix = 2;
    while (usedLinkNames.has(name)) name = `${base}_${suffix++}`;
    usedLinkNames.add(name);
    occLinkName.set(key, name);
  }

  // Deduplicate parts by geometry key for STL export (one mesh file per unique geometry)
  const partKeyOf = inst => `${inst.partId}|${inst.elementId}|${inst.documentId || did}`;
  const uniquePartMap = {};
  for (const { inst } of allPartOccs) {
    const k = partKeyOf(inst);
    if (!uniquePartMap[k]) uniquePartMap[k] = inst;
  }
  const uniqueKeys = Object.keys(uniquePartMap);

  // ---------------------------------------------------------------------------
  // STL export — direct /parts/.../stl endpoint (no translation job polling)
  // ---------------------------------------------------------------------------
  const STL_WARN = 40;
  const keyToMesh = {};
  const stlFiles  = [];
  const wvidCache = {}; // docId → workspace id for external docs (shared with mass props)

  if (uniqueKeys.length > STL_WARN) {
    bcast(`NOTE: ${uniqueKeys.length} unique parts — export may take several minutes.`, "log-warn");
  }
  bcast(`Exporting ${uniqueKeys.length} STL mesh(es)...`);
  for (const key of uniqueKeys) {
    const inst  = uniquePartMap[key];
    const safe  = urdfSafeName(inst.name || inst.partId || "part");
    const fname = `meshes/${safe}.stl`;
    bcast(`  ${inst.name || inst.partId}...`);
    try {
      const exportDid = inst.documentId || did;
      let wvm;
      if (exportDid === did) {
        wvm = `w/${wid}`;
      } else if (inst.documentVersion) {
        wvm = `v/${inst.documentVersion}`;
      } else {
        if (!wvidCache[exportDid]) {
          const docInfo = await onshapeFetch(`/api/v10/documents/${exportDid}`);
          const exWid = docInfo?.defaultWorkspace?.id;
          if (!exWid) throw new Error(`no workspace found for external doc ${exportDid}`);
          wvidCache[exportDid] = exWid;
        }
        wvm = `w/${wvidCache[exportDid]}`;
      }
      const resp = await fetch(
        `${ONSHAPE_BASE}/api/v6/parts/d/${exportDid}/${wvm}/e/${inst.elementId}` +
        `/partid/${encodeURIComponent(inst.partId)}/stl?mode=binary&units=meter`,
        { credentials: "include" }
      );
      if (!resp.ok) throw new Error(`STL ${resp.status}`);
      const data = new Uint8Array(await resp.arrayBuffer());
      stlFiles.push({ name: fname, data });
      keyToMesh[key] = fname;
      bcast(`  OK: ${safe}.stl`, "log-ok");
    } catch (e) {
      bcast(`  ERROR: ${inst.name}: ${e.message}`, "log-err");
      keyToMesh[key] = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Mass properties — per-part /parts/.../massproperties with useMassPropertyOverrides
  // ---------------------------------------------------------------------------
  bcast("Fetching mass properties...");
  const massPropsMap = {}; // partKey → { mass, centroid, inertia }

  // 3×3 inertia change-of-basis: I_local = R^T * I_world * R
  // Onshape may return inertia as 9 or 12 elements (12 = 3×4 with zero padding per row)
  function transformInertia(iw, linkTr) {
    const stride = iw.length >= 12 ? 4 : 3;
    const I  = [[iw[0], iw[1], iw[2]],
                [iw[stride], iw[stride+1], iw[stride+2]],
                [iw[2*stride], iw[2*stride+1], iw[2*stride+2]]];
    const R  = [[linkTr[0],linkTr[1],linkTr[2]],
                [linkTr[4],linkTr[5],linkTr[6]],
                [linkTr[8],linkTr[9],linkTr[10]]];
    const RT = [[R[0][0],R[1][0],R[2][0]],[R[0][1],R[1][1],R[2][1]],[R[0][2],R[1][2],R[2][2]]];
    const mul = (A, B) => A.map((_, i) => [0,1,2].map(j => [0,1,2].reduce((s,k) => s+A[i][k]*B[k][j], 0)));
    const il = mul(mul(RT, I), R);
    return { ixx:il[0][0], ixy:il[0][1], ixz:il[0][2], iyy:il[1][1], iyz:il[1][2], izz:il[2][2] };
  }

  for (const pkey of uniqueKeys) {
    const inst      = uniquePartMap[pkey];
    const exportDid = inst.documentId || did;
    const wvm       = exportDid === did          ? `w/${wid}` :
                      inst.documentVersion       ? `v/${inst.documentVersion}` :
                      wvidCache[exportDid]       ? `w/${wvidCache[exportDid]}` : `w/${wid}`;
    try {
      const mp = await onshapeFetch(
        `/api/v6/parts/d/${exportDid}/${wvm}/e/${inst.elementId}` +
        `/partid/${encodeURIComponent(inst.partId)}/massproperties?useMassPropertyOverrides=true`
      );
      // Per-part endpoint returns properties at top level (not nested under .bodies)
      if (mp) {
        massPropsMap[pkey] = {
          mass:     mp.mass?.[0]    ?? 1.0,
          centroid: mp.centroid     ?? [0, 0, 0],
          inertia:  mp.inertia      ?? Array(12).fill(0),
        };
      }
    } catch (e) {
      bcast(`  Mass props failed: ${inst.name}: ${e.message}`, "log-warn");
    }
  }

  // ---------------------------------------------------------------------------
  // Parse mates → joints
  // matedCS is in the part's local frame. Compose T_world_part @ T_part_mate to
  // get the joint frame in world space, then invert the parent transform to get
  // it in the parent-link frame for the URDF <origin> tag.
  // ---------------------------------------------------------------------------
  bcast("Building joints from mates...");
  const joints    = [];
  const childKeys = new Set(); // occurrence keys that are children of a mate joint

  for (const feat of features) {
    const m = feat.message || {};
    if (m.featureType !== "mate" || m.suppressed) continue;
    const ents = m.matedEntities || [];
    if (ents.length < 2) continue;
    const pKey = ents[0].matedOccurrence?.join("/");
    const cKey = ents[1].matedOccurrence?.join("/");
    if (!pKey || !cKey || pKey === cKey) continue;
    const pOcc  = occByKey[pKey];
    const cOcc  = occByKey[cKey];
    if (!pOcc || !cOcc) continue;
    const pInst = allInstById[pOcc.path[pOcc.path.length - 1]];
    const cInst = allInstById[cOcc.path[cOcc.path.length - 1]];
    if (!pInst || !cInst) continue;
    if (pInst.type !== "Part" || cInst.type !== "Part") continue;

    const mateType = m.mateType || "FASTENED";

    let jointType;
    switch (mateType) {
      case "REVOLUTE":    jointType = "revolute";  break;
      case "SLIDER":      jointType = "prismatic"; break;
      case "CYLINDRICAL": jointType = "revolute";
        bcast(`  WARNING: CYLINDRICAL mate "${m.name || pKey}" exported as revolute — prismatic DOF dropped`, "log-warn");
        break;
      case "BALL":        jointType = "revolute";
        bcast(`  WARNING: BALL mate "${m.name || pKey}" approximated as revolute — full 3-DOF not represented`, "log-warn");
        break;
      case "PLANAR":      jointType = "floating";  break;
      default:            jointType = "fixed";     break;
    }

    // Build the joint frame from matedCS (part-local) composed with world transform.
    // T_world_mate = T_world_part @ T_part_mate
    // T_parent_joint = inv(T_world_parent) @ T_world_mate
    const mcs          = ents[0].matedCS || {};
    const T_part_mate  = urdfMatedCSToMat4(mcs);
    const T_world_mate = pOcc.transform
      ? urdfMat4Mul(pOcc.transform, T_part_mate)
      : T_part_mate;
    const T_parent_joint = pOcc.transform
      ? urdfMat4Mul(urdfMat4RigidInv(pOcc.transform), T_world_mate)
      : T_world_mate;

    const localOrigin = [T_parent_joint[3], T_parent_joint[7], T_parent_joint[11]];
    const localRpy    = urdfRotToRpy(T_parent_joint);
    // Axis is the joint frame's z-axis (col 2 of the rotation block), already in parent frame.
    // Because <origin rpy> encodes the full frame rotation, we simply emit [0,0,1] here —
    // the simulator applies origin first, so the z-axis of the rotated frame is the actual axis.
    const localAxis   = [0, 0, 1];

    const mparams    = extractMateParams(m);
    const limitsEnabled = mparams["limitsEnabled"] === true || mparams["limitsEnabled"] === "true";
    let limitLower, limitUpper;
    if (limitsEnabled && jointType === "revolute") {
      limitLower = evalLimitExpr(mparams["limitAxialZMin"]);
      limitUpper = evalLimitExpr(mparams["limitAxialZMax"]);
      if (isNaN(limitLower)) limitLower = -3.14159;
      if (isNaN(limitUpper)) limitUpper =  3.14159;
    } else if (limitsEnabled && jointType === "prismatic") {
      limitLower = evalLimitExpr(mparams["limitZMin"]);
      limitUpper = evalLimitExpr(mparams["limitZMax"]);
      if (isNaN(limitLower)) limitLower = -0.1;
      if (isNaN(limitUpper)) limitUpper =  0.1;
    } else {
      limitLower = jointType === "revolute" ? -3.14159 : -0.1;
      limitUpper = jointType === "revolute" ?  3.14159 :  0.1;
    }

    // Adjust limits by the mate's current rest position so that URDF position 0
    // corresponds to the assembly's default configuration (matches onshape-to-robot behaviour).
    const mateEntry = mateValuesMap[m.name || ""];
    if (mateEntry && limitsEnabled) {
      if (jointType === "revolute" && mateEntry.rotationZ != null) {
        limitLower -= mateEntry.rotationZ;
        limitUpper -= mateEntry.rotationZ;
      } else if (jointType === "prismatic" && mateEntry.translationZ != null) {
        limitLower -= mateEntry.translationZ;
        limitUpper -= mateEntry.translationZ;
      }
    }

    // URDF requires each link to have exactly one parent joint.  If this occurrence
    // was already claimed as a child by an earlier mate, skip this joint to avoid
    // producing an invalid URDF forest.
    if (childKeys.has(cKey)) {
      bcast(`  WARNING: "${m.name || cKey}" skipped — occurrence already parented by an earlier mate (URDF requires a single parent per link)`, "log-warn");
      continue;
    }

    joints.push({
      name: urdfSafeName(m.name || `joint_${joints.length}`),
      type: jointType, pKey, cKey,
      origin: localOrigin, rpy: localRpy, axis: localAxis,
      limitLower, limitUpper,
    });
    childKeys.add(cKey);
  }

  // ---------------------------------------------------------------------------
  // Build URDF XML
  // ---------------------------------------------------------------------------
  bcast("Writing URDF...");
  let xml = `<?xml version="1.0"?>\n<robot name="${urdfEscXml(robotName)}">\n\n`;
  xml += `  <!-- Generated by Onshape Assistant URDF Export -->\n\n`;
  xml += `  <link name="base_link"/>\n\n`;

  // One link per part occurrence — STL in meters, no scale tag needed
  for (const { inst, occ, key } of allPartOccs) {
    const lname = occLinkName.get(key);
    const mesh  = keyToMesh[partKeyOf(inst)];
    xml += `  <link name="${urdfEscXml(lname)}">\n`;
    const mp = massPropsMap[partKeyOf(inst)];
    if (mp && mp.mass > 0) {
      const tr   = occ?.transform;
      // Centroid is returned in world frame; express it in link-local frame via R^T*(c-t).
      const dx = mp.centroid[0] - (tr?.[3]  ?? 0);
      const dy = mp.centroid[1] - (tr?.[7]  ?? 0);
      const dz = mp.centroid[2] - (tr?.[11] ?? 0);
      const cl  = tr
        ? [tr[0]*dx+tr[4]*dy+tr[8]*dz, tr[1]*dx+tr[5]*dy+tr[9]*dz, tr[2]*dx+tr[6]*dy+tr[10]*dz]
        : mp.centroid;
      const iner = tr ? transformInertia(mp.inertia, tr)
                      : { ixx:0, ixy:0, ixz:0, iyy:0, iyz:0, izz:0 };
      xml += `    <inertial>\n`;
      xml += `      <origin xyz="${cl[0].toFixed(6)} ${cl[1].toFixed(6)} ${cl[2].toFixed(6)}" rpy="0 0 0"/>\n`;
      xml += `      <mass value="${mp.mass.toFixed(6)}"/>\n`;
      xml += `      <inertia ixx="${iner.ixx.toFixed(9)}" ixy="${iner.ixy.toFixed(9)}" ixz="${iner.ixz.toFixed(9)}" iyy="${iner.iyy.toFixed(9)}" iyz="${iner.iyz.toFixed(9)}" izz="${iner.izz.toFixed(9)}"/>\n`;
      xml += `    </inertial>\n`;
    }
    if (mesh) {
      const pkg = `package://${urdfEscXml(robotName)}/${urdfEscXml(mesh)}`;
      xml += `    <visual><geometry><mesh filename="${pkg}"/></geometry></visual>\n`;
      xml += `    <collision><geometry><mesh filename="${pkg}"/></geometry></collision>\n`;
    }
    xml += `  </link>\n\n`;
  }

  // Joints from mates — origin encodes both position and orientation of the joint frame
  for (const j of joints) {
    const pname = occLinkName.get(j.pKey) || j.pKey;
    const cname = occLinkName.get(j.cKey) || j.cKey;
    const [ox, oy, oz]   = j.origin;
    const [ro, rp, ry]   = j.rpy;
    const [ax, ay, az]   = j.axis;
    xml += `  <joint name="${urdfEscXml(j.name)}" type="${j.type}">\n`;
    xml += `    <parent link="${urdfEscXml(pname)}"/>\n`;
    xml += `    <child link="${urdfEscXml(cname)}"/>\n`;
    xml += `    <origin xyz="${ox.toFixed(6)} ${oy.toFixed(6)} ${oz.toFixed(6)}" rpy="${ro.toFixed(6)} ${rp.toFixed(6)} ${ry.toFixed(6)}"/>\n`;
    if (j.type !== "fixed" && j.type !== "floating") {
      xml += `    <axis xyz="${ax.toFixed(4)} ${ay.toFixed(4)} ${az.toFixed(4)}"/>\n`;
    }
    if (j.type === "revolute") {
      xml += `    <limit lower="${j.limitLower.toFixed(6)}" upper="${j.limitUpper.toFixed(6)}" effort="100" velocity="1"/>\n`;
    } else if (j.type === "prismatic") {
      xml += `    <limit lower="${j.limitLower.toFixed(6)}" upper="${j.limitUpper.toFixed(6)}" effort="100" velocity="0.1"/>\n`;
    }
    xml += `  </joint>\n\n`;
  }

  // Occurrences not assigned as children of any mate → fixed to base_link at world pose
  for (const { inst, occ, key } of allPartOccs) {
    if (childKeys.has(key)) continue;
    const lname = occLinkName.get(key);
    let xyz = "0 0 0", rpy = "0 0 0";
    if (occ?.transform) {
      const tr = occ.transform;
      xyz = `${tr[3].toFixed(6)} ${tr[7].toFixed(6)} ${tr[11].toFixed(6)}`;
      rpy = urdfRotToRpy(tr).map(n => n.toFixed(6)).join(" ");
    }
    xml += `  <joint name="base_to_${urdfEscXml(lname)}" type="fixed">\n`;
    xml += `    <parent link="base_link"/>\n`;
    xml += `    <child link="${urdfEscXml(lname)}"/>\n`;
    xml += `    <origin xyz="${xyz}" rpy="${rpy}"/>\n`;
    xml += `  </joint>\n\n`;
  }

  xml += `</robot>\n`;

  bcast("Packaging ZIP...");
  const enc = new TextEncoder();
  const zip = makeZip([{ name: "robot.urdf", data: enc.encode(xml) }, ...stlFiles]);
  const zipBase64 = toBase64(zip);
  const zipName   = `${robotName}_urdf.zip`;
  bcast(`Done — ${stlFiles.length} STL(s) + robot.urdf`, "log-ok");
  chrome.runtime.sendMessage({ type: "urdf-done", zipBase64, zipName }).catch(() => {});
}

// ---------------------------------------------------------------------------
// SW keepalive — accept persistent ports from content.js to prevent idle termination
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener(port => {
  if (port.name === "keepalive") {
    port.onDisconnect.addListener(() => {});  // no-op; content.js reconnects automatically
  }
});

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // check-kill-switch must respond even when disabled, so content.js knows to stop
  // Also check storage cache in case the async startup read hasn't finished yet
  if (msg.type === "check-kill-switch") {
    if (_extensionDisabled) {
      sendResponse({ disabled: true });
    } else {
      chrome.storage.local.get("killSwitchUntil").then(({ killSwitchUntil }) => {
        if (killSwitchUntil && Date.now() < killSwitchUntil) {
          applyKillSwitch("cached (from msg handler)");
          sendResponse({ disabled: true });
        } else {
          sendResponse({ disabled: false });
        }
      }).catch(() => sendResponse({ disabled: false }));
      return true; // keep message channel open for async response
    }
    return;
  }

  if (_extensionDisabled) return; // kill switch active — ignore all messages

  if (msg.type === "fetch-ps-configs") {
    const { url, did: msgDid, wid: msgWid, eid: msgEid } = msg;
    sendResponse({ ok: true });
    (async () => {
      try {
        let did, wid, eid;
        if (url) {
          const parsed = parsePartStudioUrl(url);
          if (!parsed) throw new Error("Invalid URL");
          ({ docId: did, wid, eid } = parsed);
        } else {
          did = msgDid; wid = msgWid; eid = msgEid;
        }
        if (!did || !wid || !eid) throw new Error("Missing did/wid/eid");
        const cfg = await onshapeFetch(`/api/v10/elements/d/${did}/w/${wid}/e/${eid}/configuration`);
        const rawParams = cfg?.configurationParameters || [];
        const currentCfg = {};
        (cfg?.currentConfiguration || []).forEach(p => {
          const pm = p.message || p;
          currentCfg[pm.parameterId] = pm.value;
        });
        const params = rawParams.map(p => {
          const m = p.message || p;
          const typeStr = (p.btType || p.type || "").toLowerCase();
          const id = m.parameterId;
          const name = m.parameterName || id;
          const defaultVal = String(currentCfg[id] ?? m.defaultValue ?? "");
          if (typeStr.includes("enum")) {
            return {
              type: "enum", id, name, defaultValue: defaultVal,
              values: (m.options || []).map(opt => ({ value: opt.option, label: opt.optionName || opt.option }))
            };
          } else if (typeStr.includes("boolean")) {
            return { type: "boolean", id, name, defaultValue: defaultVal };
          } else {
            return { type: "quantity", id, name, defaultValue: defaultVal, unitSpec: m.units || "" };
          }
        });
        chrome.runtime.sendMessage({ type: "ps-configs-loaded", eid, params }).catch(() => {});
      } catch (e) {
        chrome.runtime.sendMessage({ type: "ps-configs-error", eid: msgEid, error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "fetch-parts") {
    // Fetch parts list and return to popup for selection
    (async () => {
      const parsed = parsePartStudioUrl(msg.url || "");
      if (!parsed) { sendResponse({ error: "Invalid Part Studio URL" }); return; }
      if (await isDocDisabled(parsed.docId)) {
        sendResponse({ error: "Extension disabled for this document." });
        return;
      }
      try {
        const configParam = msg.configuration ? `?configuration=${encodeURIComponent(msg.configuration)}` : "";
        const parts = await onshapeFetch(`/api/v10/parts/d/${parsed.docId}/w/${parsed.wid}/e/${parsed.eid}${configParam}`);
        if (!parts || parts.length === 0) { sendResponse({ error: "No parts found" }); return; }
        // Return minimal part data to popup
        const partList = parts.map(p => ({ partId: p.partId, name: p.name || "Unnamed" }));
        sendResponse({ parts: partList });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true; // async sendResponse

  } else if (msg.type === "create-drawings") {
    (async () => {
      const docId = (msg.url || "").match(/\/documents\/([a-f0-9]+)/)?.[1];
      if (docId && await isDocDisabled(docId)) {
        sendResponse({ error: "Extension disabled for this document." });
        return;
      }
      createDrawingsForUrl(msg.url, msg.selectedParts || null);
      sendResponse({ ok: true });
    })();
    return true;

  } else if (msg.type === "fetch-drawing-elements") {
    (async () => {
      const { did, wid } = msg;
      try {
        const data = await onshapeFetch(`/api/v10/documents/d/${did}/w/${wid}/elements`);
        const drawings = (data || [])
          .filter(e => e.dataType === "onshape-app/drawing")
          .map(e => ({ id: e.id, name: e.name || "Untitled Drawing" }));
        sendResponse({ drawings });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "apply-drawing-notes") {
    sendResponse({ ok: true });
    (async () => {
      const { did, wid, drawings, height } = msg;
      const textHeight = height || 4.0;
      const broadcast = (message, cls) =>
        chrome.runtime.sendMessage({ type: "notes-progress", message, cls }).catch(() => {});

      for (const drawing of drawings) {
        broadcast(`Applying to "${drawing.name}"...`);
        try {
          const body = {
            description: "Add note",
            jsonRequests: [{
              messageName: "onshapeCreateAnnotations",
              formatVersion: "2021-01-01",
              annotations: [{
                type: "Onshape::Note",
                note: {
                  position: { type: "Onshape::Reference::Point", coordinate: [20, 50, 0] },
                  contents: drawing.text,
                  textHeight,
                },
              }],
            }],
          };
          const json = await onshapePost(`/api/v6/drawings/d/${did}/w/${wid}/e/${drawing.id}/modify`, body);
          await pollModify(did, wid, drawing.id, json.id, 30);
          broadcast(`✓ ${drawing.name}`, "log-ok");
        } catch (e) {
          broadcast(`✗ ${drawing.name}: ${e.message}`, "log-err");
        }
      }
      chrome.runtime.sendMessage({ type: "notes-done" }).catch(() => {});
    })();
    return;

  } else if (msg.type === "tab-folder-result") {
    // Auto-scan result from content.js — store per doc
    storeDocScanResult(msg.data);

  } else if (msg.type === "folder-scan-notify") {
    // Delayed notification from content.js (10s after scan found illegal tabs)
    chrome.notifications.create(`folder-scan-${msg.docId}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: msg.docName || msg.docId,
      message: "Incorrect folder structure, please take action.",
    });

  } else if (msg.type === "feature-count-notify") {
    chrome.notifications.create(`feature-count-${msg.eid}-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: msg.docName || msg.docId,
      message: `You are approaching the limit of 250 features, switch to a new Part Studio or the current one will be disabled.`,
    });

  } else if (msg.type === "check-releases") {
    (async () => {
      try {
        const [revData, docData] = await Promise.all([
          onshapeFetch(`/api/v10/revisions/d/${msg.docId}`),
          onshapeFetch(`/api/v10/documents/${msg.docId}`)
        ]);
        const items = revData.items || [];
        if (items.length === 0) {
          console.log(`[ExportDetect] Doc ${msg.docId}: no revisions`);
          sendResponse({ hasReleases: false, staleRevision: false, count: 0 });
          return;
        }
        const latestRevAt = items
          .map(r => new Date(r.createdAt).getTime())
          .reduce((a, b) => Math.max(a, b), 0);
        const modifiedAt = new Date(docData.modifiedAt).getTime();
        const stale = modifiedAt > latestRevAt;
        console.log(`[ExportDetect] Doc ${msg.docId}: ${items.length} revision(s), latest=${new Date(latestRevAt).toISOString()}, modifiedAt=${docData.modifiedAt}, stale=${stale}`);
        sendResponse({ hasReleases: true, staleRevision: stale, count: items.length });
      } catch (e) {
        console.log(`[ExportDetect] Release check failed: ${e.message}`);
        sendResponse({ hasReleases: false, staleRevision: false, count: 0, error: e.message });
      }
    })();
    return true; // async sendResponse

  } else if (msg.type === "check-main-workspace") {
    // Returns { isMain: bool } — true if current wid is the main (non-deletable) workspace.
    // The main workspace is the only one with canDelete:false in the workspaces list.
    // NOTE: doc.defaultWorkspace is unreliable — it returns the current workspace, not main.
    (async () => {
      try {
        const ws = await onshapeFetch(`/api/v10/documents/${msg.docId}/workspaces`);
        const items = ws.items || ws || [];
        const mainWs = items.find(w => w.canDelete === false);
        const isMain = !!(mainWs && mainWs.id === msg.wid);
        console.log(`[ReleaseGuard] Doc ${msg.docId}: main=${mainWs?.name}(${mainWs?.id}), current=${msg.wid}, isMain=${isMain}`);
        sendResponse({ isMain, mainName: mainWs?.name });
      } catch (e) {
        console.log(`[ReleaseGuard] Workspace check failed: ${e.message}`);
        sendResponse({ isMain: true }); // fail open — don't block if check errors
      }
    })();
    return true;

  } else if (msg.type === "check-parts-materials") {
    // Returns { issues: string[] } — one entry per part that is missing a material
    // or still has a default "Part N" name. Empty array means all parts are OK.
    // Fails open (returns empty issues) if the fetch errors or eid is not a Part Studio.
    (async () => {
      const { docId, wid, eid } = msg;
      if (!docId || !wid || !eid) { sendResponse({ issues: [] }); return; }
      try {
        const parts = await onshapeFetch(`/api/v10/parts/d/${docId}/w/${wid}/e/${eid}`);
        if (!Array.isArray(parts) || parts.length === 0) { sendResponse({ issues: [] }); return; }
        const issues = [];
        for (const p of parts) {
          const noMaterial  = !p.material;
          const defaultName = /^Part \d+$/i.test(p.name);
          if (noMaterial || defaultName) {
            const reasons = [];
            if (defaultName) reasons.push("default name");
            if (noMaterial)  reasons.push("no material");
            issues.push(`${p.name} (${reasons.join(", ")})`);
          }
        }
        console.log(`[PartsGuard] ${issues.length} issue(s) in ${eid}`);
        sendResponse({ issues });
      } catch (e) {
        console.log(`[PartsGuard] Parts check failed: ${e.message}`);
        sendResponse({ issues: [] }); // fail open — don't block if check errors
      }
    })();
    return true;

  } else if (msg.type === "reset-partstudio-rollbacks") {
    // POST rollbackIndex:-1 to every Part Studio in the doc — fires when release dialog opens.
    (async () => {
      const { docId, wid } = msg;
      if (!docId || !wid) { sendResponse({ ok: false, error: "Missing docId or wid" }); return; }
      try {
        const elements = await onshapeFetch(`/api/v10/documents/d/${docId}/w/${wid}/elements`);
        const items = Array.isArray(elements) ? elements : (elements.items || []);
        const partStudios = items.filter(e => e.elementType === "PARTSTUDIO");
        for (const ps of partStudios) {
          await onshapePost(
            `/api/v10/partstudios/d/${docId}/w/${wid}/e/${ps.id}/features/rollback`,
            { rollbackIndex: -1 }
          );
        }
        console.log(`[RollbackReset] Reset rollback bar for ${partStudios.length} Part Studio(s) in doc ${docId}`);
        sendResponse({ ok: true, count: partStudios.length });
      } catch (e) {
        console.log(`[RollbackReset] Failed: ${e.message}`);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "test-add-sheet") {
    // Manual test: run on the active tab's drawing
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      const result = await addSheetViaIframe(tabs[0].id);
      sendResponse(result);
    });
    return true;

  } else if (msg.type === "create-folders") {
    // Folder creation via CDP — triggered from content.js overlay
    const folderNames = msg.folders || [];
    const tabId = sender.tab?.id;
    if (!tabId || folderNames.length === 0) {
      sendResponse({ error: "Missing tab or folders" });
      return;
    }
    createTabFolders(tabId, tabId, folderNames);
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "sort-tabs") {
    // Persistent tab sorter — moves stray root tabs into matching folders
    // Also unpacks illegal folders (names not in ALLOWED_FOLDERS) before sorting.
    // sender.tab exists when from content.js; from popup we need to find the active Onshape tab
    const fromTab = sender.tab?.id;
    const runSortWithUnpack = async (tabId) => {
      const preCheck = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const folders = [];
          for (const tab of document.querySelectorAll('.os-tab-bar-tab-group')) {
            const nameEl = tab.querySelector('.os-tab-name');
            if (nameEl) folders.push(nameEl.textContent.trim());
          }
          return folders;
        },
      });
      const allFolders = preCheck?.[0]?.result || [];
      const illegalFolders = allFolders.filter(f => !ALLOWED_FOLDERS.includes(f));
      if (illegalFolders.length > 0) {
        console.log("[TabSort] Illegal folders detected, running unpack first:", illegalFolders);
        unpackIllegalFolders(tabId, tabId, illegalFolders); // chains to sortStrayTabs internally
        return { ok: true };
      }
      return sortStrayTabs(tabId, tabId);
    };
    if (fromTab) {
      runSortWithUnpack(fromTab).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs.find(t => t.url && t.url.includes("cad.onshape.com"));
        if (!tab) { sendResponse({ error: "No Onshape tab active" }); return; }
        runSortWithUnpack(tab.id).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
      });
    }
    return true;

  } else if (msg.type === "unpack-illegal-folders") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: "No tab" }); return; }
    unpackIllegalFolders(tabId, tabId, msg.folders || []);
    sendResponse({ ok: true });
    return;

  } else if (msg.type === "check-interference") {
    // Interference detection via CDP — triggered from popup or content.js
    (async () => {
      const { docId, wid } = msg;
      if (await isDocDisabled(docId)) {
        sendResponse({ error: "Extension disabled for this document." });
        return;
      }
      // sender.tab exists when from content.js; from popup we need to find the Onshape tab
      const fromTab = sender.tab?.id;
      if (fromTab) {
        checkInterference(fromTab, fromTab, docId, wid);
        sendResponse({ ok: true });
      } else {
        chrome.tabs.query({ url: "https://cad.onshape.com/*" }, (tabs) => {
          const tab = tabs.find(t => t.url && t.url.includes(docId));
          if (tab) {
            checkInterference(tab.id, tab.id, docId, wid);
            sendResponse({ ok: true });
          } else {
            sendResponse({ error: "No matching Onshape tab" });
          }
        });
      }
    })();
    return true;

  } else if (msg.type === "discover-context-menu") {
    // Discovery helper — run once to find context menu selectors
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      const result = await discoverContextMenu(tabs[0].id);
      sendResponse(result);
    });
    return true;

  } else if (msg.type === "observe-dom-changes") {
    // DOM observer: start recording mutations. User manually right-clicks and
    // creates a folder, then sends "read-dom-changes" to dump what happened.
    // Run from console: chrome.runtime.sendMessage({type:"observe-dom-changes"})
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            window.__domChanges = [];
            window.__domObserver = new MutationObserver((mutations) => {
              for (const m of mutations) {
                for (const node of m.addedNodes) {
                  if (node.nodeType !== 1) continue;
                  const el = node;
                  const r = el.getBoundingClientRect();
                  window.__domChanges.push({
                    action: "added",
                    tag: el.tagName,
                    cls: (el.className || "").toString().slice(0, 150),
                    text: el.textContent.trim().slice(0, 120),
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height),
                    children: el.children.length,
                    html: el.outerHTML.slice(0, 300),
                  });
                }
              }
            });
            window.__domObserver.observe(document.body, { childList: true, subtree: true });
            console.log("[DOM Observer] Recording started. Right-click tab bar and create a folder, then run: chrome.runtime.sendMessage({type:'read-dom-changes'})");
          },
        });
        sendResponse({ ok: true, msg: "Recording. Do the manual action, then send 'read-dom-changes'" });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;

  } else if (msg.type === "read-dom-changes") {
    // Read back recorded DOM mutations
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => {
            if (window.__domObserver) {
              window.__domObserver.disconnect();
              window.__domObserver = null;
            }
            const changes = window.__domChanges || [];
            window.__domChanges = [];
            return changes;
          },
        });
        const changes = results?.[0]?.result || [];
        console.log(`[DOM Observer] ${changes.length} DOM mutations recorded:`);
        // Log the interesting ones (not our own toast, visible, menu-like)
        const interesting = changes.filter(c =>
          c.w > 20 && c.h > 10 && !c.cls.includes("oxt-") && c.text.length > 0
        );
        for (const c of interesting) {
          console.log(`  [${c.tag}] cls="${c.cls}" text="${c.text}" (${c.w}x${c.h} at ${c.x},${c.y})`);
        }
        console.log("[DOM Observer] Full dump:", JSON.stringify(interesting, null, 2));
        sendResponse({ count: changes.length, interesting });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    });
    return true;

  } else if (msg.type === "rescan-active-tab") {
    // Re-scan the current active tab. If content script isn't injected, inject it first.
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs.length === 0) return sendResponse({ error: "No active tab" });
      const tab = tabs[0];
      if (!tab.url || !tab.url.includes("cad.onshape.com/documents/")) {
        return sendResponse({ error: "Active tab is not an Onshape document" });
      }

      // Try messaging content script; if missing, inject and retry
      let result = await trySendScan(tab.id);
      if (result.__noConnection) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"],
          });
          // Wait for tab bar to be ready
          await new Promise(r => setTimeout(r, 2000));
          result = await trySendScan(tab.id);
        } catch (injectErr) {
          return sendResponse({ error: "Failed to inject scanner: " + injectErr.message });
        }
      }

      if (result.error) return sendResponse(result);

      // Store result per doc
      await storeDocScanResult(result);
      sendResponse(result);
    });
    return true;

  } else if (msg.type === "get-session-user") {
    (async () => {
      const user = await getSessionUser();
      sendResponse(user || { error: "Could not get session user" });
    })();
    return true;

  } else if (msg.type === "check-doc-disabled") {
    (async () => {
      const disabled = await isDocDisabled(msg.docId);
      sendResponse({ disabled });
    })();
    return true;

  } else if (msg.type === "set-doc-disabled") {
    // Admin-only: only kevin@origin.tech may modify the whitelist
    (async () => {
      const user = await getSessionUser();
      if (!user || user.email !== "kevin@10xconstruction.ai") {
        sendResponse({ error: "Unauthorized" });
        return;
      }
      const method = msg.disabled ? "PUT" : "DELETE";
      const result = await syncFetch(`/api/disabled-docs/${msg.docId}`, { method });
      if (!result || result.error) {
        sendResponse({ error: result?.error || "Server error" });
        return;
      }
      // Bust local cache so next check-doc-disabled reflects the change immediately
      await chrome.storage.local.set({
        disabledDocsCache: result.disabledDocs,
        disabledDocsFetchedAt: Date.now(),
      });
      // Reload any open tab showing this doc so content.js re-runs the early-exit check
      chrome.tabs.query({ url: "https://cad.onshape.com/*" }, (tabs) => {
        for (const tab of tabs) {
          if (tab.url && tab.url.includes(msg.docId)) {
            chrome.tabs.reload(tab.id);
          }
        }
      });
      sendResponse({ ok: true, disabled: msg.disabled });
    })();
    return true;

  } else if (msg.type === "get-doc-creator") {
    (async () => {
      try {
        const doc = await onshapeFetch(`/api/v10/documents/${msg.docId}`);
        sendResponse({ creator: doc.createdBy });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "get-top-folder") {
    (async () => {
      try {
        const result = await getTopLevelFolder(msg.docId);
        sendResponse(result);
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "get-assembly-count") {
    (async () => {
      try {
        const elements = await onshapeFetch(`/api/v10/documents/d/${msg.docId}/w/${msg.wid}/elements`);
        const items = elements.items || elements || [];
        const count = items.filter(e => e.elementType === "ASSEMBLY").length;
        sendResponse({ count });
      } catch (e) {
        sendResponse({ error: e.message, count: 0 });
      }
    })();
    return true;

  } else if (msg.type === "get-tab-count") {
    (async () => {
      try {
        const elements = await onshapeFetch(`/api/v10/documents/d/${msg.docId}/w/${msg.wid}/elements`);
        const items = Array.isArray(elements) ? elements : (elements.items || elements.elements || []);
        const count = items.filter(
          e => e.elementType !== "BILLOFMATERIALS" && !(e.name || "").startsWith("BOM :")
        ).length;
        sendResponse({ count });
      } catch (e) {
        sendResponse({ error: e.message, count: 0 });
      }
    })();
    return true;

  } else if (msg.type === "get-team-members") {
    (async () => {
      const members = await getTeamMembers();
      sendResponse({ members });
    })();
    return true;

  } else if (msg.type === "check-merge-allowed") {
    // Check if current session user is an allowed merge owner for this doc
    // Try backend first, fall back to local storage
    (async () => {
      const user = await getSessionUser();
      if (!user) return sendResponse({ allowed: false, error: "No session user" });

      // Try backend
      let docPerms = null;
      const remote = await syncFetch(`/api/merge-permissions/${msg.docId}`);
      if (remote && remote.owners) {
        docPerms = remote;
        // Cache locally
        const stored = await chrome.storage.local.get("mergePermissions");
        const perms = stored.mergePermissions || {};
        perms[msg.docId] = remote;
        await chrome.storage.local.set({ mergePermissions: perms });
      } else {
        // Fall back to local
        const stored = await chrome.storage.local.get("mergePermissions");
        const perms = stored.mergePermissions || {};
        docPerms = perms[msg.docId];
      }

      if (!docPerms) {
        console.log(`[MergeBlock] No permissions for ${msg.docId}, allowing`);
        return sendResponse({ allowed: true, email: user.email });
      }
      const owners = docPerms.owners || [];
      const allowed = owners.some(o => o.email === user.email);
      console.log(`[MergeBlock] User ${user.email} ${allowed ? "ALLOWED" : "BLOCKED"} for ${msg.docId}`);
      sendResponse({ allowed, email: user.email, owners });
    })();
    return true;

  } else if (msg.type === "save-merge-owners") {
    // Save merge owners for a doc: { docId, docName, owners: [{email, name, id}] }
    (async () => {
      const stored = await chrome.storage.local.get("mergePermissions");
      const perms = stored.mergePermissions || {};
      // Safety: never persist the company account as a merge owner
      const filteredOwners = (msg.owners || []).filter(o => o.id !== COMPANY_ID);
      const entry = {
        docName: msg.docName,
        owners: filteredOwners,
        updatedAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
      };
      perms[msg.docId] = entry;
      await chrome.storage.local.set({ mergePermissions: perms });
      console.log(`[MergePerms] Saved ${filteredOwners.length} owner(s) for ${msg.docName}`);
      sendResponse({ ok: true });
      // Fire-and-forget sync to backend
      syncFetch(`/api/merge-permissions/${msg.docId}`, {
        method: "PUT",
        body: JSON.stringify(entry),
      });
    })();
    return true;

  } else if (msg.type === "get-merge-perms") {
    // Centralized merge-perms reader: try backend first, fall back to local
    (async () => {
      const remote = await syncFetch(`/api/merge-permissions/${msg.docId}`);
      if (remote && Array.isArray(remote.owners) && remote.owners.length > 0) {
        // Cache locally
        const stored = await chrome.storage.local.get("mergePermissions");
        const perms = stored.mergePermissions || {};
        perms[msg.docId] = remote;
        await chrome.storage.local.set({ mergePermissions: perms });
        sendResponse({ exists: true, data: remote });
        return;
      }
      // Fall back to local
      const stored = await chrome.storage.local.get("mergePermissions");
      const perms = stored.mergePermissions || {};
      const local = perms[msg.docId];
      const hasOwners = local && Array.isArray(local.owners) && local.owners.length > 0;
      sendResponse(hasOwners ? { exists: true, data: local } : { exists: false });
    })();
    return true;

  } else if (msg.type === "list-company-folders") {
    // Fetch top-level company folders from global tree nodes
    (async () => {
      try {
        const folders = [];
        let offset = 0;
        const limit = 50;
        while (true) {
          const data = await onshapeFetch(`/api/globaltreenodes/magic/1?offset=${offset}&limit=${limit}`);
          const items = data.items || [];
          for (const item of items) {
            if (item.resourceType === "folder") {
              folders.push({ name: item.name, id: item.id });
            }
          }
          if (items.length < limit || (data.next === undefined && items.length === 0)) break;
          offset += limit;
        }
        sendResponse({ folders });
      } catch (e) {
        console.error("[ListFolders] Top-level error:", e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "list-subfolders") {
    // Fetch subfolders inside a given folder
    (async () => {
      try {
        const folderId = msg.folderId;
        if (!folderId) { sendResponse({ error: "Missing folderId" }); return; }
        const folders = [];
        let offset = 0;
        const limit = 50;
        while (true) {
          const data = await onshapeFetch(`/api/globaltreenodes/folder/${folderId}?offset=${offset}&limit=${limit}`);
          const items = data.items || [];
          for (const item of items) {
            if (item.resourceType === "folder") {
              folders.push({ name: item.name, id: item.id });
            }
          }
          if (items.length < limit || (data.next === undefined && items.length === 0)) break;
          offset += limit;
        }
        sendResponse({ folders });
      } catch (e) {
        console.error("[ListFolders] Subfolder error:", e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "create-doc-in-folder") {
    // Create a new document in a specific folder
    (async () => {
      try {
        const name = msg.name || "Untitled";
        const folderId = msg.folderId;
        if (!folderId) { sendResponse({ error: "Missing folderId" }); return; }
        const body = {
          name: name,
          parentId: folderId,
          ownerType: 1,
          ownerId: COMPANY_ID,
        };
        const doc = await onshapePost("/api/v10/documents", body);
        const docId = doc.id;
        const defaultWid = doc.defaultWorkspace?.id || "";
        const url = `${ONSHAPE_BASE}/documents/${docId}/w/${defaultWid}`;
        console.log(`[CreateDoc] Created "${name}" in folder ${folderId} -> ${docId}`);
        sendResponse({ docId, url });
      } catch (e) {
        console.error("[CreateDoc] Failed:", e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true;

  } else if (msg.type === "fetch-export-elements") {
    const { did, wid } = msg;
    if (!did || !wid) { sendResponse({ error: "Missing did or wid" }); return; }
    sendResponse({ ok: true });
    (async () => {
      try {
        const elResp = await onshapeFetch(`/api/documents/d/${did}/w/${wid}/elements`);
        const allEls = Array.isArray(elResp) ? elResp : (elResp.items || []);
        const partStudioEls = allEls.filter(e => e.elementType === "PARTSTUDIO");
        const drawings = allEls.filter(e => e.elementType === "APPLICATION").map(e => ({ id: e.id, name: e.name }));

        const partStudios = await Promise.all(partStudioEls.map(async ps => {
          try {
            const params = new URLSearchParams({ includeFlattenedBodies: "true", includeParts: "false", elementId: ps.id });
            const ins = await onshapeFetch(`/api/documents/d/${did}/w/${wid}/insertables?${params}`);
            const flatParts = (ins.items || [])
              .filter(i => i.isFlattenedBody)
              .map(i => ({ partName: i.partName || i.name || "FlatPattern", deterministicId: i.deterministicId }));
            return { id: ps.id, name: ps.name, flatParts };
          } catch (e) {
            return { id: ps.id, name: ps.name, flatParts: [] };
          }
        }));

        chrome.runtime.sendMessage({ type: "export-elements-loaded", partStudios, drawings }).catch(() => {});
      } catch (e) {
        chrome.runtime.sendMessage({ type: "export-elements-error", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "bulk-export") {
    const { did, wid, selectedPartStudios, selectedDrawings } = msg;
    if (!did || !wid) { sendResponse({ error: "Missing did or wid" }); return; }
    sendResponse({ ok: true });
    (async () => {
      try {
        chrome.runtime.sendMessage({ type: "bulk-export-progress", message: "Starting bulk export..." }).catch(() => {});
        const [dxfFiles, pdfFiles] = await Promise.all([
          selectedPartStudios?.length ? bulkExportFlatPatterns(did, wid, selectedPartStudios) : Promise.resolve([]),
          selectedDrawings?.length ? bulkExportDrawingPdfs(did, wid, selectedDrawings) : Promise.resolve([]),
        ]);
        const allFiles = [...dxfFiles, ...pdfFiles];
        chrome.runtime.sendMessage({ type: "bulk-export-progress", message: `Building ZIP: ${allFiles.length} file(s)...` }).catch(() => {});
        const zip = makeZip(allFiles);
        const zipBase64 = toBase64(zip);
        const filename = `export_${did}.zip`;
        chrome.runtime.sendMessage({ type: "bulk-export-done", zipBase64, filename }).catch(() => {});
        console.log("[BulkExport] Done:", allFiles.length, "files,", zip.length, "bytes");
      } catch (e) {
        console.error("[BulkExport] Fatal:", e.message);
        chrome.runtime.sendMessage({ type: "bulk-export-done", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "export-3d-parts") {
    const { url, format, selectedParts, configuration } = msg;
    if (!url || !format || !selectedParts?.length) { sendResponse({ ok: true }); return; }
    sendResponse({ ok: true });
    (async () => {
      try {
        const parsed = parsePartStudioUrl(url);
        if (!parsed) throw new Error("Invalid Part Studio URL");
        const { docId: did, wid, eid } = parsed;
        const ext = format === "STEP" ? "step" : "stl";
        const files = [];
        const docInfo = await onshapeFetch(`/api/v10/documents/${did}`);
        const safeDocName = (docInfo?.name || "Document").replace(/[\\/:*?"<>|]/g, "_").trim();
        chrome.runtime.sendMessage({ type: "export-3d-progress", message: `Starting ${format} export for ${selectedParts.length} part(s)...` }).catch(() => {});

        for (const part of selectedParts) {
          const safePartName = (part.name || part.partId).replace(/[\\/:*?"<>|]/g, "_").trim();
          const safeName = `${safeDocName} - ${safePartName}`;
          chrome.runtime.sendMessage({ type: "export-3d-progress", message: `  ${part.name}...` }).catch(() => {});
          try {
            const jobBody = { formatName: format, storeInDocument: false, partIds: part.partId };
            if (format === "STL") jobBody.units = "millimeter";
            const cfgQ = configuration ? `?configuration=${encodeURIComponent(configuration)}` : "";
            const job = await onshapePost(`/api/v6/partstudios/d/${did}/w/${wid}/e/${eid}/translations${cfgQ}`, jobBody);
            let t;
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 2000));
              t = await onshapeFetch(`/api/v6/translations/${job.id}`);
              if (t.requestState !== "ACTIVE") break;
            }
            if (!t || t.requestState !== "DONE" || !t.resultExternalDataIds?.length) {
              chrome.runtime.sendMessage({ type: "export-3d-progress", message: `  FAILED: ${part.name} (${t?.requestState || "no result"})`, cls: "log-err" }).catch(() => {});
              continue;
            }
            const resp = await fetch(
              `${ONSHAPE_BASE}/api/v6/documents/d/${t.documentId || did}/externaldata/${t.resultExternalDataIds[0]}`,
              { credentials: "include" }
            );
            if (!resp.ok) throw new Error(`blob fetch ${resp.status}`);
            const data = new Uint8Array(await resp.arrayBuffer());
            files.push({ name: `${safeName}.${ext}`, data });
            chrome.runtime.sendMessage({ type: "export-3d-progress", message: `  OK: ${safeName}.${ext}` }).catch(() => {});
          } catch (e) {
            chrome.runtime.sendMessage({ type: "export-3d-progress", message: `  ERROR: ${part.name}: ${e.message}`, cls: "log-err" }).catch(() => {});
          }
        }

        if (!files.length) throw new Error("No files exported");
        for (const file of files) {
          chrome.downloads.download({ url: "data:application/octet-stream;base64," + toBase64(file.data), filename: file.name, saveAs: false });
        }
        chrome.runtime.sendMessage({ type: "export-3d-done", count: files.length }).catch(() => {});
      } catch (e) {
        chrome.runtime.sendMessage({ type: "export-3d-done", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "export-urdf") {
    const { url, configuration } = msg;
    if (!url) { sendResponse({ ok: true }); return; }
    sendResponse({ ok: true });
    (async () => {
      try {
        const parsed = parsePartStudioUrl(url);
        if (!parsed) throw new Error("Invalid assembly URL — must contain /documents/{did}/w/{wid}/e/{eid}");
        await generateUrdf(parsed.docId, parsed.wid, parsed.eid, configuration);
      } catch (e) {
        chrome.runtime.sendMessage({ type: "urdf-done", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "fetch-bom-configs") {
    const { url } = msg;
    if (!url) { sendResponse({ ok: true }); return; }
    sendResponse({ ok: true });
    (async () => {
      try {
        const parsed = parsePartStudioUrl(url);
        if (!parsed) { chrome.runtime.sendMessage({ type: "bom-configs-error", error: "Invalid assembly URL" }).catch(() => {}); return; }
        const { docId: did, wid, eid } = parsed;
        // Only assemble BOM for Assembly elements — check type first
        const elList = await onshapeFetch(`/api/v10/documents/d/${did}/w/${wid}/elements?elementId=${eid}`);
        const el = Array.isArray(elList) ? elList[0] : (elList?.items?.[0]);
        if (!el || el.elementType !== "ASSEMBLY") {
          chrome.runtime.sendMessage({ type: "bom-configs-loaded", params: [], notAssembly: true }).catch(() => {});
          return;
        }
        const cfg = await onshapeFetch(`/api/v10/elements/d/${did}/w/${wid}/e/${eid}/configuration`);
        const rawParams = cfg?.configurationParameters || [];
        // Build current-config map so we can use live defaults
        const currentCfg = {};
        (cfg?.currentConfiguration || []).forEach(p => {
          const pm = p.message || p;
          currentCfg[pm.parameterId] = pm.value;
        });
        const params = rawParams.map(p => {
          const m = p.message || p;
          const typeStr = (p.btType || p.type || "").toLowerCase();
          const id = m.parameterId;
          const name = m.parameterName || id;
          const defaultVal = String(currentCfg[id] ?? m.defaultValue ?? "");
          if (typeStr.includes("enum")) {
            return {
              type: "enum", id, name, defaultValue: defaultVal,
              values: (m.options || []).map(opt => ({ value: opt.option, label: opt.optionName || opt.option }))
            };
          } else if (typeStr.includes("boolean")) {
            return { type: "boolean", id, name, defaultValue: defaultVal };
          } else {
            return { type: "quantity", id, name, defaultValue: defaultVal, unitSpec: m.units || "" };
          }
        });
        chrome.runtime.sendMessage({ type: "bom-configs-loaded", params }).catch(() => {});
      } catch (e) {
        chrome.runtime.sendMessage({ type: "bom-configs-error", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "fetch-urdf-configs") {
    const { url } = msg;
    if (!url) { sendResponse({ ok: true }); return; }
    sendResponse({ ok: true });
    (async () => {
      try {
        const parsed = parsePartStudioUrl(url);
        if (!parsed) { chrome.runtime.sendMessage({ type: "urdf-configs-error", error: "Invalid assembly URL" }).catch(() => {}); return; }
        const { docId: did, wid, eid } = parsed;
        const elList = await onshapeFetch(`/api/v10/documents/d/${did}/w/${wid}/elements?elementId=${eid}`);
        const el = Array.isArray(elList) ? elList[0] : (elList?.items?.[0]);
        if (!el || el.elementType !== "ASSEMBLY") {
          chrome.runtime.sendMessage({ type: "urdf-configs-loaded", params: [], notAssembly: true }).catch(() => {});
          return;
        }
        const cfg = await onshapeFetch(`/api/v10/elements/d/${did}/w/${wid}/e/${eid}/configuration`);
        const rawParams = cfg?.configurationParameters || [];
        const currentCfg = {};
        (cfg?.currentConfiguration || []).forEach(p => {
          const pm = p.message || p;
          currentCfg[pm.parameterId] = pm.value;
        });
        const params = rawParams.map(p => {
          const m = p.message || p;
          const typeStr = (p.btType || p.type || "").toLowerCase();
          const id = m.parameterId;
          const name = m.parameterName || id;
          const defaultVal = String(currentCfg[id] ?? m.defaultValue ?? "");
          if (typeStr.includes("enum")) {
            return {
              type: "enum", id, name, defaultValue: defaultVal,
              values: (m.options || []).map(opt => ({ value: opt.option, label: opt.optionName || opt.option }))
            };
          } else if (typeStr.includes("boolean")) {
            return { type: "boolean", id, name, defaultValue: defaultVal };
          } else {
            return { type: "quantity", id, name, defaultValue: defaultVal, unitSpec: m.units || "" };
          }
        });
        chrome.runtime.sendMessage({ type: "urdf-configs-loaded", params }).catch(() => {});
      } catch (e) {
        chrome.runtime.sendMessage({ type: "urdf-configs-error", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "export-bom-csv") {
    const { url, configuration } = msg;
    if (!url) { sendResponse({ ok: true }); return; }
    sendResponse({ ok: true });
    (async () => {
      function csvEsc(v) {
        const s = v == null ? "" : String(v);
        return (s.includes('"') || s.includes(',') || s.includes('\n'))
          ? '"' + s.replace(/"/g, '""') + '"'
          : s;
      }
      try {
        const parsed = parsePartStudioUrl(url);
        if (!parsed) throw new Error("Invalid assembly URL");
        const { docId: did, wid, eid } = parsed;
        const docInfo = await onshapeFetch(`/api/v10/documents/d/${did}`).catch(() => ({}));
        const safeDocName = (docInfo?.name || did).replace(/[\\/:*?"<>|]/g, "_").trim();
        const configParam = configuration ? `&configuration=${encodeURIComponent(configuration)}` : "";
        chrome.runtime.sendMessage({ type: "bom-export-progress", message: "Fetching BOM data..." }).catch(() => {});
        const bom = await onshapeFetch(
          `/api/v10/assemblies/d/${did}/w/${wid}/e/${eid}/bom?generateIfAbsent=true&indented=false${configParam}`
        );
        if (!bom || bom.error) throw new Error(bom?.error?.message || bom?.message || "BOM fetch failed");
        const cols = (bom.headers || []).filter(h => h.visible);
        const csvLines = [cols.map(h => csvEsc(h.name)).join(",")];
        for (const row of (bom.rows || [])) {
          const cells = cols.map(col => {
            const val = row.headerIdToValue?.[col.id];
            if (val == null) return "";
            if (col.valueType === "OBJECT" || (val !== null && typeof val === "object")) {
              return csvEsc(val.displayName || val.value || "");
            }
            return csvEsc(String(val));
          });
          csvLines.push(cells.join(","));
        }
        const csvStr = csvLines.join("\r\n");
        const csvBytes = new TextEncoder().encode(csvStr);
        const filename = `bom_${safeDocName}.csv`;
        chrome.downloads.download({ url: `data:text/csv;base64,${toBase64(csvBytes)}`, filename, saveAs: false });
        chrome.runtime.sendMessage({ type: "bom-export-done", filename, rows: bom.rows?.length ?? 0 }).catch(() => {});
      } catch (e) {
        chrome.runtime.sendMessage({ type: "bom-export-done", error: e.message }).catch(() => {});
      }
    })();
    return;

  } else if (msg.type === "get-feature-count") {
    const { docId, wid, eid } = msg;
    if (!docId || !wid || !eid) { sendResponse({ count: 0 }); return; }
    (async () => {
      const resp = await onshapeFetch(`/api/v10/partstudios/d/${docId}/w/${wid}/e/${eid}/features`).catch(() => null);
      const count = Array.isArray(resp?.features) ? resp.features.length : 0;
      sendResponse({ count });
    })();
    return true;

  } else if (msg.type === "check-and-setup-doc") {
    const { docId, wid } = msg;
    const tabId = sender.tab?.id;
    if (!docId || !wid || !tabId) { sendResponse({ skipped: true }); return; }
    (async () => {
      try {
        // Already done for this doc?
        const stored = await new Promise(r => chrome.storage.local.get(`docSetupDone_${docId}`, r));
        if (stored[`docSetupDone_${docId}`]) { sendResponse({ skipped: true }); return; }

        // Doc already set up if it has more than 1 version ("Start" is the default)
        const versions = await onshapeFetch(`/api/v10/documents/d/${docId}/versions`).catch(() => []);
        const versionList = Array.isArray(versions) ? versions : (versions.items || []);
        if (versionList.length > 1) {
          chrome.storage.local.set({ [`docSetupDone_${docId}`]: true });
          sendResponse({ skipped: true });
          return;
        }

        // Fetch all elements once
        const elements = await onshapeFetch(`/api/v10/documents/d/${docId}/w/${wid}/elements`).catch(() => []);
        const items = Array.isArray(elements) ? elements : (elements.items || []);
        const partStudios = items.filter(e => e.elementType === "PARTSTUDIO");
        const assemblies  = items.filter(e => e.elementType === "ASSEMBLY");

        // Check PS feature counts (stop at first hit)
        let shouldTrigger = false;
        for (const ps of partStudios) {
          const resp = await onshapeFetch(`/api/v10/partstudios/d/${docId}/w/${wid}/e/${ps.id}/features`).catch(() => null);
          const count = Array.isArray(resp?.features) ? resp.features.length : 0;
          if (count >= 25) { shouldTrigger = true; break; }
        }

        // Check assembly instance counts (stop at first hit)
        if (!shouldTrigger) {
          for (const asm of assemblies) {
            const resp = await onshapeFetch(`/api/v10/assemblies/d/${docId}/w/${wid}/e/${asm.id}`).catch(() => null);
            const count = resp?.rootAssembly?.instances?.length ?? 0;
            if (count >= 5) { shouldTrigger = true; break; }
          }
        }

        if (!shouldTrigger) { sendResponse({ triggered: false }); return; }

        // Mark done before running setup (prevent double-trigger on concurrent calls)
        chrome.storage.local.set({ [`docSetupDone_${docId}`]: true });
        sendResponse({ triggered: true });

        // Run setup sequence
        const vResult = await createInitialVersion(docId, wid);
        if (!vResult.ok) {
          chrome.tabs.sendMessage(tabId, { type: "setup-new-doc-done", success: false, error: "Version creation failed" }).catch(() => {});
          return;
        }

        const bResult = await createDevelopmentBranch(docId, vResult.versionId);
        if (!bResult.ok) {
          chrome.tabs.sendMessage(tabId, { type: "setup-new-doc-done", success: false, error: "Branch creation failed" }).catch(() => {});
          return;
        }

        const pResult = await enableWorkspaceProtection(tabId, tabId);
        chrome.tabs.sendMessage(tabId, {
          type: "setup-new-doc-done",
          success: !!pResult?.ok,
          protectionSkipped: pResult?.skipped,
          error: pResult?.error,
        }).catch(() => {});

      } catch (e) {
        console.error("[NewDocSetup] check-and-setup-doc error:", e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});

// ---------------------------------------------------------------------------
// SPA navigation detection — notify content script when Onshape URL changes
// ---------------------------------------------------------------------------

// Track last known URL per tab to detect doc switches
const _tabUrls = {};

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!changeInfo.url.includes("cad.onshape.com/documents/")) return;
  const prev = _tabUrls[tabId] || "";
  _tabUrls[tabId] = changeInfo.url;
  const prevDocId = prev.match(/\/documents\/([a-f0-9]+)/)?.[1];
  const newDocId = changeInfo.url.match(/\/documents\/([a-f0-9]+)/)?.[1];
  const prevEid = prev.match(/\/e\/([a-f0-9]+)/)?.[1];
  const newEid = changeInfo.url.match(/\/e\/([a-f0-9]+)/)?.[1];
  if (newDocId && (newDocId !== prevDocId || (newEid && newEid !== prevEid))) {
    console.log("[SPA] Navigation detected:", prevDocId, "->", newDocId, "eid:", prevEid, "->", newEid);
    chrome.tabs.sendMessage(tabId, {
      type: "spa-navigated",
      url: changeInfo.url,
    }).catch(() => {
      // Content script not injected — reload tab as backup (approach C)
      console.log("[SPA] Content script not reachable, reloading tab");
      chrome.tabs.reload(tabId);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { delete _tabUrls[tabId]; });

// ---------------------------------------------------------------------------
// Notification click — open popup to the relevant section
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener((notificationId) => {
  let section = "";
  if (notificationId.startsWith("folder-scan-")) {
    section = "scanner";
  } else if (notificationId.startsWith("interference-")) {
    section = "violations";
  } else if (notificationId.startsWith("tab-count-")) {
    section = "scanner";
  } else if (notificationId.startsWith("feature-count-")) {
    section = "violations";
  }
  if (section) {
    // Store target section so popup.js can navigate to it on open
    chrome.storage.local.set({ popupTargetSection: section });
    // Open the popup (Chrome 99+ Manifest V3)
    chrome.action.openPopup().catch(() => {
      // Fallback: open popup.html as a tab if openPopup() unavailable
      chrome.tabs.create({ url: `popup.html?section=${section}` });
    });
  }
  chrome.notifications.clear(notificationId);
});

// ---------------------------------------------------------------------------
// Storage cleanup — remove entries for deleted/inaccessible documents
// ---------------------------------------------------------------------------

async function cleanupDeletedDocs() {
  const keys = ["docScanResults", "mergePermissions", "interferenceResults", "tabCounts"];
  const data = await chrome.storage.local.get(keys);
  let changed = false;

  for (const key of keys) {
    const obj = data[key];
    if (!obj || typeof obj !== "object") continue;
    const docIds = Object.keys(obj);
    for (const docId of docIds) {
      try {
        const resp = await fetch(`${ONSHAPE_BASE}/api/v10/documents/${docId}`, {
          credentials: "include",
          headers: { "Accept": "application/json" },
        });
        // Only remove on explicit 404 — network errors, 403, 429, etc. must NOT delete data
        if (resp.status !== 404) continue;
        console.log(`[Cleanup] Removing ${key} entry for deleted doc ${docId}`);
        delete obj[docId];
        changed = true;
        if (key === "mergePermissions") {
          syncFetch(`/api/merge-permissions/${docId}`, { method: "DELETE" });
        }
      } catch (e) {
        // Network error — skip, never delete on transient failures
      }
    }
  }

  if (changed) {
    const updates = {};
    for (const key of keys) { if (data[key]) updates[key] = data[key]; }
    await chrome.storage.local.set(updates);
    console.log("[Cleanup] Storage cleaned up");
  }
}

// Prune chrome.storage.local entries for docs that were deleted or lost access.
// Uses one GET /documents/{id} per cached doc — runs at startup then every 6h.
cleanupDeletedDocs();
setInterval(cleanupDeletedDocs, 6 * 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Auto-reload: detect when git pull has updated the local extension files
// ---------------------------------------------------------------------------
// For unpacked (developer-mode) extensions, chrome.runtime.getURL reads files
// from disk. We fetch manifest.json with cache:no-store every 5 min and compare
// the on-disk version to the in-memory version. If they differ, git-pull landed
// new code and we chrome.runtime.reload(). Deferred while CDP/drawing ops run.

const _loadedVersion = chrome.runtime.getManifest().version;
console.log(`[AutoUpdate] Extension loaded, version: ${_loadedVersion}`);

function isExtensionBusy() {
  return _drawingInProgress || _sortingInProgress || _interferenceInProgress || _unpackInProgress;
}

let _updatePending = false; // true when update detected but waiting for busy ops to finish

async function checkForLocalUpdate() {
  try {
    const resp = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    if (!resp.ok) return;
    const manifest = await resp.json();
    if (manifest.version === _loadedVersion) {
      _updatePending = false;
      return;
    }

    // Update available — check if busy
    if (isExtensionBusy()) {
      if (!_updatePending) {
        console.log(`[AutoUpdate] Update ${_loadedVersion} -> ${manifest.version} waiting for operations to finish`);
      }
      _updatePending = true;
      return; // will retry on next interval tick
    }

    console.log(`[AutoUpdate] Version changed: ${_loadedVersion} -> ${manifest.version}, reloading...`);
    chrome.runtime.reload();
  } catch (e) {
    console.log("[AutoUpdate] Check failed:", e.message);
  }
}

// Check every 5 minutes (also retries pending updates)
setInterval(checkForLocalUpdate, 5 * 60 * 1000);
// When an update is pending, also check every 30s so we reload soon after ops finish
setInterval(() => { if (_updatePending) checkForLocalUpdate(); }, 30000);
// Check shortly after startup (in case git pull ran while Chrome was open)
setTimeout(checkForLocalUpdate, 30000);

// ---------------------------------------------------------------------------
// Dev relay — CDP mode
// ---------------------------------------------------------------------------
// sw-relay.py connects to Chrome --remote-debugging-port=9222 and evals
// expressions directly in this SW via CDP Runtime.evaluate (bypasses CSP).
// No code needed here — the relay talks to the SW target over CDP.
// sw-exec.py  →  ws://localhost:9300/cmd  →  relay  →  CDP  →  SW
// ---------------------------------------------------------------------------
