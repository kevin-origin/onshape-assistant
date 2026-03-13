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
import re
import json
import time
import zipfile
import itertools
import threading
import traceback
import requests
from datetime import datetime, timezone, timedelta
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
TAB_FOLDERS_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tab_folders.json")
ASSEMBLY_NAMES     = ["Master Assembly", "Placement Assembly", "Routing Assembly", "Manufacturing Assembly"]
AUTO_BRANCH_NAME          = "Development"
VERSION_RELEASE_THRESHOLD = 5   # Slack alert when a doc has this many versions with no release
_PS_URL_RE = re.compile(r"documents/([a-f0-9]{24})/w/([a-f0-9]{24})/e/([a-f0-9]{24})")

# Watcher
SLACK_WEBHOOK_URL        = os.environ.get("SLACK_WEBHOOK_URL",     "https://hooks.slack.com/services/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")
WEBHOOK_SECRET           = os.environ.get("ONSHAPE_WEBHOOK_SECRET", "artila-webhook-secret")
DASHBOARD_URL            = os.environ.get("DASHBOARD_URL",          os.environ.get("RENDER_EXTERNAL_URL", "http://localhost:5001"))
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
    ("on_igdCamXJs6Mj3tNLggp5v",  "s3s91k6eaZb4KewMHqgFvwxR5vhgRV7je8bitYKBuzqNB28Z"),
    ("on_ORVkxDOYiRZ2kYtVbQXUU",  "gYVYj2Jb0ya1abi80nNEJ7LXcr0dw0B2pnLowAA1GzZlrwEx"),
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

@app.errorhandler(500)
def handle_500(e):
    log(f"UNHANDLED 500: {e}")
    traceback.print_exc()
    return f"Internal Server Error — check terminal for traceback\n\n{e}", 500

@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin", "")
    if origin.startswith(("moz-extension://", "chrome-extension://")):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response

@app.route("/health")
def health():
    return "ok", 200

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


def _poll_auth():
    """Fixed key for status polls — doesn't consume round-robin slots."""
    _inc_api_calls()
    return _SPECIAL_KEY

def poll_modify_status(doc_id, wid, eid, mid, timeout=30):
    """Polls modification status until DONE/FAILED or timeout. Returns True on DONE."""
    url = f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/e/{eid}/modificationstatus/{mid}"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get(url, headers=HEADERS, auth=_poll_auth(), timeout=15)
            r.raise_for_status()
            result = r.json()
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


