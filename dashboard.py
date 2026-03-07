#!/usr/bin/env python3
"""
Onshape Dashboard
=================
Document-based dashboard for Artila Robotics.
Server-side rendered — no client-side API calls.

Local:   python dashboard.py  ->  http://localhost:5001
"""

import io
import os
import json
import time
import zipfile
import itertools
import threading
import requests
from datetime import datetime
from urllib.parse import quote_plus
from flask import Flask, jsonify, render_template_string, request, redirect, send_file

# ============================================================
# CREDENTIALS & CONFIG
# ============================================================
ACCESS_KEY         = os.environ.get("ONSHAPE_ACCESS_KEY",    "on_sRiFqD1gRGXiwVGXyzANH")
SECRET_KEY         = os.environ.get("ONSHAPE_SECRET_KEY",    "9wc3KzifxPAcIkapb7tVqFjGio98kIcIHxcpMJQ7tYBoa5oz")
BASE_URL           = "https://cad.onshape.com"
COMPANY_ID         = os.environ.get("ONSHAPE_COMPANY_ID",    "6810c247e7c40668c32816a6")
REGISTRY_FILE      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "folders.json")
METRICS_FILE       = os.path.join(os.path.dirname(os.path.abspath(__file__)), "metrics.json")
DEFAULT_SUBFOLDERS = ["Parts", "Assemblies", "Drawings"]
ASSEMBLY_NAMES     = ["Master Assembly", "Placement Assembly", "Routing Assembly", "Manufacturing Assembly"]
CACHE_TTL          = 300  # seconds (5 minutes)
AUTO_BRANCH_NAME          = "Development"
VERSION_RELEASE_THRESHOLD = 5   # Slack alert when a doc has this many versions with no release

# Watcher
SLACK_WEBHOOK_URL        = os.environ.get("SLACK_WEBHOOK_URL",     "https://hooks.slack.com/services/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")
WEBHOOK_SECRET           = os.environ.get("ONSHAPE_WEBHOOK_SECRET", "artila-webhook-secret")
DASHBOARD_URL            = os.environ.get("DASHBOARD_URL",          "http://localhost:5001")
# ============================================================

HEADERS = {
    "Accept": "application/json;charset=UTF-8;qs=0.09",
    "Content-Type": "application/json",
}
# Key pool — all pairs must be from the same Onshape account (same COMPANY_ID).
# Weight 1 = 1 slot per round-robin cycle; weight 3 = 3 slots.
_REGULAR_KEYS = [
    (ACCESS_KEY, SECRET_KEY),
    ("on_z1UhhHZH6oalYiXInyEYi", "bYSpbfhM6KJQbzBVDGLCCFwaQFQHStnuYwObGamtxHhPVYs5"),
    ("on_OEu3wzjc3lrvyh1wZl0V9", "R1AlU0ZraRWOOZoiJP41eYS6zlxlL6AwTrxvbaiB9gDcHIWR"),
    ("on_0iSvyZlEfnmBTMagWG1MT", "Yt5li8BzbUPNUaV3uLJbNA5tuBvlxQDcJsRxGYVHI3cIfxay"),
    ("on_AwY0N0aTHRZ3lH1BvIXq0",  "10eAjkwdf83tSgoRgbTkvrXyESTmcQi2K4TTJtqUcN3BuM3C"),
    ("on_SGYDfnKOfECj80oPyTIpf",  "jNPlQ4eUoS7WBkrrmY6EXf72oyoHXW79ns8gGbJDlpLDANU3"),
    ("on_LeDYm2hVFdCuc15ghJdbs",  "jkEU9iGpz8v7vdd0GnyyAoTHwBU9HFT0K0m3JpgEHKDCFCbV"),
]
_SPECIAL_KEY = ("on_FDJfzRLfVfE2rx9XwLjcS", "5BpXsu5Ct1JFreMdzQmLXEgskuLmPFrkfYJ8KB6gR60VTTKV")
# Cycle: 1 slot per regular key, 3 slots for the special key
_rr_sequence = [_SPECIAL_KEY] * 3 + _REGULAR_KEYS
_rr_iter = itertools.cycle(_rr_sequence)
_rr_lock = threading.Lock()

_metrics_lock = threading.Lock()

def _load_metrics():
    try:
        with open(METRICS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"total_api_calls": 0, "api_enabled": True}

_metrics = _load_metrics()

def _inc_api_calls():
    with _metrics_lock:
        _metrics["total_api_calls"] += 1
        try:
            with open(METRICS_FILE, "w") as f:
                json.dump(_metrics, f)
        except Exception:
            pass

def next_auth():
    _inc_api_calls()
    with _rr_lock:
        return next(_rr_iter)

app = Flask(__name__)

# 5-minute server-side data cache
_cache = {"data": None, "ts": 0}

# Watcher state (webhook-driven — no polling)
_watcher = {
    "rel_wh_id":     None,   # Onshape webhook ID for release events
    "ver_wh_id":     None,   # Onshape webhook ID for version-creation events
    "last_event_ts": 0,
    "error":         None,
}
watcher_lock        = threading.Lock()
_recent_releases    = []   # webhook-received releases (main page, filtered to 5 min)
_previous_releases  = []   # all releases: seeded + webhook (for /previous-releases)
_releases_lock      = threading.Lock()
_doc_version_counts = {}   # doc_id -> version count since last release
_dvc_lock           = threading.Lock()


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"   [{ts}] {msg}")


# ============================================================
# API HELPERS
# ============================================================

