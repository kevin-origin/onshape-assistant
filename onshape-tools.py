#!/usr/bin/env python3
"""
Onshape Tools - Combined v1
===========================
Menu-driven tool combining:
  1. Project Creator     — creates folder structures in Onshape Documents
  2. Protection Watcher  — watches for new docs, auto-creates versions/branches, sends Slack alerts

Usage:
  python onshape-tools.py

For the watcher, ngrok must be running first:
  ngrok http --url=https://nonsynodic-supplicatingly-bradly.ngrok-free.dev 5000
"""

import os
import requests
import json
import threading
import time
import sys
import logging
from datetime import datetime
from urllib.parse import urlparse, parse_qs

try:
    from flask import Flask, request as flask_request, jsonify
except ImportError:
    print("\n   Flask not installed. Run: python -m pip install flask")
    sys.exit(1)

# ============================================================
# CREDENTIALS & CONFIG
# ============================================================
ACCESS_KEY        = "on_sRiFqD1gRGXiwVGXyzANH"
SECRET_KEY        = "9wc3KzifxPAcIkapb7tVqFjGio98kIcIHxcpMJQ7tYBoa5oz"
BASE_URL          = "https://cad.onshape.com"
COMPANY_ID        = "6810c247e7c40668c32816a6"
REGISTRY_FILE     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "folders.json")
NGROK_DOMAIN      = "nonsynodic-supplicatingly-bradly.ngrok-free.dev"
SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/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"

# Project Creator
DEFAULT_SUBFOLDERS = ["Parts", "Assemblies", "Drawings"]
DEBUG = False  # Set True for full API request/response logging

# Protection Watcher
PROTECTION_DELAY_SECONDS = 30
VERSION_DELAY_SECONDS    = 10
BRANCH_DELAY_SECONDS     = 5    # fires after version is confirmed, not from t=0
AUTO_BRANCH_NAME         = "Development"
LOCAL_PORT               = 5000
# ============================================================

HEADERS = {
    "Accept": "application/json;charset=UTF-8;qs=0.09",
    "Content-Type": "application/json",
}
AUTH = (ACCESS_KEY, SECRET_KEY)

# Watcher state
doc_timers = {}
lock = threading.Lock()
registered_webhook_ids = []
watcher_running = False

# Suppress Flask/werkzeug HTTP access logs
logging.getLogger("werkzeug").setLevel(logging.ERROR)

app = Flask(__name__)
app.logger.disabled = True


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
# SHARED UTILITIES
# ============================================================

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"   [{ts}] {msg}")


def debug_log(label, data):
    if DEBUG:
        print(f"\n   [DEBUG] {label}:")
        if isinstance(data, (dict, list)):
            print(f"   {json.dumps(data, indent=2)}")
        else:
            print(f"   {data}")


def api_request(method, url, body=None):
    """Makes an API call with optional debug logging. Returns JSON dict."""
    debug_log(f"{method} {url}", body or "")

    if method == "GET":
        response = requests.get(url, headers=HEADERS, auth=AUTH)
    elif method == "POST":
        response = requests.post(url, headers=HEADERS, json=body, auth=AUTH)
    else:
        raise ValueError(f"Unknown method: {method}")

    debug_log(f"Response {response.status_code}", response.text[:500] if DEBUG else "")

    if response.status_code >= 400:
        response.raise_for_status()

    try:
        return response.json()
    except json.JSONDecodeError:
        return {"raw": response.text}


# ============================================================
# PROJECT CREATOR
# ============================================================

def get_owner_info():
    """
    Gets company ID and owner type for folder creation.
    Returns (owner_id, owner_type, display_name)
    ownerType 0 = personal, 1 = company
    """
    print("\n   Calling: GET /api/v10/users/sessioninfo")
    user = api_request("GET", f"{BASE_URL}/api/v10/users/sessioninfo")
    user_name = user.get("name", "Unknown")
    print(f"   Logged in as: {user_name}")

    print("\n   Calling: GET /api/v10/companies")
    companies_resp = api_request("GET", f"{BASE_URL}/api/v10/companies")
    items = companies_resp.get("items", [])

    if items:
        company = items[0]
        company_id = company.get("id", "")
        company_name = company.get("name", "Unknown Company")
        print(f"   Company: {company_name} (ID: {company_id})")
        print(f"   Folders will be created under: {company_name}")
        return company_id, 1, company_name
    else:
        user_id = user.get("id", "")
        print("   No company found — folders will go under personal account")
        return user_id, 0, user_name