def _bg_populate_drawing(doc_id, wid, drawing_eid, ps_eid, part_id, part_name):
    """Background thread: computes scale, adds views + labels to a drawing."""
    try:
        scale = get_part_scale(doc_id, wid, ps_eid, part_id)
        add_drawing_content(doc_id, wid, drawing_eid, ps_eid, part_id, part_name, scale)
    except Exception as e:
        log(f"Background drawing error for '{part_name}': {e}")


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
        log(f"Bounding box: {dx:.1f} x {dy:.1f} x {dz:.1f} mm, largest={largest:.1f} mm")
    except Exception as e:
        log(f"Bounding box fetch failed ({e}); defaulting to 1:1")
        return 1, 1

    AVAILABLE = 50.0  # mm per view slot (accounts for isometric projection + two views)
    standards = [(2,1),(1,1),(1,2),(1,3),(1,5),(1,7),(1,10),(1,15),(1,20),(1,50)]
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
                    "position": {"x": 0.06, "y": 0.17},
                    "orientation": "front",
                    "scale": {"scaleSource": "Custom", "numerator": scale[0], "denominator": scale[1]},
                    "reference": {"elementId": ps_eid, "partId": part_id},
                    "showViewLabel": True,
                    "name": "Front",
                },
                {
                    "viewType": "TopLevel",
                    "position": {"x": 0.20, "y": 0.17},
                    "orientation": "isometric",
                    "scale": {"scaleSource": "Custom", "numerator": scale[0], "denominator": scale[1]},
                    "reference": {"elementId": ps_eid, "partId": part_id},
                    "showViewLabel": True,
                    "name": "Isometric",
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
                "position": {"x": 0.13, "y": 0.17},
                "orientation": "flatPattern",
                "scale": {"scaleSource": "Custom", "numerator": scale[0], "denominator": scale[1]},
                "reference": {"elementId": ps_eid, "partId": part_id},
                "showViewLabel": True,
                "name": "Flat Pattern",
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

    # --- Phase 4: enable view labels via post-creation edit (+3 API calls) ---
    try:
        drawing_data = onshape_get(
            f"/api/v6/drawings/d/{doc_id}/w/{wid}/e/{drawing_eid}/jsonexport"
        )
        view_edits = []
        if isinstance(drawing_data, dict):
            for sheet in drawing_data.get("sheets", []):
                for view in sheet.get("views", []):
                    vid = view.get("viewId") or view.get("id", "")
                    if vid:
                        view_edits.append({"viewId": vid, "showViewLabel": True})
        if view_edits:
            log(f"Enabling labels on {len(view_edits)} views")
            edit_body = {
                "description": "Enable view labels",
                "jsonRequests": [{
                    "messageName": "onshapeEditViews",
                    "formatVersion": "2021-01-01",
                    "views": view_edits,
                }],
            }
            r = requests.post(
                f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/e/{drawing_eid}/modify",
                headers=HEADERS, json=edit_body, auth=next_auth(), timeout=20,
            )
            if r.status_code in (200, 201):
                mid = r.json().get("id", "")
                if mid:
                    ok = poll_modify_status(doc_id, wid, drawing_eid, mid)
                    log(f"View labels {'enabled' if ok else 'edit failed'}")
            else:
                log(f"View labels edit failed ({r.status_code}): {r.text[:300]}")
        else:
            log(f"No views found for label editing; JSON keys: "
                f"{list(drawing_data.keys()) if isinstance(drawing_data, dict) else 'non-dict'}")
    except Exception as e:
        log(f"View labels edit skipped: {e}")


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
        body = {"url": url, "filter": filter_str, "options": {"collapseEvents": False}, "companyId": COMPANY_ID}
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

    out["registry"] = load_registry()
    return jsonify(out)


# ============================================================
# DASHBOARD HTML
# ============================================================

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="3600">
<title>Artila Robotics — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #0a0a0a; color: rgba(255,255,255,0.88); overflow-x: hidden; }
  .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); transition: background .15s, border-color .15s; }
  .card:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.13); }
  .card-static { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); }
  .btn-primary { background: #39A57D; color: #fff; transition: background .15s; }
  .btn-primary:hover { background: #2e906c; }
  .btn-ghost { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); transition: background .15s, border-color .15s; }
  .btn-ghost:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.18); color: rgba(255,255,255,0.85); }
  .inp { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.9); transition: border-color .15s; }
  .inp:focus { outline: none; border-color: #39A57D; }
  .inp::placeholder { color: rgba(255,255,255,0.25); }
  .accent { color: #39A57D; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #39A57D; }
  .sep { border-top: 1px solid rgba(255,255,255,0.06); }
  a { text-decoration: none; }
  @keyframes fade-up { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  .fade-up { animation: fade-up .2s ease forwards; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 2px; }
</style>
</head>
<body>

<!-- MODAL -->
<div id="modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4" style="background:rgba(0,0,0,0.8);backdrop-filter:blur(8px)">
  <div class="card-static rounded-2xl p-7 w-full max-w-md fade-up">
    <p class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.9)">New Document</p>
    <p class="text-xs mb-6" style="color:rgba(255,255,255,0.35)">Creates a document with 4 assembly tabs, an initial version, and a Development branch.</p>
    <form method="POST" action="/create-project" onsubmit="this.querySelector('button[type=submit]').disabled=true">
      <label class="block text-xs mb-1.5" style="color:rgba(255,255,255,0.45)">Project name</label>
      <input name="project_name" required
        class="inp w-full rounded-lg px-3 py-2.5 text-sm mb-4" placeholder="e.g. MECH-01">
      <label class="block text-xs mb-1.5" style="color:rgba(255,255,255,0.45)">Parent folder ID <span style="color:rgba(255,255,255,0.2)">(optional — paste Onshape folder ID)</span></label>
      <input name="parent_folder_id"
        class="inp w-full rounded-lg px-3 py-2.5 text-sm mb-6 font-mono" placeholder="e.g. 6810c247e7c40668c3281...">
      <div class="flex gap-2 justify-end">
        <button type="button" onclick="closeModal()"
          class="btn-ghost px-4 py-2 rounded-lg text-xs font-medium">Cancel</button>
        <button type="submit"
          class="btn-primary px-5 py-2 rounded-lg text-xs font-semibold">Create</button>
      </div>
    </form>
  </div>
</div>

<!-- HEADER -->
<header class="sticky top-0 z-10" style="background:rgba(10,10,10,0.9);backdrop-filter:blur(16px);border-bottom:1px solid rgba(255,255,255,0.07)">
  <div class="max-w-5xl mx-auto px-8 h-14 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="text-sm font-semibold" style="color:rgba(255,255,255,0.9)">Artila Robotics</span>
      <span class="text-xs" style="color:rgba(255,255,255,0.15)">|</span>
      <span class="text-xs" style="color:rgba(255,255,255,0.35)">Dashboard</span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="openModal()" class="btn-primary px-3.5 py-1.5 rounded-lg text-xs font-semibold">New Document</button>
      <a href="/" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">Refresh</a>
      <a href="/export" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">Export</a>
      <form method="POST" action="/toggle-api">
        <button type="submit" class="px-3 py-1.5 rounded-lg text-xs font-medium"
          style="{% if api_enabled %}background:rgba(57,165,125,0.12);border:1px solid rgba(57,165,125,0.28);color:#39A57D{% else %}background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#f87171{% endif %}">
          {% if api_enabled %}API On{% else %}API Off{% endif %}
        </button>
      </form>
    </div>
  </div>
</header>

<!-- FLASH MESSAGES -->
{% if flash_msg or flash_err %}
<div class="max-w-5xl mx-auto px-8 pt-6">
  {% if flash_msg %}
  <div class="px-4 py-3 rounded-xl text-sm fade-up mb-3"
    style="background:rgba(57,165,125,0.1);border:1px solid rgba(57,165,125,0.25);color:#39A57D">{{ flash_msg }}</div>
  {% endif %}
  {% if flash_err %}
  <div class="px-4 py-3 rounded-xl text-sm fade-up"
    style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#f87171">{{ flash_err }}</div>
  {% endif %}
</div>
{% endif %}

<!-- HERO -->
<section class="max-w-5xl mx-auto px-8 pt-20 pb-16">
  <p class="eyebrow mb-5">Engineering Dashboard</p>
  <h1 class="text-5xl font-bold mb-5 leading-tight" style="color:rgba(255,255,255,0.95);letter-spacing:-0.025em">
    Full-cycle visibility<br>for Artila Robotics.
  </h1>
  <p class="text-base mb-8" style="color:rgba(255,255,255,0.38);max-width:480px;line-height:1.7">
    Monitor releases, manage Onshape documents, and export production files — all from one interface.
  </p>
  <div class="flex items-center gap-3 flex-wrap">
    <button onclick="openModal()" class="btn-primary px-5 py-2.5 rounded-xl text-sm font-semibold">New Document</button>
    <a href="/previous-releases" class="btn-ghost px-5 py-2.5 rounded-xl text-sm font-medium">View All Releases &rarr;</a>
    <a href="/export" class="btn-ghost px-5 py-2.5 rounded-xl text-sm font-medium">Export Files</a>
  </div>
</section>

<!-- STAT STRIP -->
<div class="sep">
  <div class="max-w-5xl mx-auto px-8 py-10 grid grid-cols-3 gap-4">
    <div class="card-static rounded-2xl px-6 py-6">
      <p class="eyebrow mb-3">Webhook</p>
      <p class="text-3xl font-bold mb-1 {% if watcher_status.active %}accent{% else %}text-red-400{% endif %}">
        {% if watcher_status.active %}Active{% else %}Error{% endif %}
      </p>
      <p class="text-xs" style="color:rgba(255,255,255,0.25)">Last event: {{ watcher_status.last_event }}</p>
    </div>
    <div class="card-static rounded-2xl px-6 py-6">
      <p class="eyebrow mb-3">Last Refreshed</p>
      <p class="text-3xl font-bold mb-1" style="color:rgba(255,255,255,0.88)">{{ now }}</p>
      <p class="text-xs" style="color:rgba(255,255,255,0.25)">Auto-refresh every 60 min</p>
    </div>
    <div class="card-static rounded-2xl px-6 py-6">
      <p class="eyebrow mb-3">API Calls</p>
      <p class="text-3xl font-bold mb-1" style="color:rgba(255,255,255,0.88)">{{ total_api_calls }}</p>
      <p class="text-xs" style="color:rgba(255,255,255,0.25)">Since last deploy</p>
    </div>
  </div>
</div>

<!-- ACTIVE RELEASES -->
<div class="sep">
  <section class="max-w-5xl mx-auto px-8 py-16">
    <div class="mb-10">
      <p class="eyebrow mb-2">Live Feed</p>
      <h2 class="text-2xl font-bold mb-2" style="color:rgba(255,255,255,0.9)">Active Releases</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.35)">Release activity from the past 5 minutes. <a href="/previous-releases" class="accent">View full history &rarr;</a></p>
    </div>

    {% set candidates = recent_releases | selectattr("state", "equalto", "PENDING") | list %}
    {% set approved   = recent_releases | selectattr("state", "equalto", "RELEASED") | list %}

    <!-- Release Candidates -->
    <div class="mb-10">
      <div class="flex items-center gap-3 mb-4">
        <h3 class="text-sm font-semibold" style="color:rgba(255,255,255,0.5)">Release Candidates</h3>
        <span class="px-2 py-0.5 rounded-full text-xs font-medium" style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);color:#fbbf24">PENDING</span>
        <span class="text-xs" style="color:rgba(255,255,255,0.2)">{{ candidates | length }}</span>
      </div>
      {% if candidates %}
      <div class="flex flex-col gap-2">
        {% for rel in candidates %}
        <div class="card rounded-2xl px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-4 fade-up" style="border-color:rgba(251,191,36,0.12)">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.9)">{{ rel.name }}</p>
            <p class="text-xs" style="color:rgba(255,255,255,0.33)">
              {% if rel.created_at_str %}{{ rel.created_at_str }}{% else %}{{ rel.time_ago }}{% endif %}
              &middot; {{ rel.by }}
            </p>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="px-3 py-1 rounded-full text-xs font-medium" style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.28);color:#fbbf24">Awaiting approval</span>
            {% if rel.rel_url %}<a href="{{ rel.rel_url }}" target="_blank" rel="noopener" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">Open</a>{% endif %}
          </div>
        </div>
        {% endfor %}
      </div>
      {% else %}
      <div class="card-static rounded-xl px-4 py-5 text-center">
        <p class="text-xs" style="color:rgba(255,255,255,0.22)">No pending release candidates</p>
      </div>
      {% endif %}
    </div>

    <!-- Approved Releases -->
    <div>
      <div class="flex items-center gap-3 mb-4">
        <h3 class="text-sm font-semibold" style="color:rgba(255,255,255,0.5)">Approved Releases</h3>
        <span class="px-2 py-0.5 rounded-full text-xs font-medium" style="background:rgba(57,165,125,0.13);border:1px solid rgba(57,165,125,0.28);color:#39A57D">RELEASED</span>
        <span class="text-xs" style="color:rgba(255,255,255,0.2)">{{ approved | length }}</span>
      </div>
      {% if approved %}
      <div class="flex flex-col gap-2">
        {% for rel in approved %}
        <div class="card rounded-2xl px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-4 fade-up" style="border-color:rgba(57,165,125,0.12)">
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.9)">{{ rel.name }}</p>
            <p class="text-xs" style="color:rgba(255,255,255,0.33)">
              {% if rel.created_at_str %}{{ rel.created_at_str }}{% else %}{{ rel.time_ago }}{% endif %}
              &middot; {{ rel.by }}
            </p>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="px-3 py-1 rounded-full text-xs font-medium" style="background:rgba(57,165,125,0.13);border:1px solid rgba(57,165,125,0.28);color:#39A57D">Released</span>
            {% if rel.rel_url %}<a href="{{ rel.rel_url }}" target="_blank" rel="noopener" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">Open</a>{% endif %}
            {% if rel.doc_id %}
            <form method="POST" action="/create-drawing/{{ rel.doc_id }}" onsubmit="this.querySelector('button').disabled=true">
              <button type="submit" class="btn-primary px-3 py-1.5 rounded-lg text-xs font-semibold">Create Drawings</button>
            </form>
            {% endif %}
          </div>
        </div>
        {% endfor %}
      </div>
      {% else %}
      <div class="card-static rounded-xl px-4 py-5 text-center">
        <p class="text-xs" style="color:rgba(255,255,255,0.22)">No approved releases in the last 5 minutes. <a href="/previous-releases" class="accent" style="opacity:0.8">View history &rarr;</a></p>
      </div>
      {% endif %}
    </div>
  </section>
