#!/usr/bin/env python3
"""
Onshape Dashboard
=================
Folder-only dashboard for Artila Robotics.
Shows project folders from local registry (folders.json).
Server-side rendered — no client-side API calls.

Local:   python dashboard.py  ->  http://localhost:5001
"""

import os
import json
import time
import random
import threading
import requests
from datetime import datetime
from urllib.parse import quote_plus
from flask import Flask, jsonify, render_template_string, request, redirect

# ============================================================
# CREDENTIALS & CONFIG
# ============================================================
ACCESS_KEY         = os.environ.get("ONSHAPE_ACCESS_KEY",    "on_sRiFqD1gRGXiwVGXyzANH")
SECRET_KEY         = os.environ.get("ONSHAPE_SECRET_KEY",    "9wc3KzifxPAcIkapb7tVqFjGio98kIcIHxcpMJQ7tYBoa5oz")
BASE_URL           = "https://cad.onshape.com"
COMPANY_ID         = os.environ.get("ONSHAPE_COMPANY_ID",    "6810c247e7c40668c32816a6")
REGISTRY_FILE      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "folders.json")
DEFAULT_SUBFOLDERS = ["Parts", "Assemblies", "Drawings"]
CACHE_TTL          = 300  # seconds (5 minutes)

# Watcher
SLACK_WEBHOOK_URL        = os.environ.get("SLACK_WEBHOOK_URL",     "https://hooks.slack.com/services/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")
WEBHOOK_SECRET           = os.environ.get("ONSHAPE_WEBHOOK_SECRET", "artila-webhook-secret")
DASHBOARD_URL            = os.environ.get("DASHBOARD_URL",          "http://localhost:5001")
WATCHER_POLL_INTERVAL    = 30   # seconds; increase in production
PROTECTION_DELAY_SECONDS = 30
VERSION_DELAY_SECONDS    = 10
BRANCH_DELAY_SECONDS     = 5
AUTO_BRANCH_NAME         = "Development"
# ============================================================

HEADERS = {
    "Accept": "application/json;charset=UTF-8;qs=0.09",
    "Content-Type": "application/json",
}
# Key pool — all pairs must be from the same Onshape account (same COMPANY_ID).
_KEY_POOL = [
    (ACCESS_KEY, SECRET_KEY),
    ("on_z1UhhHZH6oalYiXInyEYi", "bYSpbfhM6KJQbzBVDGLCCFwaQFQHStnuYwObGamtxHhPVYs5"),
    ("on_OEu3wzjc3lrvyh1wZl0V9", "R1AlU0ZraRWOOZoiJP41eYS6zlxlL6AwTrxvbaiB9gDcHIWR"),
    ("on_0iSvyZlEfnmBTMagWG1MT", "Yt5li8BzbUPNUaV3uLJbNA5tuBvlxQDcJsRxGYVHI3cIfxay"),
    ("on_AwY0N0aTHRZ3lH1BvIXq0",  "10eAjkwdf83tSgoRgbTkvrXyESTmcQi2K4TTJtqUcN3BuM3C"),
    ("on_SGYDfnKOfECj80oPyTIpf",  "jNPlQ4eUoS7WBkrrmY6EXf72oyoHXW79ns8gGbJDlpLDANU3"),
    ("on_LeDYm2hVFdCuc15ghJdbs",  "jkEU9iGpz8v7vdd0GnyyAoTHwBU9HFT0K0m3JpgEHKDCFCbV"),
]
def next_auth():
    return random.choice(_KEY_POOL)

app = Flask(__name__)

# 5-minute server-side data cache
_cache = {"data": None, "ts": 0}

# Watcher state
_watcher = {
    "known_ids":    None,   # None = first poll not yet done
    "last_poll_ts": 0,
    "error":        None,
}
doc_timers    = {}
watcher_lock  = threading.Lock()
_recent_docs  = []   # list of up to 5 dicts; populated by watcher, read by index()
_rdocs_lock   = threading.Lock()
_recent_releases = []
_releases_lock   = threading.Lock()