def onshape_get(path, params=None):
    if not _metrics.get("api_enabled", True):
        raise RuntimeError("API calls are disabled")
    r = requests.get(
        f"{BASE_URL}{path}",
        headers=HEADERS,
        auth=next_auth(),
        params=params,
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def onshape_post(path, body):
    if not _metrics.get("api_enabled", True):
        raise RuntimeError("API calls are disabled")
    r = requests.post(
        f"{BASE_URL}{path}",
        headers=HEADERS,
        json=body,
        auth=next_auth(),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def poll_modify_status(doc_id, wid, eid, mid, timeout=30):
    """Polls modification status until DONE/FAILED or timeout. Returns True on DONE."""
    url = f"/api/v6/drawings/d/{doc_id}/w/{wid}/e/{eid}/modificationstatus/{mid}"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = onshape_get(url)
            state = result.get("requestState", "")
            if state == "DONE":
                return True
            if state == "FAILED":
                log(f"Modify FAILED: {result}")
                return False
        except Exception as e:
            log(f"Status poll error: {e}")
            return False
        time.sleep(2)
    log(f"Modify timed out after {timeout}s")
    return False


def get_part_scale(doc_id, wid, ps_eid, part_id):
    """Returns (numerator, denominator) for a scale that fits the part on the sheet."""
    try:
        bb = onshape_get(
            f"/api/v10/parts/d/{doc_id}/w/{wid}/e/{ps_eid}/partid/{part_id}/boundingboxes"
        )
        dx = (bb["highX"] - bb["lowX"]) * 1000  # metres → mm
        dy = (bb["highY"] - bb["lowY"]) * 1000
        dz = (bb["highZ"] - bb["lowZ"]) * 1000
        largest = max(dx, dy, dz)
    except Exception as e:
        log(f"Bounding box fetch failed ({e}); defaulting to 1:1")
        return 1, 1

    AVAILABLE = 120.0  # mm per view slot on an A-size sheet
    standards = [(2,1),(1,1),(1,2),(1,5),(1,10),(1,20),(1,50)]
    for num, den in standards:
        if largest * num / den <= AVAILABLE:
            return num, den
    return 1, 50  # fallback for huge parts


def add_drawing_content(doc_id, wid, drawing_eid, ps_eid, part_id, part_name, scale=(1,1)):
    log(f"Drawing scale for '{part_name}': {scale[0]}:{scale[1]}")
    # --- Phase 1: add front + isometric views with labels ---
    view_body = {
        "description": "Add views",
        "jsonRequests": [{
            "messageName": "onshapeCreateViews",
            "formatVersion": "2021-01-01",
            "views": [
                {
                    "viewType": "TopLevel",
                    "position": {"x": 0.06, "y": 0.12},
                    "orientation": "front",
                    "scale": {"scaleSource": "Custom", "numerator": scale[0], "denominator": scale[1]},
                    "reference": {"elementId": ps_eid, "partId": part_id},
                    "showViewLabel": True,
                },
                {
                    "viewType": "TopLevel",
                    "position": {"x": 0.20, "y": 0.12},
                    "orientation": "isometric",
                    "scale": {"scaleSource": "Custom", "numerator": scale[0], "denominator": scale[1]},
                    "reference": {"elementId": ps_eid, "partId": part_id},
                    "showViewLabel": True,
                },
            ],
        }],
    }
    try:
        r = requests.post(
            f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/e/{drawing_eid}/modify",
            headers=HEADERS, json=view_body, auth=next_auth(), timeout=20,
        )
        if r.status_code not in (200, 201):
            log(f"View modify failed ({r.status_code}): {r.text[:300]}")
            return
        mid = r.json().get("id", "")
        if not mid:
            log("View modify: no modification ID in response")
            return
        ok = poll_modify_status(doc_id, wid, drawing_eid, mid)
        if not ok:
            log("Views did not complete successfully")
            return
        log(f"Views added to drawing for '{part_name}'")
    except Exception as e:
        log(f"View creation error: {e}")
        return

    # --- Phase 2: add Sheet 2 ("Flat Pattern") ---
    sheet_body = {
        "description": "Add flat pattern sheet",
        "jsonRequests": [{
            "messageName": "onshapeCreateSheets",
            "formatVersion": "2021-01-01",
            "sheets": [{"name": "Flat Pattern"}],
        }],
    }
    try:
        r = requests.post(
            f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/e/{drawing_eid}/modify",
            headers=HEADERS, json=sheet_body, auth=next_auth(), timeout=20,
        )
        if r.status_code not in (200, 201):
            log(f"Sheet 2 create failed ({r.status_code}): {r.text[:300]}")
            return
        mid = r.json().get("id", "")
        if not mid:
            log("Sheet 2 modify: no modification ID")
            return
        ok = poll_modify_status(doc_id, wid, drawing_eid, mid)
        if not ok:
            log("Sheet 2 creation did not complete successfully")
            return
        log(f"Sheet 2 added for '{part_name}'")
    except Exception as e:
        log(f"Sheet 2 creation error: {e}")
        return

    # --- Phase 3: add flat pattern view on Sheet 2 ---
    flat_body = {
        "description": "Add flat pattern view",
        "jsonRequests": [{
            "messageName": "onshapeCreateViews",
            "formatVersion": "2021-01-01",
            "views": [{
                "viewType": "TopLevel",
                "position": {"x": 0.13, "y": 0.12},
                "orientation": "flatPattern",
                "scale": {"scaleSource": "Custom", "numerator": scale[0], "denominator": scale[1]},
                "reference": {"elementId": ps_eid, "partId": part_id},
                "showViewLabel": True,
                "sheetIndex": 1,
            }],
        }],
    }
    try:
        r = requests.post(
            f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/e/{drawing_eid}/modify",
            headers=HEADERS, json=flat_body, auth=next_auth(), timeout=20,
        )
        if r.status_code not in (200, 201):
            log(f"Flat pattern view failed ({r.status_code}) — part may not be sheet metal")
            return
        mid = r.json().get("id", "")
        if not mid:
            log("Flat pattern modify: no modification ID")
            return
        ok = poll_modify_status(doc_id, wid, drawing_eid, mid)
        if ok:
            log(f"Flat pattern view added for '{part_name}'")
        else:
            log(f"Flat pattern view failed for '{part_name}' — likely not sheet metal")
    except Exception as e:
        log(f"Flat pattern view error: {e}")


# ============================================================
# REGISTRY
# ============================================================

def load_registry():
    if not os.path.exists(REGISTRY_FILE):
        return {"folders": []}
    try:
        with open(REGISTRY_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {"folders": []}


def save_registry(reg):
    with open(REGISTRY_FILE, "w") as f:
        json.dump(reg, f, indent=2)


def build_lookups(reg):
    """
    Returns (sub_to_top, top_ids, sub_id_to_name).
      sub_to_top:     sub_folder_id -> parent top-level registry entry
      top_ids:        set of top-level folder IDs
      sub_id_to_name: sub_folder_id -> folder name string
    """
    sub_to_top     = {}
    top_ids        = set()
    sub_id_to_name = {}
    for entry in reg.get("folders", []):
        top_ids.add(entry["id"])
        for sf in entry.get("sub_folders", []):
            sid = sf["id"]
            sub_to_top[sid]     = entry
            sub_id_to_name[sid] = sf["name"]
    return sub_to_top, top_ids, sub_id_to_name


# ============================================================
# DATA FETCHING  (1 Onshape API call per cache miss)
# ============================================================

def fetch_folders(reg, sub_to_top, top_ids, sub_id_to_name):
    # Pre-populate all registered folders so empty ones still appear as cards
    top_folders = {}
    for entry in reg.get("folders", []):
        fid = entry["id"]
        top_folders[fid] = {
            "name":        entry["name"],
            "url":         f"{BASE_URL}/documents?nodeId={fid}&resourceType=resourceFolder",
            "sub_folders": set(),
            "doc_count":   0,
        }

    uncategorised_count = 0
    error = None
    try:
        data = onshape_get(
            "/api/v10/documents",
            params={
                "filter":     6,
                "owner":      COMPANY_ID,
                "ownerType":  1,
                "limit":      20,
                "sortColumn": "createdAt",
                "sortOrder":  "desc",
            },
        )
        for d in data.get("items", []):
            pid = d.get("parentId")
            if not pid:
                continue
            if pid in top_ids:
                top_folders[pid]["doc_count"] += 1
            elif pid in sub_to_top:
                top_entry = sub_to_top[pid]
                top_fid   = top_entry["id"]
                if top_fid in top_folders:
                    top_folders[top_fid]["doc_count"] += 1
                    sf_name = sub_id_to_name.get(pid, "")
                    if sf_name:
                        top_folders[top_fid]["sub_folders"].add(sf_name)
            else:
                uncategorised_count += 1
    except Exception as e:
        error = str(e)

    folder_list = sorted(top_folders.values(), key=lambda f: f["name"].lower())
    for f in folder_list:
        f["sub_folders"] = sorted(f["sub_folders"])

    if uncategorised_count > 0:
        folder_list.append({
            "name":        "Uncategorised",
            "url":         f"{BASE_URL}/documents",
            "sub_folders": [],
            "doc_count":   uncategorised_count,
        })

    return folder_list, error


# ============================================================
# WATCHER
# ============================================================

def send_slack(title, message, doc_url=""):
    """Sends a Slack notification via incoming webhook."""
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": title, "emoji": False}},
        {"type": "section", "text": {"type": "mrkdwn", "text": message}},
    ]
    if doc_url:
        blocks.append({
            "type": "actions",
            "elements": [{
                "type": "button",
                "text": {"type": "plain_text", "text": "Open Document"},
                "url": doc_url,
                "style": "primary",
            }]
        })
    try:
        r = requests.post(SLACK_WEBHOOK_URL, json={"blocks": blocks}, timeout=10)
        if r.status_code == 200 and r.text == "ok":
            log("Slack notification sent")
        else:
            log(f"Slack response: {r.status_code} — {r.text[:200]}")
    except Exception as e:
        log(f"Slack error: {e}")


def get_watcher_status():
    with watcher_lock:
        rel_wh  = _watcher["rel_wh_id"]
        ver_wh  = _watcher["ver_wh_id"]
        last_ts = _watcher["last_event_ts"]
        error   = _watcher["error"]

    active = rel_wh is not None and ver_wh is not None and error is None

    if last_ts == 0:
        last_event = "no events yet"
    else:
        secs = int(time.time() - last_ts)
        last_event = f"{secs}s ago" if secs < 60 else f"{secs // 60}m ago"

    return {"active": active, "last_event": last_event, "error": error}


def time_ago(iso_str):
    if not iso_str:
        return "unknown"
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        secs = int((datetime.now(dt.tzinfo) - dt).total_seconds())
        if secs < 60:      return "just now"
        elif secs < 3600:  return f"{secs // 60}m ago"
        elif secs < 86400: return f"{secs // 3600}h ago"
        else:              return f"{secs // 86400}d ago"
    except Exception:
        return iso_str[:10]


def _parse_release_ts(iso_str):
    """Returns (formatted_str, epoch_float) from an ISO timestamp, or ('', 0) on failure."""
    if not iso_str:
        return "", 0
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        return dt.strftime("%d %b %Y, %H:%M"), dt.timestamp()
    except Exception:
        return "", 0


def seed_recent_releases():
    try:
        data = onshape_get("/api/v10/releasepackages",
                           params={"companyId": COMPANY_ID, "limit": 5,
                                   "sortColumn": "createdAt", "sortOrder": "desc"})
        items = data.get("items", data if isinstance(data, list) else [])
        seeded = []
        for item in items:
            doc_id      = item.get("documentId", "")
            created_iso = item.get("createdAt", "")
            created_at_str, created_at_ts = _parse_release_ts(created_iso)
            seeded.append({
                "id":             item.get("id", ""),
                "name":           item.get("name", "Release"),
                "state":          item.get("requestState", "UNKNOWN"),
                "by":             item.get("requestedBy", {}).get("name", "—"),
                "time_ago":       time_ago(created_iso),
                "appeared_at":    time.time() - 301,  # pre-aged: go straight to /previous-releases
                "doc_id":         doc_id,
                "created_at_str": created_at_str,
                "created_at_ts":  created_at_ts,
                "rel_url":        f"{BASE_URL}/documents/{doc_id}" if doc_id else "",
            })
        with _releases_lock:
            _previous_releases.extend(seeded)
        log(f"Release seed: {len(seeded)} releases loaded")
    except Exception as e:
        log(f"Release seed error: {e}")


def register_webhooks():
    """Registers Onshape webhooks for release and version-creation events."""
    url = DASHBOARD_URL.rstrip("/") + "/webhook"
    for filter_str, wh_key in [
        ("onshape.revision.lifecycle.changed", "rel_wh_id"),
        ("onshape.model.lifecycle.created",    "ver_wh_id"),
    ]:
        body = {"url": url, "filter": filter_str, "options": {"collapseEvents": False}}
        try:
            r = onshape_post("/api/v10/webhooks", body)
            wh_id = r.get("id", "?")
            with watcher_lock:
                _watcher[wh_key] = wh_id
                _watcher["error"] = None
            log(f"Webhook registered ({filter_str}): id={wh_id}")
        except Exception as e:
            with watcher_lock:
                _watcher["error"] = str(e)
            log(f"Webhook registration failed ({filter_str}): {e}")


_watcher_started = False

@app.before_request
def ensure_watcher():
    global _watcher_started
    if not _watcher_started:
        _watcher_started = True
        threading.Thread(target=seed_recent_releases, daemon=True).start()
        threading.Thread(target=register_webhooks, daemon=True).start()


# ============================================================
# DEBUG ROUTE
# ============================================================

@app.route("/api/debug")
def api_debug():
    out = {}
    try:
        out["sessioninfo"] = onshape_get("/api/v10/users/sessioninfo")
    except Exception as e:
        out["sessioninfo_error"] = str(e)

    try:
        data = onshape_get(
            "/api/v10/documents",
            params={"filter": 6, "owner": COMPANY_ID, "ownerType": 1,
                    "limit": 5, "sortColumn": "createdAt", "sortOrder": "desc"},
        )
        out["docs_sample"] = [
            {"name": d.get("name"), "parentId": d.get("parentId")}
            for d in data.get("items", [])
        ]
        for d in data.get("items", []):
            pid = d.get("parentId")
            if pid:
                try:
                    out["folder_raw_sample"] = onshape_get(f"/api/v10/folders/{pid}")
                except Exception as e:
                    out["folder_raw_error"] = str(e)
                break
    except Exception as e:
        out["docs_error"] = str(e)

    out["registry"]          = load_registry()
    out["cache_age_seconds"] = round(time.time() - _cache["ts"])
    return jsonify(out)


# ============================================================
# DASHBOARD HTML
# ============================================================

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="300">
<title>Artila Robotics — Onshape Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  @keyframes fade-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  .fade-in { animation: fade-in 0.2s ease forwards; }
  .folder-card { transition: border-color .15s, box-shadow .15s; }
  .folder-card:hover { border-color: #6366f1; box-shadow: 0 0 0 1px #6366f1; }
  a { text-decoration: none; }
</style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">

<!-- NEW DOCUMENT MODAL -->
<div id="modal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
  <div class="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
    <h2 class="text-sm font-semibold mb-5">New Document</h2>
    <form method="POST" action="/create-project" onsubmit="this.querySelector('button[type=submit]').disabled=true">
      <label class="block text-xs text-gray-400 mb-1">Project name</label>
      <input name="project_name" required
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm mb-5
               focus:outline-none focus:border-indigo-500 transition-colors"
        placeholder="e.g. MECH01">
      <div class="flex gap-2 justify-end">
        <button type="button" onclick="closeModal()"
          class="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium transition-colors">
          Cancel
        </button>
        <button type="submit"
          class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded text-xs font-medium transition-colors">
          Create
        </button>
      </div>
    </form>
  </div>
</div>

<header class="sticky top-0 z-10 bg-gray-950/90 backdrop-blur border-b border-gray-800">
  <div class="max-w-5xl mx-auto px-5 h-14 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-7 h-7 bg-blue-600 rounded text-xs font-bold flex items-center justify-center select-none">AR</div>
      <span class="font-semibold text-sm">Artila Robotics</span>
      <span class="text-gray-700 hidden sm:block">|</span>
      <span class="text-gray-400 text-sm hidden sm:block">Projects</span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="openModal()"
        class="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 border border-indigo-600 rounded text-xs font-medium transition-colors">
        New Document
      </button>
      <a href="/" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium transition-colors">
        Refresh
      </a>
      <a href="/export" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium transition-colors">
        Export
      </a>
      <form method="POST" action="/toggle-api">
        <button type="submit"
          class="px-3 py-1.5 rounded text-xs font-medium transition-colors border
                 {% if api_enabled %}bg-green-950 border-green-800 text-green-400 hover:bg-red-950 hover:border-red-800 hover:text-red-400
                 {% else %}bg-red-950 border-red-800 text-red-400 hover:bg-green-950 hover:border-green-800 hover:text-green-400{% endif %}">
          {% if api_enabled %}API On{% else %}API Off{% endif %}
        </button>
      </form>
    </div>
  </div>
</header>

<main class="max-w-5xl mx-auto px-5 py-7">

  {% if flash_msg %}
  <div class="mb-6 p-4 bg-green-950 border border-green-800 rounded-lg text-sm text-green-300">
    {{ flash_msg }}
  </div>
  {% endif %}

  {% if flash_err %}
  <div class="mb-6 p-4 bg-red-950 border border-red-800 rounded-lg text-sm text-red-300">
    Error: {{ flash_err }}
  </div>
  {% endif %}

  {% if error %}
  <div class="mb-6 p-4 bg-red-950 border border-red-800 rounded-lg text-sm text-red-300">
    Error loading data from Onshape: {{ error }}
  </div>
  {% endif %}

  <div class="grid grid-cols-4 gap-3 mb-8">
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">Project Folders</p>
      <p class="text-2xl font-bold text-white">{{ folders | length }}</p>
    </div>
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">Webhook</p>
      <p class="text-2xl font-bold {% if watcher_status.active %}text-green-400{% else %}text-red-400{% endif %}">{% if watcher_status.active %}Active{% else %}Error{% endif %}</p>
      <p class="text-xs text-gray-600 mt-1">{{ watcher_status.last_event }}</p>
    </div>
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">Updated</p>
      <p class="text-2xl font-bold text-white">{{ now }}</p>
    </div>
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">API Calls (all time)</p>
      <p class="text-2xl font-bold text-white">{{ total_api_calls }}</p>
    </div>
  </div>

  <div class="flex items-center justify-between mb-4">
    <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-widest">Project Folders</h2>
    <input id="search" type="text" placeholder="Search folders..."
      oninput="filterFolders()"
      class="w-44 sm:w-56 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-xs
             placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors">
  </div>

  {% if folders %}
  <div id="folder-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
    {% for f in folders %}
    <a href="{{ f.url }}" target="_blank" rel="noopener"
      data-name="{{ f.name | lower }}"
      class="folder-card block bg-gray-900 border border-gray-800 rounded-lg p-5 fade-in">
      <div class="flex items-center gap-3 mb-3">
        <svg class="w-5 h-5 text-indigo-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        </svg>
        <span class="font-semibold text-sm text-white leading-snug">{{ f.name }}</span>
      </div>
      {% if f.sub_folders %}
      <div class="flex flex-wrap gap-1.5 mb-2">
        {% for sf in f.sub_folders %}
        <span class="px-2 py-0.5 rounded text-xs bg-indigo-950 text-indigo-300 border border-indigo-800">{{ sf }}</span>
        {% endfor %}
      </div>
      {% endif %}
      {% if f.doc_count %}
      <p class="text-xs text-gray-500 mt-2">{{ f.doc_count }} document{{ 's' if f.doc_count != 1 else '' }}</p>
      {% else %}
      <p class="text-xs text-gray-600 mt-2">Empty</p>
      {% endif %}
    </a>
    {% endfor %}
  </div>
  {% else %}
  <p class="text-sm text-gray-500">
    {% if error %}See error above.
    {% else %}No project folders registered yet. Click "New Document" to create one.{% endif %}
  </p>
  {% endif %}

  <!-- RELEASES SECTION -->
  <div class="mt-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-widest">Releases</h2>
      <a href="/previous-releases" class="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">All releases &rarr;</a>
    </div>

    {% if recent_releases %}
    <div class="flex flex-col gap-3">
      {% for rel in recent_releases %}
      <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm text-white">{{ rel.name }}</p>
          <p class="text-xs text-gray-500 mt-0.5">
            {% if rel.created_at_str %}{{ rel.created_at_str }}{% else %}{{ rel.time_ago }}{% endif %}
            &middot; {{ rel.by }}
          </p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <span class="px-2 py-1 rounded text-xs border
            {% if rel.state == 'RELEASED' %}bg-green-950 text-green-400 border-green-800
            {% elif rel.state == 'PENDING' %}bg-yellow-950 text-yellow-400 border-yellow-800
            {% else %}bg-gray-800 text-gray-400 border-gray-700{% endif %}">
            {{ rel.state }}
          </span>
          {% if rel.rel_url %}
          <a href="{{ rel.rel_url }}" target="_blank" rel="noopener"
            class="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors">
            Open
          </a>
          {% endif %}
          {% if rel.doc_id %}
          <form method="POST" action="/create-drawing/{{ rel.doc_id }}" onsubmit="this.querySelector('button').disabled=true">
            <button type="submit"
              class="px-2 py-1 rounded text-xs bg-indigo-700 hover:bg-indigo-600 border border-indigo-600 transition-colors">
              Create Drawings
            </button>
          </form>
          {% endif %}
        </div>
      </div>
      {% endfor %}
    </div>
    {% else %}
    <p class="text-sm text-gray-500">No releases in the last 5 minutes.
      <a href="/previous-releases" class="text-indigo-400 hover:text-indigo-300">View all releases.</a>
    </p>
    {% endif %}
  </div>

</main>

<script>
function openModal() {
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(function() {
    document.querySelector('#modal input[name=project_name]').focus();
  }, 50);
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}
// Close on backdrop click
document.getElementById('modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
// Close on Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeModal();
});
function filterFolders() {
  var q = document.getElementById('search').value.toLowerCase();
  var cards = document.querySelectorAll('#folder-grid a');
  cards.forEach(function(c) {
    c.style.display = c.dataset.name.includes(q) ? '' : 'none';
  });
}
</script>

</body>
</html>
"""


PREVIOUS_RELEASES_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Artila Robotics — All Releases</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  a { text-decoration: none; }
</style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">

<header class="sticky top-0 z-10 bg-gray-950/90 backdrop-blur border-b border-gray-800">
  <div class="max-w-5xl mx-auto px-5 h-14 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-7 h-7 bg-blue-600 rounded text-xs font-bold flex items-center justify-center select-none">AR</div>
      <span class="font-semibold text-sm">Artila Robotics</span>
      <span class="text-gray-700">|</span>
      <span class="text-gray-400 text-sm">All Releases</span>
    </div>
    <a href="/" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium transition-colors">
      &larr; Dashboard
    </a>
  </div>
</header>

<main class="max-w-5xl mx-auto px-5 py-7">

  <div class="flex items-center justify-between mb-6">
    <h1 class="text-sm font-semibold text-gray-300">Release History</h1>
    <span class="text-xs text-gray-500">{{ releases | length }} total</span>
  </div>

  {% if releases %}
  <div class="flex flex-col gap-3">
    {% for rel in releases %}
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-sm text-white">{{ rel.name }}</p>
        <p class="text-xs text-gray-500 mt-0.5">
          {% if rel.created_at_str %}{{ rel.created_at_str }}{% else %}{{ rel.time_ago }}{% endif %}
          &middot; {{ rel.by }}
        </p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="px-2 py-1 rounded text-xs border
          {% if rel.state == 'RELEASED' %}bg-green-950 text-green-400 border-green-800
          {% elif rel.state == 'PENDING' %}bg-yellow-950 text-yellow-400 border-yellow-800
          {% else %}bg-gray-800 text-gray-400 border-gray-700{% endif %}">
          {{ rel.state }}
        </span>
        {% if rel.rel_url %}
        <a href="{{ rel.rel_url }}" target="_blank" rel="noopener"
          class="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 transition-colors">
          Open
        </a>
        {% endif %}
        {% if rel.doc_id %}
        <form method="POST" action="/create-drawing/{{ rel.doc_id }}" onsubmit="this.querySelector('button').disabled=true">
          <button type="submit"
            class="px-2 py-1 rounded text-xs bg-indigo-700 hover:bg-indigo-600 border border-indigo-600 transition-colors">
            Create Drawings
          </button>
        </form>
        {% endif %}
      </div>
    </div>
    {% endfor %}
  </div>
  {% else %}
  <p class="text-sm text-gray-500">No previous releases yet. They appear here after 5 minutes or on the next server start.</p>
  {% endif %}

</main>
</body>
</html>
"""


EXPORT_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Artila Robotics — Export</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; }
  a { text-decoration: none; }
</style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen">

<header class="sticky top-0 z-10 bg-gray-950/90 backdrop-blur border-b border-gray-800">
  <div class="max-w-5xl mx-auto px-5 h-14 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-7 h-7 bg-blue-600 rounded text-xs font-bold flex items-center justify-center select-none">AR</div>
      <span class="font-semibold text-sm">Artila Robotics</span>
      <span class="text-gray-700">|</span>
      <span class="text-gray-400 text-sm">Export</span>
    </div>
    <a href="/" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium transition-colors">
      &larr; Dashboard
    </a>
  </div>
</header>

<main class="max-w-5xl mx-auto px-5 py-7">
  <div class="mb-6">
    <h1 class="text-sm font-semibold text-gray-300 mb-1">Export</h1>
    <p class="text-xs text-gray-500">Download all drawings as PDF or all sheet metal flat patterns as DXF. Files are packaged as a ZIP.</p>
  </div>

  {% if folders %}
  <div class="flex flex-col gap-3">
    {% for f in folders %}
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div class="flex-1 min-w-0">
        <p class="font-semibold text-sm text-white">{{ f.name }}</p>
        <p class="text-xs text-gray-600 font-mono mt-0.5">{{ f.id[:16] }}...</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <a href="/export-pdfs/{{ f.id }}"
          class="px-3 py-1.5 rounded text-xs bg-indigo-700 hover:bg-indigo-600 border border-indigo-600 transition-colors">
          Export PDFs
        </a>
        <a href="/export-dxfs/{{ f.id }}"
          class="px-3 py-1.5 rounded text-xs bg-teal-700 hover:bg-teal-600 border border-teal-600 transition-colors">
          Export DXFs
        </a>
      </div>
    </div>
    {% endfor %}
  </div>
  {% else %}
  <p class="text-sm text-gray-500">No documents in registry. Create a document first.</p>
  {% endif %}
</main>
</body>
</html>
"""


# ============================================================
# ROUTES
# ============================================================

@app.route("/")
def index():
    global _cache

    reg = load_registry()
    sub_to_top, top_ids, sub_id_to_name = build_lookups(reg)

    now_ts = time.time()
    if _cache["data"] is not None and (now_ts - _cache["ts"]) < CACHE_TTL:
        folder_list, error = _cache["data"]
    else:
        folder_list, error = fetch_folders(reg, sub_to_top, top_ids, sub_id_to_name)
        _cache["data"] = (folder_list, error)
        _cache["ts"]   = now_ts

    cutoff = time.time() - 300
    with _releases_lock:
        recent_releases = [r for r in _recent_releases if r.get("appeared_at", 0) > cutoff]

    return render_template_string(
        HTML,
        folders=folder_list,
        recent_releases=recent_releases,
        error=error,
        now=datetime.now().strftime("%H:%M"),
        flash_msg=request.args.get("msg", ""),
        flash_err=request.args.get("err", ""),
        watcher_status=get_watcher_status(),
        total_api_calls=_metrics["total_api_calls"],
        api_enabled=_metrics.get("api_enabled", True),
    )


@app.route("/previous-releases")
def previous_releases_page():
    with _releases_lock:
        releases = list(_previous_releases)
    return render_template_string(PREVIOUS_RELEASES_HTML, releases=releases)


@app.route("/create-project", methods=["POST"])
def create_project():
    global _cache

    project_name = request.form.get("project_name", "").strip()
    if not project_name:
        return redirect("/?err=" + quote_plus("Project name is required"))

    try:
        # 1. Create document
        doc_result = onshape_post("/api/v10/documents", {
            "name": project_name, "ownerId": COMPANY_ID, "ownerType": 1,
        })
        doc_id = doc_result.get("id", "")
        workspace_id = doc_result.get("defaultWorkspace", {}).get("id", "")
        if not doc_id or not workspace_id:
            return redirect("/?err=" + quote_plus("Document created but missing ID or workspace"))

        # 2. Create 4 assembly tabs
        for asm_name in ASSEMBLY_NAMES:
            try:
                onshape_post(f"/api/v10/assemblies/d/{doc_id}/w/{workspace_id}", {"name": asm_name})
            except Exception as e:
                log(f"Assembly tab creation failed for '{asm_name}': {e}")

        # 3. Create initial version
        try:
            onshape_post(f"/api/v10/documents/d/{doc_id}/versions", {
                "name": "Initial version",
                "workspaceId": workspace_id,
                "documentId": doc_id,
                "description": "Auto-created",
            })
        except Exception as e:
            log(f"Version creation failed: {e}")

        # 4. Create Development branch
        try:
            onshape_post(f"/api/v10/documents/d/{doc_id}/workspaces", {
                "name": AUTO_BRANCH_NAME,
                "description": "Development branch",
                "workspaceId": workspace_id,
            })
        except Exception as e:
            log(f"Branch creation failed: {e}")

        reg = load_registry()
        reg["folders"].append({
            "id":          doc_id,
            "name":        project_name,
            "workspace_id": workspace_id,
        })
        save_registry(reg)
        _cache["ts"] = 0

        return redirect("/?msg=" + quote_plus(f"Document '{project_name}' created"))

    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        return redirect("/?err=" + quote_plus(f"API Error {status}"))
    except Exception as e:
        return redirect("/?err=" + quote_plus(str(e)[:200]))


@app.route("/api/watcher-status")
def api_watcher_status():
    with watcher_lock:
        snap = dict(_watcher)
    return jsonify(snap)


@app.route("/toggle-api", methods=["POST"])
def toggle_api():
    with _metrics_lock:
        current = _metrics.get("api_enabled", True)
        _metrics["api_enabled"] = not current
        try:
            with open(METRICS_FILE, "w") as f:
                json.dump(_metrics, f)
        except Exception:
            pass
    log(f"API calls {'enabled' if not current else 'disabled'} via dashboard toggle")
    return redirect("/")


@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(silent=True) or {}
    event = data.get("event", "")

    if "model.lifecycle.created" in event:
        # Version creation events include a versionId; document/workspace creation events do not.
        doc_id = data.get("documentId", "")
        ver_id = (data.get("versionId", "")
                  or data.get("payload", {}).get("versionId", ""))
        if doc_id and ver_id:
            with watcher_lock:
                _watcher["last_event_ts"] = time.time()
            with _dvc_lock:
                _doc_version_counts[doc_id] = _doc_version_counts.get(doc_id, 0) + 1
                count = _doc_version_counts[doc_id]
            log(f"Version webhook: doc={doc_id[:8]}, count={count}")
            if count == VERSION_RELEASE_THRESHOLD:
                doc_name = doc_id[:8]
                creator  = (data.get("createdBy", {}).get("name", "")
                            or data.get("payload", {}).get("requestedBy", {}).get("name", ""))
                try:
                    doc_data = onshape_get(f"/api/v10/documents/{doc_id}")
                    doc_name = doc_data.get("name", doc_name)
                    if not creator:
                        creator = doc_data.get("createdBy", {}).get("name", "—")
                except Exception:
                    pass
                send_slack(
                    f"Version alert: {doc_name}",
                    f"Document *{doc_name}* now has *{count} versions* with no release.\n"
                    f"Creator: {creator or '—'}\nConsider cutting a release.",
                    f"{BASE_URL}/documents/{doc_id}",
                )

    elif "revision" in event or "release" in event:
        payload     = data.get("payload", {})
        rel_id      = payload.get("releasePackageId", data.get("id", ""))
        rel_name    = payload.get("name", "Release")
        state       = payload.get("requestState", "UNKNOWN")
        by          = payload.get("requestedBy", {}).get("name", "—")
        doc_id      = payload.get("documentId", "")
        created_iso = payload.get("createdAt", "")
        created_at_str, created_at_ts = _parse_release_ts(created_iso)
        rel_url = f"{BASE_URL}/documents/{doc_id}" if doc_id else ""

        entry = {
            "id":             rel_id,
            "name":           rel_name,
            "state":          state,
            "by":             by,
            "time_ago":       "just now",
            "appeared_at":    time.time(),
            "doc_id":         doc_id,
            "created_at_str": created_at_str,
            "created_at_ts":  created_at_ts,
            "rel_url":        rel_url,
        }

        with _releases_lock:
            _recent_releases[:] = [r for r in _recent_releases if r["id"] != rel_id]
            _recent_releases.insert(0, entry)
            del _recent_releases[20:]
            _previous_releases[:] = [r for r in _previous_releases if r["id"] != rel_id]
            _previous_releases.insert(0, entry)

        with watcher_lock:
            _watcher["last_event_ts"] = time.time()

        # Reset version counter for this document when any release event fires
        if doc_id:
            with _dvc_lock:
                _doc_version_counts.pop(doc_id, None)

        if state == "RELEASED":
            send_slack(
                f"Release: {rel_name}",
                f"*{by}* released *{rel_name}*\nStatus: {state}\n{created_at_str}",
                rel_url if rel_url else f"{BASE_URL}/releases",
            )

        log(f"Release webhook: '{rel_name}' -> {state}")

    return ("", 200)


@app.route("/create-drawing/<doc_id>", methods=["POST"])
def create_drawing(doc_id):
    # Look up workspace_id from registry first (zero extra API calls if found)
    workspace_id = ""
    reg = load_registry()
    for entry in reg.get("folders", []):
        if entry.get("id") == doc_id:
            workspace_id = entry.get("workspace_id", "")
            break

    # Fallback: fetch workspace_id from Onshape (1 extra API call)
    if not workspace_id:
        try:
            doc_data = onshape_get(f"/api/v10/documents/{doc_id}")
            workspace_id = doc_data.get("defaultWorkspace", {}).get("id", "")
        except Exception as e:
            return redirect("/?err=" + quote_plus(f"Could not fetch workspace: {str(e)[:100]}"))

    if not workspace_id:
        return redirect("/?err=" + quote_plus("Workspace ID not available"))

    try:
        elements = onshape_get(f"/api/v10/documents/d/{doc_id}/w/{workspace_id}/elements")
        ps_elements = [e for e in elements if e.get("elementType") == "PARTSTUDIO"]
        if not ps_elements:
            return redirect("/?err=" + quote_plus("No Part Studio found in document"))

        created = []
        for ps in ps_elements:
            ps_eid = ps.get("id", "")
            parts = onshape_get(f"/api/v10/parts/d/{doc_id}/w/{workspace_id}/e/{ps_eid}")
            if not parts:
                continue
            for part in parts:
                part_id   = part.get("partId", "")
                part_name = part.get("name", "Part")
                if not part_id:
                    continue
                body = {
                    "drawingName": f"Drawing - {part_name}",
                    "elementId":   ps_eid,
                    "partId":      part_id,
                    "templateDocumentId":  "e4ecea9df80b53b39ab4fa38",
                    "templateWorkspaceId": "038996d814574f1d1d3b774a",
                    "templateElementId":   "4a80b03c1485e714f587fb61",
                }
                r = requests.post(
                    f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{workspace_id}/create",
                    headers=HEADERS, json=body, auth=next_auth(), timeout=20,
                )
                if r.status_code in (200, 201):
                    drawing_eid = r.json().get("id", "")
                    created.append(part_name)
                    log(f"Drawing created for part '{part_name}', eid={drawing_eid}")
                    if drawing_eid:
                        scale = get_part_scale(doc_id, workspace_id, ps_eid, part_id)
                        add_drawing_content(doc_id, workspace_id, drawing_eid, ps_eid, part_id, part_name, scale)
                else:
                    log(f"Drawing failed for '{part_name}': {r.status_code} {r.text[:200]}")

        if created:
            msg = f"Drawings created for: {', '.join(created)}"
        else:
            msg = "No drawings created — check terminal for errors"
        return redirect("/?msg=" + quote_plus(msg))

    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        return redirect("/?err=" + quote_plus(f"API Error {status}"))
    except Exception as e:
        return redirect("/?err=" + quote_plus(str(e)[:200]))


def _workspace_id_for(doc_id):
    """Returns workspace_id from registry (no API call) or falls back to Onshape GET (1 call)."""
    reg = load_registry()
    for entry in reg.get("folders", []):
        if entry.get("id") == doc_id:
            wid = entry.get("workspace_id", "")
            if wid:
                return wid, reg
    try:
        doc_data = onshape_get(f"/api/v10/documents/{doc_id}")
        return doc_data.get("defaultWorkspace", {}).get("id", ""), reg
    except Exception:
        return "", reg


@app.route("/export")
def export_page():
    reg = load_registry()
    return render_template_string(EXPORT_HTML, folders=reg.get("folders", []))


@app.route("/export-pdfs/<doc_id>")
def export_pdfs(doc_id):
    wid, reg = _workspace_id_for(doc_id)
    if not wid:
        return "Could not determine workspace ID", 400
    try:
        elements = onshape_get(f"/api/v10/documents/d/{doc_id}/w/{wid}/elements")
        drawings = [e for e in elements if e.get("elementType") == "DRAWING"]
        if not drawings:
            return "No drawing elements found in this document", 404

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for elem in drawings:
                eid  = elem.get("id", "")
                name = elem.get("name", eid)
                try:
                    r = requests.get(
                        f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/e/{eid}/export",
                        params={"format": "PDF"},
                        auth=next_auth(),
                        timeout=90,
                    )
                    if r.status_code == 200:
                        safe = name.replace("/", "_").replace("\\", "_")
                        zf.writestr(f"{safe}.pdf", r.content)
                        log(f"PDF exported: {name}")
                    else:
                        log(f"PDF export failed for '{name}': {r.status_code}")
                except Exception as e:
                    log(f"PDF export error for '{name}': {e}")

        buf.seek(0)
        doc_name = next((e["name"] for e in reg.get("folders", []) if e["id"] == doc_id), doc_id[:8])
        return send_file(buf, mimetype="application/zip", as_attachment=True,
                         download_name=f"{doc_name}_drawings.zip")
    except Exception as e:
        return f"Export failed: {str(e)[:200]}", 500


@app.route("/export-dxfs/<doc_id>")
def export_dxfs(doc_id):
    wid, reg = _workspace_id_for(doc_id)
    if not wid:
        return "Could not determine workspace ID", 400
    try:
        elements    = onshape_get(f"/api/v10/documents/d/{doc_id}/w/{wid}/elements")
        part_studios = [e for e in elements if e.get("elementType") == "PARTSTUDIO"]
        if not part_studios:
            return "No part studios found in this document", 404

        buf = io.BytesIO()
        dxf_count = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for ps in part_studios:
                ps_eid = ps.get("id", "")
                parts  = onshape_get(f"/api/v10/parts/d/{doc_id}/w/{wid}/e/{ps_eid}")
                for part in parts:
                    part_id   = part.get("partId", "")
                    part_name = part.get("name", "Part")
                    if not part_id:
                        continue
                    try:
                        r = requests.get(
                            f"{BASE_URL}/api/v5/partstudios/d/{doc_id}/w/{wid}/e/{ps_eid}/export",
                            params={"format": "DXF", "partIds": part_id, "flatten": "true"},
                            auth=next_auth(),
                            timeout=90,
                        )
                        if r.status_code == 200 and r.content:
                            safe = part_name.replace("/", "_").replace("\\", "_")
                            zf.writestr(f"{safe}.dxf", r.content)
                            dxf_count += 1
                            log(f"DXF exported: {part_name}")
                        else:
                            log(f"DXF skipped for '{part_name}': {r.status_code} (not sheet metal?)")
                    except Exception as e:
                        log(f"DXF export error for '{part_name}': {e}")

        if dxf_count == 0:
            return "No DXF files generated — document may contain no sheet metal parts", 404

        buf.seek(0)
        doc_name = next((e["name"] for e in reg.get("folders", []) if e["id"] == doc_id), doc_id[:8])
        return send_file(buf, mimetype="application/zip", as_attachment=True,
                         download_name=f"{doc_name}_flatpatterns.zip")
    except Exception as e:
        return f"Export failed: {str(e)[:200]}", 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"   Onshape Dashboard")
    print(f"   Open: http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, use_reloader=False)