</div>

<!-- PROJECT DOCUMENTS -->
<div class="sep">
  <section class="max-w-5xl mx-auto px-8 py-16">
    <div class="mb-8">
      <p class="eyebrow mb-2">Registry</p>
      <h2 class="text-2xl font-bold mb-2" style="color:rgba(255,255,255,0.9)">Project Documents</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.35)">Documents created through this dashboard. <button onclick="openModal()" style="background:none;border:none;cursor:pointer;font-size:inherit;padding:0;" class="accent">Create new &rarr;</button></p>
    </div>
    {% if registry_items %}
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {% for item in registry_items %}
      <div class="card rounded-2xl px-6 py-5">
        <p class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.88)">{{ item.name }}</p>
        <p class="text-xs font-mono mb-4" style="color:rgba(255,255,255,0.2)">{{ item.id[:24] }}...</p>
        <div class="flex gap-2 flex-wrap">
          <a href="https://cad.onshape.com/documents/{{ item.id }}" target="_blank" rel="noopener"
            class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">Open in Onshape</a>
          <a href="/export-pdfs/{{ item.id }}" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">PDFs</a>
          <a href="/export-dxfs/{{ item.id }}" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">DXFs</a>
        </div>
      </div>
      {% endfor %}
    </div>
    {% else %}
    <div class="card-static rounded-2xl px-6 py-16 text-center">
      <p class="text-sm font-medium mb-2" style="color:rgba(255,255,255,0.35)">No documents yet</p>
      <p class="text-xs mb-5" style="color:rgba(255,255,255,0.2)">Documents created here get quick-access links and export tools.</p>
      <button onclick="openModal()" class="btn-primary px-5 py-2.5 rounded-xl text-xs font-semibold">New Document</button>
    </div>
    {% endif %}
  </section>