def create_folder(name, owner_id, owner_type, parent_id=None):
    """Creates a folder via undocumented POST /api/folders endpoint."""
    body = {"name": name, "ownerId": owner_id, "ownerType": owner_type}
    if parent_id:
        body["parentId"] = parent_id

    result = api_request("POST", f"{BASE_URL}/api/folders", body=body)
    folder_id = result.get("id", "???")
    if parent_id:
        print(f"   Subfolder '{name}' created (ID: {folder_id})")
    else:
        print(f"   Root folder '{name}' created (ID: {folder_id})")
    return result


def run_project_creator():
    """Interactive loop for creating project folder structures."""
    print()
    print("=" * 60)
    print("   ONSHAPE PROJECT CREATOR")
    print("=" * 60)
    print("   Creates folder structures on your Onshape Documents page")
    print(f"   Default subfolders: {', '.join(DEFAULT_SUBFOLDERS)}")
    print("=" * 60)

    try:
        owner_id, owner_type, owner_name = get_owner_info()
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        print(f"\n   API Error (HTTP {status})")
        if status == 401:
            print("   Authentication failed — check API keys")
        elif status == 403:
            print("   Access denied — check API key permissions (needs read + write)")
        else:
            if e.response is not None:
                print(f"   Response: {e.response.text[:300]}")
        return
    except requests.exceptions.ConnectionError:
        print(f"\n   Cannot connect to {BASE_URL} — check internet connection")
        return

    while True:
        print("\n" + "-" * 60)
        project_name = input("   Project name (or 'q' to go back to menu): ").strip()
        if project_name.lower() in ("q", "quit", "exit", ""):
            break

        print(f"\n   Default subfolders: {', '.join(DEFAULT_SUBFOLDERS)}")
        custom = input("   Press Enter for defaults, or type folder names (comma-separated): ").strip()
        subfolders = [s.strip() for s in custom.split(",") if s.strip()] if custom else DEFAULT_SUBFOLDERS[:]

        print(f"\n   Will create:")
        print(f"   {project_name}/")
        for sf in subfolders:
            print(f"     {sf}/")

        confirm = input("\n   Proceed? (y/n): ").strip().lower()
        if confirm not in ("y", "yes"):
            print("   Skipped.")
            continue

        try:
            root = create_folder(project_name, owner_id, owner_type)
            root_id = root.get("id")
            if not root_id:
                print("   ERROR: Root folder created but no ID returned")
                print(f"   Full response: {json.dumps(root, indent=2)}")
                continue

            time.sleep(0.5)
            sub_folders_data = []
            for sf_name in subfolders:
                sf_result = create_folder(sf_name, owner_id, owner_type, root_id)
                sf_id = sf_result.get("id", "")
                sub_folders_data.append({"id": sf_id, "name": sf_name})
                time.sleep(0.5)

            # Write to local registry so the dashboard can find this folder
            reg = load_registry()
            reg["folders"].append({
                "id":          root_id,
                "name":        project_name,
                "sub_folders": sub_folders_data,
            })
            save_registry(reg)
            print(f"   Registry updated: {REGISTRY_FILE}")

            print(f"\n   Project '{project_name}' created successfully!")
            print(f"   Go to {BASE_URL} -> Documents -> refresh (F5) to see it")

        except requests.exceptions.HTTPError as e:
            status = e.response.status_code if e.response is not None else "?"
            print(f"\n   API Error (HTTP {status})")
            if e.response is not None:
                try:
                    print(f"   {json.dumps(e.response.json(), indent=2)}")
                except Exception:
                    print(f"   {e.response.text[:300]}")
            if status == 400:
                print(f"   Tip: ownerId={owner_id}, ownerType={owner_type} — may be wrong for your plan")
            elif status == 429:
                print("   Rate limited — wait a minute and try again")
        except Exception as e:
            print(f"\n   Unexpected error: {type(e).__name__}: {e}")