def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"   [{ts}] {msg}")


# ============================================================
# API HELPERS
# ============================================================

def onshape_get(path, params=None):
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
# PROTECTION WATCHER
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


def create_branch(doc_id, doc_name, workspace_id):
    """Creates the Development branch after the initial version is confirmed."""
    log(f"Creating branch '{AUTO_BRANCH_NAME}' for '{doc_name}'...")
    url = f"{BASE_URL}/api/v10/documents/d/{doc_id}/workspaces"
    body = {
        "name": AUTO_BRANCH_NAME,
        "description": "Auto-created working branch",
        "workspaceId": workspace_id,
    }
    try:
        r = requests.post(url, headers=HEADERS, json=body, auth=next_auth(), timeout=10)
        if r.status_code in (200, 201):
            branch_id = r.json().get("id", "?")
            log(f"Branch '{AUTO_BRANCH_NAME}' created. ID: {branch_id}")
            with _rdocs_lock:
                for d in _recent_docs:
                    if d["id"] == doc_id:
                        if AUTO_BRANCH_NAME not in d["workspaces"]:
                            d["workspaces"].append(AUTO_BRANCH_NAME)
                        break
            with watcher_lock:
                if doc_id in doc_timers:
                    doc_timers[doc_id]["branch_ok"] = True
        else:
            log(f"Branch creation failed ({r.status_code}): {r.text[:300]}")
            with watcher_lock:
                if doc_id in doc_timers:
                    doc_timers[doc_id]["branch_ok"] = False
    except Exception as e:
        log(f"Branch creation error: {e}")


def create_initial_version(doc_id, doc_name, workspace_id):
    """
    Called after VERSION_DELAY_SECONDS. Creates 'V0 - Initial' version.
    If version succeeds, schedules branch creation after BRANCH_DELAY_SECONDS.
    """
    if not workspace_id:
        log("No workspaceId cached — fetching from API...")
        try:
            r = requests.get(
                f"{BASE_URL}/api/v10/documents/{doc_id}",
                headers=HEADERS, auth=next_auth(), timeout=5
            )
            if r.status_code == 200:
                doc_data = r.json()
                workspace_id = doc_data.get("defaultWorkspace", {}).get("id", "")
                if not doc_name or len(doc_name) == 8:
                    doc_name = doc_data.get("name", doc_name)
                log(f"workspaceId fetched: '{workspace_id}'")
            else:
                log(f"Doc fetch failed ({r.status_code}) — cannot create version")
                return
        except Exception as e:
            log(f"Doc fetch exception: {e} — cannot create version")
            return

    if not workspace_id:
        log("workspaceId still empty — cannot create version")
        return

    version_name = f"V0 - Initial ({doc_name})"
    url = f"{BASE_URL}/api/v10/documents/d/{doc_id}/versions"
    body = {
        "name": version_name,
        "workspaceId": workspace_id,
        "documentId": doc_id,
        "description": "Auto-created on document creation",
    }

    log(f"Creating version '{version_name}'...")
    try:
        r = requests.post(url, headers=HEADERS, json=body, auth=next_auth(), timeout=10)
        if r.status_code in (200, 201):
            vid = r.json().get("id", "?")
            log(f"Version created. ID: {vid}")
            with _rdocs_lock:
                for d in _recent_docs:
                    if d["id"] == doc_id:
                        d["versions"]   = [version_name]
                        d["version_id"] = vid
                        break
            with watcher_lock:
                if doc_id in doc_timers:
                    doc_timers[doc_id]["version_name"] = version_name
                    doc_timers[doc_id]["version_ok"]   = True
            branch_timer = threading.Timer(
                BRANCH_DELAY_SECONDS, create_branch, args=[doc_id, doc_name, workspace_id]
            )
            branch_timer.daemon = True
            branch_timer.start()
        else:
            log(f"Version creation failed ({r.status_code}): {r.text[:300]}")
            with watcher_lock:
                if doc_id in doc_timers:
                    doc_timers[doc_id]["version_ok"] = False
    except Exception as e:
        log(f"Version creation error: {e}")