</div>

<!-- VERSION MONITORING -->
<div class="sep">
  <section class="max-w-5xl mx-auto px-8 py-16">
    <div class="mb-8">
      <p class="eyebrow mb-2">Monitoring</p>
      <h2 class="text-2xl font-bold mb-2" style="color:rgba(255,255,255,0.9)">Version Activity</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.35)">Webhook-driven version tracking. A Slack alert fires when a document reaches the threshold without a release.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="card-static rounded-2xl px-6 py-6">
        <p class="eyebrow mb-3">Alert Threshold</p>
        <p class="text-3xl font-bold accent mb-1">{{ version_threshold }}</p>
        <p class="text-xs" style="color:rgba(255,255,255,0.25)">versions without a release</p>
      </div>
      <div class="card-static rounded-2xl px-6 py-6">
        <p class="eyebrow mb-3">Notification</p>
        <p class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.75)">Slack Alert</p>
        <p class="text-xs" style="color:rgba(255,255,255,0.25)">Tags document creator on trigger</p>
      </div>
      <div class="card-static rounded-2xl px-6 py-6">
        <p class="eyebrow mb-3">Event Source</p>
        <p class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.75)">Onshape Webhook</p>
        <p class="text-xs" style="color:rgba(255,255,255,0.25)">model.lifecycle.created events</p>
      </div>
    </div>
  </section>
