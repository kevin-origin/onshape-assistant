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
import requests
from datetime import datetime
from urllib.parse import quote_plus
from flask import Flask, jsonify, render_template_string, request, redirect

# ============================================================
# CREDENTIALS & CONFIG
# ============================================================
ACCESS_KEY         = "on_sRiFqD1gRGXiwVGXyzANH"
SECRET_KEY         = "9wc3KzifxPAcIkapb7tVqFjGio98kIcIHxcpMJQ7tYBoa5oz"
BASE_URL           = "https://cad.onshape.com"
COMPANY_ID         = "6810c247e7c40668c32816a6"
REGISTRY_FILE      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "folders.json")
DEFAULT_SUBFOLDERS = ["Parts", "Assemblies", "Drawings"]
CACHE_TTL          = 300  # seconds (5 minutes)
# ============================================================

HEADERS = {
    "Accept": "application/json;charset=UTF-8;qs=0.09",
    "Content-Type": "application/json",
}
AUTH = (ACCESS_KEY, SECRET_KEY)

app = Flask(__name__)

# 5-minute server-side data cache
_cache = {"data": None, "ts": 0}


# ============================================================
# API HELPERS
# ============================================================

def onshape_get(path, params=None):
    r = requests.get(
        f"{BASE_URL}{path}",
        headers=HEADERS,
        auth=AUTH,
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
        auth=AUTH,
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


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
      <p class="text-xs text-gray-500 mb-1">Showing</p>
      <p id="s-showing" class="text-2xl font-bold text-white">{{ folders | length }}</p>
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
  var shown = 0;
  cards.forEach(function(c) {
    var match = c.dataset.name.includes(q);
    c.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  document.getElementById('s-showing').textContent = shown;
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

    return render_template_string(
        HTML,
        folders=folder_list,
        error=error,
        now=datetime.now().strftime("%H:%M"),
        flash_msg=request.args.get("msg", ""),
        flash_err=request.args.get("err", ""),
        default_subfolders=",".join(DEFAULT_SUBFOLDERS),
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"   Onshape Dashboard")
    print(f"   Open: http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=False)