def protection_reminder(doc_id, doc_name):
    """Sends a single consolidated Slack message: version + branch outcomes + protection reminder."""
    with watcher_lock:
        entry = doc_timers.pop(doc_id, {})

    version_name = entry.get("version_name", "")
    version_ok   = entry.get("version_ok", False)
    branch_ok    = entry.get("branch_ok", False)

    log(f"Protection reminder + setup summary for '{doc_name}'")

    v_line = f"- Version *{version_name}* — created" if version_ok and version_name \
             else "- Version — failed (check terminal)"
    b_line = f"- Branch *{AUTO_BRANCH_NAME}* — created" if branch_ok \
             else "- Branch — failed (check terminal)"

    send_slack(
        "New Document Setup — Action Required",
        f"Document *{doc_name}* setup complete:\n{v_line}\n{b_line}\n\n"
        f"Please enable workspace protection and continue work in the development branch.",
        f"{BASE_URL}/documents/{doc_id}",
    )


def handle_new_doc(doc_id, doc_name, workspace_id, created_at="", created_by="—"):
    """Cancels any existing timers for this doc, then starts fresh ones."""
    # Store in recent docs list (watcher-driven, zero extra API calls)
    with _rdocs_lock:
        _recent_docs[:] = [d for d in _recent_docs if d["id"] != doc_id]
        _recent_docs.insert(0, {
            "id":           doc_id,
            "name":         doc_name,
            "url":          f"{BASE_URL}/documents/{doc_id}",
            "time_ago":     time_ago(created_at) if created_at else "just now",
            "created_by":   created_by,
            "workspaces":   ["Main"],
            "versions":     [],
            "workspace_id": workspace_id,
            "version_id":   "",
        })
        del _recent_docs[5:]

    with watcher_lock:
        if doc_id in doc_timers:
            for key in ("timer", "version_timer"):
                old = doc_timers[doc_id].get(key)
                if old:
                    old.cancel()

        log(f"New doc '{doc_name}' — version in {VERSION_DELAY_SECONDS}s, protection reminder in {PROTECTION_DELAY_SECONDS}s")

        version_timer = threading.Timer(
            VERSION_DELAY_SECONDS, create_initial_version, args=[doc_id, doc_name, workspace_id]
        )
        version_timer.daemon = True
        version_timer.start()

        protection_timer = threading.Timer(
            PROTECTION_DELAY_SECONDS, protection_reminder, args=[doc_id, doc_name]
        )
        protection_timer.daemon = True
        protection_timer.start()

        doc_timers[doc_id] = {
            "last_edit":    time.time(),
            "timer":        protection_timer,
            "version_timer": version_timer,
            "name":         doc_name,
            "workspace_id": workspace_id,
        }


def poll_once():
    """Fetches document list and triggers protection workflow for any new docs."""
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
    current_ids = {d["id"] for d in data.get("items", []) if d.get("id")}

    with watcher_lock:
        if _watcher["known_ids"] is None:
            _watcher["known_ids"]    = current_ids
            _watcher["last_poll_ts"] = time.time()
            _watcher["error"]        = None
            log(f"Watcher baseline: {len(current_ids)} docs known")
            return

        new_ids = current_ids - _watcher["known_ids"]
        _watcher["known_ids"]    = current_ids
        _watcher["last_poll_ts"] = time.time()
        _watcher["error"]        = None

    for doc_id in new_ids:
        try:
            doc_data     = onshape_get(f"/api/v10/documents/{doc_id}")
            doc_name     = doc_data.get("name", doc_id[:8])
            workspace_id = doc_data.get("defaultWorkspace", {}).get("id", "")
            created_at   = doc_data.get("createdAt", "")
            created_by   = doc_data.get("createdBy", {}).get("name", "—")
            handle_new_doc(doc_id, doc_name, workspace_id, created_at, created_by)
        except Exception as e:
            log(f"Error fetching new doc {doc_id}: {e}")