def run_register_folder():
    """
    Prompt the user to register an existing Onshape folder in folders.json.
    Useful for folders created before the registry system existed.
    """
    print()
    print("=" * 60)
    print("   REGISTER EXISTING FOLDER")
    print("=" * 60)
    print("   Paste the Onshape folder URL.")
    print("   Example: https://cad.onshape.com/documents?nodeId=abc123&resourceType=resourceFolder")
    print("=" * 60)

    url_str = input("\n   Folder URL (or 'q' to go back): ").strip()
    if url_str.lower() in ("q", "quit", "exit", ""):
        return

    parsed = urlparse(url_str)
    qs = parse_qs(parsed.query)
    folder_id = qs.get("nodeId", [None])[0]

    if not folder_id:
        print("   Could not extract nodeId from URL — check the URL format.")
        return

    print(f"\n   Fetching info for folder ID: {folder_id}...")
    try:
        r = api_request("GET", f"{BASE_URL}/api/v10/folders/{folder_id}")
        folder_name = r.get("name", folder_id[:8])
        print(f"   Folder: {folder_name}")
    except Exception as e:
        print(f"   Error fetching folder: {e}")
        return

    print("\n   Paste each sub-folder URL, one per line. Blank line when done:")
    sub_folders = []
    while True:
        sf_url = input("   Sub-folder URL: ").strip()
        if not sf_url:
            break
        parsed_sf = urlparse(sf_url)
        qs_sf = parse_qs(parsed_sf.query)
        sf_id = qs_sf.get("nodeId", [None])[0]
        if not sf_id:
            print("   Could not extract nodeId — skipped.")
            continue
        try:
            sf_r = api_request("GET", f"{BASE_URL}/api/v10/folders/{sf_id}")
            sf_name = sf_r.get("name", sf_id[:8])
            sub_folders.append({"id": sf_id, "name": sf_name})
            print(f"   Added: {sf_name} (ID: {sf_id})")
        except Exception as e:
            print(f"   Error fetching sub-folder {sf_id}: {e}")

    print(f"\n   Will register:")
    print(f"   Root: {folder_name} (ID: {folder_id})")
    for sf in sub_folders:
        print(f"     Sub: {sf['name']} (ID: {sf['id']})")

    confirm = input("\n   Save to registry? (y/n): ").strip().lower()
    if confirm not in ("y", "yes"):
        print("   Cancelled.")
        return

    reg = load_registry()
    # Replace if already exists (allows updating sub-folder list)
    existing_ids = [e["id"] for e in reg.get("folders", [])]
    if folder_id in existing_ids:
        print(f"   Folder already in registry — updating entry.")
        reg["folders"] = [e for e in reg["folders"] if e["id"] != folder_id]
    reg["folders"].append({
        "id":          folder_id,
        "name":        folder_name,
        "sub_folders": sub_folders,
    })
    save_registry(reg)
    print(f"   Saved to {REGISTRY_FILE}")


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
        r = requests.post(url, headers=HEADERS, json=body, auth=AUTH, timeout=10)
        if r.status_code in (200, 201):
            branch_id = r.json().get("id", "?")
            log(f"Branch '{AUTO_BRANCH_NAME}' created. ID: {branch_id}")
            send_slack(
                "Branch Created",
                f"Branch *{AUTO_BRANCH_NAME}* created for *{doc_name}*.",
                f"{BASE_URL}/documents/{doc_id}",
            )
        else:
            log(f"Branch creation failed ({r.status_code}): {r.text[:300]}")
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
                headers=HEADERS, auth=AUTH, timeout=5
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
        r = requests.post(url, headers=HEADERS, json=body, auth=AUTH, timeout=10)
        if r.status_code in (200, 201):
            vid = r.json().get("id", "?")
            log(f"Version created. ID: {vid}")
            send_slack(
                "Version Created",
                f"*{version_name}* has been created automatically.",
                f"{BASE_URL}/documents/{doc_id}",
            )
            branch_timer = threading.Timer(
                BRANCH_DELAY_SECONDS, create_branch, args=[doc_id, doc_name, workspace_id]
            )
            branch_timer.daemon = True
            branch_timer.start()
        else:
            log(f"Version creation failed ({r.status_code}): {r.text[:300]}")
    except Exception as e:
        log(f"Version creation error: {e}")


def protection_reminder(doc_id, doc_name):
    """Sends Slack notification to enable workspace protection."""
    with lock:
        if doc_id in doc_timers:
            del doc_timers[doc_id]

    log(f"Protection reminder for '{doc_name}'")
    send_slack(
        "Enable Workspace Protection",
        f"Document *{doc_name}* was created {PROTECTION_DELAY_SECONDS}s ago.\n"
        f"Go enable workspace protection on Main now.",
        f"{BASE_URL}/documents/{doc_id}",
    )


def handle_new_doc(doc_id, doc_name, workspace_id):
    """Cancels any existing timers for this doc, then starts fresh ones."""
    with lock:
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
            "last_edit": time.time(),
            "timer": protection_timer,
            "version_timer": version_timer,
            "name": doc_name,
            "workspace_id": workspace_id,
        }