</div>

<!-- EXPORT TOOLS -->
<div class="sep">
  <section class="max-w-5xl mx-auto px-8 py-16">
    <div class="mb-8">
      <p class="eyebrow mb-2">Production</p>
      <h2 class="text-2xl font-bold mb-2" style="color:rgba(255,255,255,0.9)">Export Tools</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.35)">Download drawings as PDFs or sheet metal flat patterns as DXFs. Each export is a ZIP file.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div class="card rounded-2xl px-6 py-6">
        <p class="eyebrow mb-4">PDF Export</p>
        <p class="text-sm font-semibold mb-2" style="color:rgba(255,255,255,0.85)">Drawing sheets as PDF</p>
        <p class="text-xs mb-5" style="color:rgba(255,255,255,0.35);line-height:1.6">All drawing elements rendered as a multi-page PDF. Select a document from the registry to export.</p>
        <a href="/export" class="btn-ghost px-4 py-2 rounded-lg text-xs font-medium inline-block">Go to Export &rarr;</a>
      </div>
      <div class="card rounded-2xl px-6 py-6">
        <p class="eyebrow mb-4">DXF Export</p>
        <p class="text-sm font-semibold mb-2" style="color:rgba(255,255,255,0.85)">Flat patterns for sheet metal</p>
        <p class="text-xs mb-5" style="color:rgba(255,255,255,0.35);line-height:1.6">Flat pattern DXFs with partId-level granularity. Only parts flagged as sheet metal are included.</p>
        <a href="/export" class="btn-ghost px-4 py-2 rounded-lg text-xs font-medium inline-block">Go to Export &rarr;</a>
      </div>
    </div>
  </section>
</div>

<!-- DRAWING GENERATOR -->
<div class="sep">
  <section class="max-w-5xl mx-auto px-8 py-16">
    <div class="mb-8">
      <p class="eyebrow mb-2">Production</p>
      <h2 class="text-2xl font-bold mb-2" style="color:rgba(255,255,255,0.9)">Drawing Generator</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.35)">Generate drawings for all parts in a specific Part Studio. Paste the Part Studio URL from Onshape.</p>
    </div>
    <div class="card rounded-2xl px-6 py-6" style="max-width:540px">
      <form method="POST" action="/generate-drawings" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Generating...'">
        <label class="text-xs font-medium mb-2 block" style="color:rgba(255,255,255,0.5)">Part Studio URL</label>
        <input type="text" name="ps_url" class="inp font-mono w-full mb-4" placeholder="https://cad.onshape.com/documents/.../w/.../e/..." required>
        <button type="submit" class="btn-primary px-5 py-2 rounded-lg text-xs font-medium">Generate Drawings</button>
      </form>
    </div>
  </section>
</div>