def watcher_loop():
    while True:
        try:
            poll_once()
        except Exception as e:
            with watcher_lock:
                _watcher["error"] = str(e)
            log(f"Watcher poll error: {e}")
        time.sleep(WATCHER_POLL_INTERVAL)


def get_watcher_status():
    with watcher_lock:
        known_ids = _watcher["known_ids"]
        last_ts   = _watcher["last_poll_ts"]
        error     = _watcher["error"]

    active    = error is None
    doc_count = len(known_ids) if known_ids is not None else 0

    if last_ts == 0:
        last_poll_ago = "not yet polled"
    else:
        secs = int(time.time() - last_ts)
        last_poll_ago = f"{secs}s ago" if secs < 60 else f"{secs // 60}m ago"

    return {"active": active, "last_poll_ago": last_poll_ago, "doc_count": doc_count, "error": error}


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


def seed_recent_releases():
    try:
        data = onshape_get("/api/v10/releasepackages",
                           params={"companyId": COMPANY_ID, "limit": 5,
                                   "sortColumn": "createdAt", "sortOrder": "desc"})
        items = data.get("items", data if isinstance(data, list) else [])
        with _releases_lock:
            for item in items:
                _recent_releases.append({
                    "id":       item.get("id", ""),
                    "name":     item.get("name", "Release"),
                    "state":    item.get("requestState", "UNKNOWN"),
                    "by":       item.get("requestedBy", {}).get("name", "—"),
                    "time_ago": time_ago(item.get("createdAt", "")),
                })
        log(f"Release seed: {len(_recent_releases)} releases loaded")
    except Exception as e:
        log(f"Release seed error: {e}")


def register_release_webhook():
    url = DASHBOARD_URL.rstrip("/") + "/webhook"
    body = {
        "url":     url,
        "filter":  "onshape.revision.lifecycle.changed",
        "options": {"collapseEvents": False},
    }
    try:
        r = onshape_post("/api/v10/webhooks", body)
        log(f"Release webhook registered: id={r.get('id', '?')} -> {url}")
    except Exception as e:
        log(f"Release webhook registration failed: {e} — releases will not be live-updated")


_watcher_started = False

@app.before_request
def ensure_watcher():
    global _watcher_started
    if not _watcher_started:
        _watcher_started = True
        threading.Thread(target=watcher_loop, daemon=True, name="watcher").start()
        threading.Thread(target=seed_recent_releases, daemon=True).start()
        threading.Thread(target=register_release_webhook, daemon=True).start()


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