@app.route("/webhook", methods=["POST"])
def webhook_receiver():
    """Receives POST from Onshape when events fire."""
    data = flask_request.get_json(silent=True)
    if not data:
        return jsonify({"status": "no data"}), 200

    event = data.get("event", "unknown")
    doc_id = data.get("documentId", "")
    workspace_id = data.get("workspaceId", "")

    log(f"Webhook: event={event}, doc={doc_id}")

    if event == "onshape.document.lifecycle.created":
        doc_name = ""
        if doc_id:
            try:
                r = requests.get(
                    f"{BASE_URL}/api/v10/documents/{doc_id}",
                    headers=HEADERS, auth=AUTH, timeout=5
                )
                log(f"Doc info fetch: {r.status_code}")
                if r.status_code == 200:
                    doc_data = r.json()
                    doc_name = doc_data.get("name", doc_id[:8])
                    if not workspace_id:
                        workspace_id = doc_data.get("defaultWorkspace", {}).get("id", "")
                        log(f"workspaceId from doc info: '{workspace_id}'")
                else:
                    log(f"Doc info fetch failed: {r.text[:200]}")
                    doc_name = doc_id[:8]
            except Exception as e:
                log(f"Doc info fetch exception: {e}")
                doc_name = doc_id[:8]
        handle_new_doc(doc_id, doc_name, workspace_id)

    elif event in ("webhook.ping", "webhook.register"):
        log(f"Onshape: {event}")

    return jsonify({"status": "ok"}), 200


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "running", "watched": len(doc_timers)}), 200


def register_webhook():
    """Registers one company-wide webhook for new document creation."""
    webhook_url = f"https://{NGROK_DOMAIN}/webhook"
    body = {
        "companyId": COMPANY_ID,
        "events": ["onshape.document.lifecycle.created"],
        "options": {"collapseEvents": False},
        "url": webhook_url,
        "isTransient": False,
    }
    log(f"Registering webhook: {webhook_url}")
    try:
        r = requests.post(f"{BASE_URL}/api/v10/webhooks", headers=HEADERS, json=body, auth=AUTH)
        if r.status_code in (200, 201):
            wh_id = r.json().get("id", "")
            registered_webhook_ids.append(wh_id)
            log(f"Webhook registered. ID: {wh_id}")
            return True
        else:
            log(f"Webhook registration failed ({r.status_code}): {r.text[:300]}")
            return False
    except Exception as e:
        log(f"Webhook registration error: {e}")
        return False


def unregister_webhooks():
    """Deletes all registered webhooks. Called on exit."""
    for wh_id in registered_webhook_ids:
        try:
            requests.delete(
                f"{BASE_URL}/api/v10/webhooks/{wh_id}",
                headers=HEADERS, auth=AUTH
            )
            log(f"Deleted webhook {wh_id}")
        except Exception:
            pass


def start_watcher():
    """Starts Flask in a background daemon thread and registers the webhook."""
    global watcher_running

    if watcher_running:
        print("\n   Watcher is already running.")
        return True

    print()
    print("=" * 60)
    print("   ONSHAPE PROTECTION WATCHER v3")
    print("=" * 60)
    print(f"   Version delay:    {VERSION_DELAY_SECONDS}s after doc creation")
    print(f"   Branch delay:     {VERSION_DELAY_SECONDS + BRANCH_DELAY_SECONDS}s after doc creation")
    print(f"   Protection delay: {PROTECTION_DELAY_SECONDS}s after doc creation")
    print(f"   Auto branch name: {AUTO_BRANCH_NAME}")
    print(f"   Webhook URL:      https://{NGROK_DOMAIN}/webhook")
    print("=" * 60)
    print()

    log("Testing Slack...")
    send_slack(
        "Onshape Watcher Started",
        "Protection watcher is now running. You will be notified when new documents are created.",
    )

    if not register_webhook():
        print(f"\n   Webhook registration failed. Is ngrok running?")
        print(f"   Run: ngrok http --url=https://{NGROK_DOMAIN} {LOCAL_PORT}")
        return False

    flask_thread = threading.Thread(
        target=lambda: app.run(host="0.0.0.0", port=LOCAL_PORT, use_reloader=False),
        daemon=True,
        name="flask-watcher",
    )
    flask_thread.start()
    watcher_running = True
    log(f"Listening on port {LOCAL_PORT}")
    return True


# ============================================================
# MAIN MENU
# ============================================================

def print_menu():
    print()
    print("=" * 60)
    print("   ONSHAPE TOOLS")
    print("=" * 60)
    print("   [1] Create Project Folders")
    print("   [2] Start Protection Watcher")
    print("   [3] Register Existing Folder")
    print("   [4] Exit")
    if watcher_running:
        print(f"\n   Watcher is active on port {LOCAL_PORT}")
    print("=" * 60)


def main():
    import atexit, signal

    atexit.register(unregister_webhooks)
    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

    while True:
        print_menu()
        choice = input("   Choice: ").strip()

        if choice == "1":
            run_project_creator()

        elif choice == "2":
            started = start_watcher()
            if started:
                print()
                input("   Watcher running. Press Enter to return to menu...")

        elif choice == "3":
            run_register_folder()

        elif choice in ("4", "q", "quit", "exit", ""):
            print("\n   Shutting down...")
            unregister_webhooks()
            sys.exit(0)

        else:
            print("   Invalid choice — enter 1, 2, 3, or 4.")


if __name__ == "__main__":
    main()