<!-- SYSTEM -->
<div class="sep">
  <section class="max-w-5xl mx-auto px-8 py-16 pb-28">
    <div class="mb-8">
      <p class="eyebrow mb-2">System</p>
      <h2 class="text-2xl font-bold mb-2" style="color:rgba(255,255,255,0.9)">Controls</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.35)">API access, webhook health, and diagnostics.</p>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="card-static rounded-2xl px-6 py-6">
        <p class="eyebrow mb-3">API Access</p>
        <p class="text-sm font-semibold mb-4" style="color:{% if api_enabled %}#39A57D{% else %}#f87171{% endif %}">
          {% if api_enabled %}Enabled{% else %}Disabled{% endif %}
        </p>
        <form method="POST" action="/toggle-api">
          <button type="submit" class="{% if api_enabled %}btn-ghost{% else %}btn-primary{% endif %} px-4 py-2 rounded-lg text-xs font-medium w-full">
            {% if api_enabled %}Disable API{% else %}Enable API{% endif %}
          </button>
        </form>
      </div>
      <div class="card-static rounded-2xl px-6 py-6">
        <p class="eyebrow mb-3">Webhook Health</p>
        <p class="text-sm font-semibold mb-1 {% if watcher_status.active %}accent{% else %}text-red-400{% endif %}">
          {% if watcher_status.active %}Connected{% else %}Disconnected{% endif %}
        </p>
        {% if watcher_status.error %}
        <p class="text-xs" style="color:rgba(248,113,113,0.7)">{{ watcher_status.error[:80] }}</p>
        {% else %}
        <p class="text-xs" style="color:rgba(255,255,255,0.25)">{{ watcher_status.last_event }}</p>
        {% endif %}
      </div>
      <div class="card-static rounded-2xl px-6 py-6">
        <p class="eyebrow mb-3">Diagnostics</p>
        <p class="text-sm font-semibold mb-4" style="color:rgba(255,255,255,0.6)">Raw API debug output</p>
        <a href="/api/debug" target="_blank" class="btn-ghost px-4 py-2 rounded-lg text-xs font-medium inline-block w-full text-center">Open /api/debug</a>
      </div>
    </div>
  </section>
</div>

<script>
function openModal() {
  document.getElementById('modal').classList.remove('hidden');
  setTimeout(function(){ document.querySelector('#modal input[name=project_name]').focus(); }, 50);
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}
document.getElementById('modal').addEventListener('click', function(e){ if(e.target===this) closeModal(); });
document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeModal(); });
</script>