<!-- NEW PROJECT MODAL -->
<div id="modal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
  <div class="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-sm shadow-2xl">
    <h2 class="text-sm font-semibold mb-5">Create Project Folder</h2>
    <form method="POST" action="/create-project">
      <label class="block text-xs text-gray-400 mb-1">Project name</label>
      <input name="project_name" required
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm mb-4
               focus:outline-none focus:border-indigo-500 transition-colors"
        placeholder="e.g. MECH01">
      <label class="block text-xs text-gray-400 mb-1">
        Sub-folders <span class="text-gray-600">(comma-separated)</span>
      </label>
      <input name="subfolders" value="{{ default_subfolders }}"
        class="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm mb-5
               focus:outline-none focus:border-indigo-500 transition-colors">
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
      <span class="text-gray-400 text-sm hidden sm:block">Project Folders</span>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="openModal()"
        class="px-3 py-1.5 bg-indigo-700 hover:bg-indigo-600 border border-indigo-600 rounded text-xs font-medium transition-colors">
        New Project
      </button>
      <a href="/" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium transition-colors">
        Refresh
      </a>
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

  <div class="grid grid-cols-3 gap-3 mb-8">
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">Project Folders</p>
      <p class="text-2xl font-bold text-white">{{ folders | length }}</p>
    </div>
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">Watcher</p>
      <p class="text-2xl font-bold {% if watcher_status.active %}text-green-400{% else %}text-red-400{% endif %}">{% if watcher_status.active %}Active{% else %}Error{% endif %}</p>
      <p class="text-xs text-gray-600 mt-1">{{ watcher_status.last_poll_ago }} &middot; {{ watcher_status.doc_count }} docs</p>
    </div>
    <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <p class="text-xs text-gray-500 mb-1">Updated</p>
      <p class="text-2xl font-bold text-white">{{ now }}</p>
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
    {% else %}No project folders registered yet. Click "New Project" to create one, or use option [3] in onshape-tools.py to register an existing folder.{% endif %}
  </p>
  {% endif %}

  {% if recent_docs %}
  <div class="mt-10">
    <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">Recent Documents</h2>
    <div class="flex flex-col gap-3">
      {% for doc in recent_docs %}
      <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col sm:flex-row sm:items-start gap-3">
        <div class="flex-1 min-w-0">
          <a href="{{ doc.url }}" target="_blank" rel="noopener"
             class="font-semibold text-sm text-white hover:text-indigo-400 transition-colors">{{ doc.name }}</a>
          <p class="text-xs text-gray-500 mt-0.5">{{ doc.time_ago }} &middot; {{ doc.created_by }}</p>
          {% if doc.workspaces %}
          <div class="flex flex-wrap gap-1.5 mt-2">
            {% for ws in doc.workspaces %}
            <span class="px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-300 border border-gray-700">{{ ws }}</span>
            {% endfor %}
          </div>
          {% endif %}
          {% if doc.versions %}
          <div class="flex flex-wrap gap-1.5 mt-1.5">
            {% for v in doc.versions %}
            <span class="px-2 py-0.5 rounded text-xs bg-indigo-950 text-indigo-300 border border-indigo-800">{{ v }}</span>
            {% endfor %}
          </div>
          {% endif %}
        </div>
        <div class="flex-shrink-0 flex flex-col items-end gap-2">
          <span class="px-2 py-1 rounded text-xs bg-yellow-950 text-yellow-400 border border-yellow-800">Workspace protection reminder sent</span>
          {% if doc.workspace_id %}
          <form method="POST" action="/create-drawing/{{ doc.id }}" onsubmit="this.querySelector('button').disabled=true">
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
  </div>
  {% endif %}

  {% if recent_releases %}
  <div class="mt-10">
    <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-4">Recent Releases</h2>
    <div class="flex flex-col gap-3">
      {% for rel in recent_releases %}
      <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-between gap-3">
        <div>
          <p class="font-semibold text-sm text-white">{{ rel.name }}</p>
          <p class="text-xs text-gray-500 mt-0.5">{{ rel.time_ago }} &middot; {{ rel.by }}</p>
        </div>
        <span class="px-2 py-1 rounded text-xs border
          {% if rel.state == 'RELEASED' %}bg-green-950 text-green-400 border-green-800
          {% elif rel.state == 'PENDING' %}bg-yellow-950 text-yellow-400 border-yellow-800
          {% else %}bg-gray-800 text-gray-400 border-gray-700{% endif %}">
          {{ rel.state }}
        </span>
      </div>
      {% endfor %}
    </div>
  </div>
  {% endif %}

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

    with _rdocs_lock:
        recent_docs = list(_recent_docs)

    with _releases_lock:
        recent_releases = list(_recent_releases)

    return render_template_string(
        HTML,
        folders=folder_list,
        recent_docs=recent_docs,
        recent_releases=recent_releases,
        error=error,
        now=datetime.now().strftime("%H:%M"),
        flash_msg=request.args.get("msg", ""),
        flash_err=request.args.get("err", ""),
        default_subfolders=",".join(DEFAULT_SUBFOLDERS),
        watcher_status=get_watcher_status(),
    )


@app.route("/create-project", methods=["POST"])
def create_project():
    global _cache

    project_name   = request.form.get("project_name", "").strip()
    subfolders_raw = request.form.get("subfolders", "").strip()

    if not project_name:
        return redirect("/?err=" + quote_plus("Project name is required"))

    subfolder_names = [s.strip() for s in subfolders_raw.split(",") if s.strip()]
    if not subfolder_names:
        subfolder_names = DEFAULT_SUBFOLDERS[:]

    try:
        root_result = onshape_post("/api/folders", {
            "name":      project_name,
            "ownerId":   COMPANY_ID,
            "ownerType": 1,
        })
        root_id = root_result.get("id")
        if not root_id:
            return redirect("/?err=" + quote_plus("Root folder created but no ID returned"))

        sub_folders = []
        for sf_name in subfolder_names:
            time.sleep(0.5)
            sf_result = onshape_post("/api/folders", {
                "name":      sf_name,
                "ownerId":   COMPANY_ID,
                "ownerType": 1,
                "parentId":  root_id,
            })
            sf_id = sf_result.get("id", "")
            sub_folders.append({"id": sf_id, "name": sf_name})

        reg = load_registry()
        reg["folders"].append({
            "id":          root_id,
            "name":        project_name,
            "sub_folders": sub_folders,
        })
        save_registry(reg)
        _cache["ts"] = 0  # invalidate cache so next load fetches fresh data

        return redirect("/?msg=" + quote_plus(f"Project '{project_name}' created successfully"))

    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        return redirect("/?err=" + quote_plus(f"API Error {status}"))
    except Exception as e:
        return redirect("/?err=" + quote_plus(str(e)[:200]))


@app.route("/api/watcher-status")
def api_watcher_status():
    with watcher_lock:
        known_ids = _watcher["known_ids"]
        last_ts   = _watcher["last_poll_ts"]
        error     = _watcher["error"]
    return jsonify({
        "doc_count":    len(known_ids) if known_ids is not None else None,
        "last_poll_ts": last_ts,
        "error":        error,
        "active_timers": list(doc_timers.keys()),
    })


@app.route("/webhook", methods=["POST"])
def webhook():
    data = request.get_json(silent=True) or {}
    event = data.get("event", "")
    if "revision" in event or "release" in event:
        payload = data.get("payload", {})
        rel_id   = payload.get("releasePackageId", data.get("id", ""))
        rel_name = payload.get("name", "Release")
        state    = payload.get("requestState", "UNKNOWN")
        by       = payload.get("requestedBy", {}).get("name", "—")
        with _releases_lock:
            _recent_releases[:] = [r for r in _recent_releases if r["id"] != rel_id]
            _recent_releases.insert(0, {
                "id": rel_id, "name": rel_name,
                "state": state, "by": by, "time_ago": "just now",
            })
            del _recent_releases[5:]
        log(f"Release webhook received: '{rel_name}' -> {state}")
    return ("", 200)


@app.route("/create-drawing/<doc_id>", methods=["POST"])
def create_drawing(doc_id):
    with _rdocs_lock:
        doc_entry = next((d for d in _recent_docs if d["id"] == doc_id), None)

    if not doc_entry:
        return redirect("/?err=" + quote_plus("Document not found in recent list"))

    workspace_id = doc_entry.get("workspace_id", "")

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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"   Onshape Dashboard + Protection Watcher")
    print(f"   Open: http://localhost:{port}")
    t = threading.Thread(target=watcher_loop, daemon=True, name="watcher")
    t.start()
    app.run(host="0.0.0.0", port=port, use_reloader=False)