</body>
</html>
"""


PREVIOUS_RELEASES_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Artila Robotics — Release History</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #0a0a0a; color: rgba(255,255,255,0.88); }
  .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); transition: background .15s, border-color .15s; }
  .card:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.13); }
  .btn-primary { background: #39A57D; color: #fff; transition: background .15s; }
  .btn-primary:hover { background: #2e906c; }
  .btn-ghost { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); transition: background .15s; }
  .btn-ghost:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
  a { text-decoration: none; }
</style>
</head>
<body class="min-h-screen">

<header class="sticky top-0 z-10" style="background:rgba(10,10,10,0.88);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,0.07)">
  <div class="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="text-sm font-semibold" style="color:rgba(255,255,255,0.9)">Artila Robotics</span>
      <span class="text-xs" style="color:rgba(255,255,255,0.15)">|</span>
      <span class="text-xs" style="color:rgba(255,255,255,0.35)">Release History</span>
    </div>
    <a href="/" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">&larr; Dashboard</a>
  </div>
</header>

<main class="max-w-4xl mx-auto px-6 py-8">

  <div class="flex items-center justify-between mb-5">
    <h1 class="text-sm font-semibold" style="color:rgba(255,255,255,0.88)">Release History</h1>
    <span class="text-xs" style="color:rgba(255,255,255,0.3)">{{ releases | length }} total</span>
  </div>

  {% if releases %}
  <div class="flex flex-col gap-2">
    {% for rel in releases %}
    <div class="card rounded-xl px-4 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium" style="color:rgba(255,255,255,0.88)">{{ rel.name }}</p>
        <p class="text-xs mt-0.5" style="color:rgba(255,255,255,0.33)">
          {% if rel.created_at_str %}{{ rel.created_at_str }}{% else %}{{ rel.time_ago }}{% endif %}
          &middot; {{ rel.by }}
        </p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="px-2.5 py-0.5 rounded-full text-xs font-medium"
          style="{% if rel.state == 'RELEASED' %}background:rgba(57,165,125,0.13);border:1px solid rgba(57,165,125,0.28);color:#39A57D{% elif rel.state == 'PENDING' %}background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.28);color:#fbbf24{% else %}background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.4){% endif %}">
          {{ rel.state }}
        </span>
        {% if rel.rel_url %}
        <a href="{{ rel.rel_url }}" target="_blank" rel="noopener"
          class="btn-ghost px-2.5 py-1 rounded-lg text-xs font-medium">Open</a>
        {% endif %}
        {% if rel.doc_id %}
        <form method="POST" action="/create-drawing/{{ rel.doc_id }}" onsubmit="this.querySelector('button').disabled=true">
          <button type="submit" class="btn-primary px-2.5 py-1 rounded-lg text-xs font-semibold">Create Drawings</button>
        </form>
        {% endif %}
      </div>
    </div>
    {% endfor %}
  </div>
  {% else %}
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)" class="rounded-xl px-4 py-10 text-center">
    <p class="text-sm" style="color:rgba(255,255,255,0.28)">No releases yet. They appear here after 5 minutes or on next restart.</p>
  </div>
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: #0a0a0a; color: rgba(255,255,255,0.88); }
  .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); transition: background .15s, border-color .15s; }
  .card:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.13); }
  .btn-primary { background: #39A57D; color: #fff; transition: background .15s; }
  .btn-primary:hover { background: #2e906c; }
  .btn-ghost { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); transition: background .15s; }
  .btn-ghost:hover { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.85); }
  a { text-decoration: none; }
</style>
</head>
<body class="min-h-screen">

<header class="sticky top-0 z-10" style="background:rgba(10,10,10,0.88);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,0.07)">
  <div class="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <span class="text-sm font-semibold" style="color:rgba(255,255,255,0.9)">Artila Robotics</span>
      <span class="text-xs" style="color:rgba(255,255,255,0.15)">|</span>
      <span class="text-xs" style="color:rgba(255,255,255,0.35)">Export</span>
    </div>
    <a href="/" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-medium">&larr; Dashboard</a>
  </div>
</header>

<main class="max-w-4xl mx-auto px-6 py-8">
  <div class="mb-6">
    <h1 class="text-sm font-semibold mb-1" style="color:rgba(255,255,255,0.88)">Export</h1>
    <p class="text-xs" style="color:rgba(255,255,255,0.32)">Download all drawings as PDF or sheet metal flat patterns as DXF. Each export is a ZIP file.</p>
  </div>

  {% if releases %}
  <div class="flex flex-col gap-2">
    {% for rel in releases %}
    {% if rel.doc_id %}
    <div class="card rounded-2xl px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div class="flex-1 min-w-0">
        <p class="text-sm font-semibold mb-0.5" style="color:rgba(255,255,255,0.88)">{{ rel.name }}</p>
        <p class="text-xs" style="color:rgba(255,255,255,0.33)">
          {% if rel.created_at_str %}{{ rel.created_at_str }}{% else %}{{ rel.time_ago }}{% endif %}
          &middot; {{ rel.by }}
        </p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <span class="px-2.5 py-1 rounded-full text-xs font-medium"
          style="{% if rel.state == 'RELEASED' %}background:rgba(57,165,125,0.13);border:1px solid rgba(57,165,125,0.28);color:#39A57D{% elif rel.state == 'PENDING' %}background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.28);color:#fbbf24{% else %}background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.4){% endif %}">
          {{ rel.state }}
        </span>
        <a href="/export-pdfs/{{ rel.doc_id }}" class="btn-primary px-3 py-1.5 rounded-lg text-xs font-semibold">Export PDFs</a>
        <a href="/export-dxfs/{{ rel.doc_id }}" class="btn-ghost px-3 py-1.5 rounded-lg text-xs font-semibold">Export DXFs</a>
      </div>
    </div>
    {% endif %}
    {% endfor %}
  </div>
  {% else %}
  <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)" class="rounded-xl px-4 py-10 text-center">
    <p class="text-sm" style="color:rgba(255,255,255,0.28)">No releases yet. Releases appear here after being created in Onshape.</p>
  </div>
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
    cutoff = time.time() - 300
    with _releases_lock:
        recent_releases = [r for r in _recent_releases if r.get("appeared_at", 0) > cutoff]

    reg = load_registry()
    return render_template_string(
        HTML,
        recent_releases=recent_releases,
        registry_items=reg["folders"],
        now=datetime.now(timezone(timedelta(hours=5, minutes=30))).strftime("%H:%M IST"),
        flash_msg=request.args.get("msg", ""),
        flash_err=request.args.get("err", ""),
        watcher_status=get_watcher_status(),
        total_api_calls=_metrics["total_api_calls"],
        api_enabled=_metrics.get("api_enabled", True),
        version_threshold=VERSION_RELEASE_THRESHOLD,
    )


@app.route("/previous-releases")
def previous_releases_page():
    with _releases_lock:
        releases = list(_previous_releases)
    return render_template_string(PREVIOUS_RELEASES_HTML, releases=releases)


@app.route("/create-project", methods=["POST"])
def create_project():
    project_name = request.form.get("project_name", "").strip()
    parent_folder_id = request.form.get("parent_folder_id", "").strip()
    if not project_name:
        return redirect("/?err=" + quote_plus("Project name is required"))

    try:
        # 1. Create document
        doc_body = {"name": project_name, "ownerId": COMPANY_ID, "ownerType": 1}
        if parent_folder_id:
            doc_body["parentId"] = parent_folder_id
        doc_result = onshape_post("/api/v10/documents", doc_body)
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
                        threading.Thread(
                            target=_bg_populate_drawing,
                            args=(doc_id, workspace_id, drawing_eid, ps_eid, part_id, part_name),
                            daemon=True,
                        ).start()
                else:
                    log(f"Drawing failed for '{part_name}': {r.status_code} {r.text[:200]}")

        if created:
            msg = f"Drawings created for: {', '.join(created)} (views adding in background)"
        else:
            msg = "No drawings created — check terminal for errors"
        return redirect("/?msg=" + quote_plus(msg))

    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        return redirect("/?err=" + quote_plus(f"API Error {status}"))
    except Exception as e:
        return redirect("/?err=" + quote_plus(str(e)[:200]))


@app.route("/generate-drawings", methods=["POST"])
def generate_drawings():
    url = (request.form.get("ps_url") or "").strip()
    if not url:
        return redirect("/?err=" + quote_plus("No URL provided"))

    m = _PS_URL_RE.search(url)
    if not m:
        return redirect("/?err=" + quote_plus(
            "Invalid URL — expected format: https://cad.onshape.com/documents/{did}/w/{wid}/e/{eid}"))

    doc_id, wid, ps_eid = m.group(1), m.group(2), m.group(3)
    log(f"Generate drawings: doc={doc_id}, wid={wid}, ps_eid={ps_eid}")

    try:
        parts = onshape_get(f"/api/v10/parts/d/{doc_id}/w/{wid}/e/{ps_eid}")
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        log(f"Parts fetch HTTP error: {status}")
        traceback.print_exc()
        if status == 404:
            return redirect("/?err=" + quote_plus(
                "Element not found — confirm URL points to a Part Studio"))
        return redirect("/?err=" + quote_plus(f"API Error {status}"))
    except Exception as e:
        log(f"Parts fetch exception: {e}")
        traceback.print_exc()
        return redirect("/?err=" + quote_plus(str(e)[:200]))

    if not isinstance(parts, list) or not parts:
        log(f"Parts response unexpected or empty: {str(parts)[:200]}")
        return redirect("/?err=" + quote_plus("No parts found in that Part Studio"))

    try:
        created = []
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
            try:
                r = requests.post(
                    f"{BASE_URL}/api/v6/drawings/d/{doc_id}/w/{wid}/create",
                    headers=HEADERS, json=body, auth=next_auth(), timeout=20,
                )
                if r.status_code in (200, 201):
                    drawing_eid = r.json().get("id", "")
                    created.append(part_name)
                    log(f"Drawing created for part '{part_name}', eid={drawing_eid}")
                    if drawing_eid:
                        threading.Thread(
                            target=_bg_populate_drawing,
                            args=(doc_id, wid, drawing_eid, ps_eid, part_id, part_name),
                            daemon=True,
                        ).start()
                else:
                    log(f"Drawing failed for '{part_name}': {r.status_code} {r.text[:200]}")
            except Exception as e:
                log(f"Drawing error for '{part_name}': {e}")
                traceback.print_exc()

        if created:
            msg = f"Drawings created for: {', '.join(created)} (views adding in background)"
        else:
            msg = "No drawings created — check terminal for errors"
        return redirect("/?msg=" + quote_plus(msg))

    except Exception as e:
        log(f"Generate-drawings error: {e}")
        traceback.print_exc()
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
    with _releases_lock:
        releases = list(_previous_releases)
    return render_template_string(EXPORT_HTML, releases=releases)


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


# ============================================================
# Tab Folder Scanner — extension reports tab folder data here
# ============================================================

def _load_tab_folder_reports():
    try:
        with open(TAB_FOLDERS_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_tab_folder_reports(reports):
    with open(TAB_FOLDERS_FILE, "w") as f:
        json.dump(reports, f, indent=2)

@app.route("/api/report-tab-folders", methods=["POST", "OPTIONS"])
def report_tab_folders():
    if request.method == "OPTIONS":
        return "", 204
    data = request.get_json()
    if not data or "doc_id" not in data:
        return jsonify({"error": "doc_id required"}), 400
    doc_id = data["doc_id"]
    reports = _load_tab_folder_reports()
    ist = timezone(timedelta(hours=5, minutes=30))
    reports[doc_id] = {
        "doc_name":   data.get("doc_name", ""),
        "folders":    data.get("folders", {}),
        "root_tabs":  data.get("root_tabs", []),
        "scanned_at": datetime.now(ist).strftime("%H:%M IST"),
    }
    _save_tab_folder_reports(reports)
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"   Onshape Dashboard")
    print(f"   Open: http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, use_reloader=False)
