"""
publish.py — Automates Onshape Assistant extension release workflow.
Bumps version, packs .crx, updates updates.xml, commits, pushes, creates GitHub Release.

Run: python publish.py
Requires: gh CLI authenticated (gh auth login)
"""

import json
import os
import re
import shutil
import subprocess
import sys

# --- Config ---
EXTENSION_DIR = "extension"
MANIFEST_PATH = os.path.join(EXTENSION_DIR, "manifest.json")
PEM_PATH = "extension.pem"
UPDATES_XML_PATH = "updates.xml"
CRX_OUTPUT_NAME = "onshape-assistant.crx"
CHROME_PATH = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
GITHUB_REPO = "kevin-origin/onshape-assistant"
GH_PATH = "/usr/bin/gh"
TEMP_EXTENSION_DIR = "extension_build_tmp"  # temp dir for production CRX packing (never modifies real extension/)

MOZILLA_API_KEY = "user:19882957:792"
MOZILLA_API_SECRET = "9ac2cdd62e89377e62454793c66cf5ac74a052c3cceda150ff405903efbec5ef"
UPDATES_FIREFOX_PATH = "updates-firefox.json"
XPI_OUTPUT_NAME = "onshape-assistant-firefox.xpi"


def read_manifest():
    with open(MANIFEST_PATH, "r") as f:
        return json.load(f)


def write_manifest(data):
    with open(MANIFEST_PATH, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def bump_version(current):
    """Suggest patch bump: 1.2 -> 1.3, 1.2.1 -> 1.2.2"""
    parts = current.split(".")
    parts[-1] = str(int(parts[-1]) + 1)
    return ".".join(parts)


def update_updates_xml(version):
    codebase = f"https://github.com/{GITHUB_REPO}/releases/download/v{version}/{CRX_OUTPUT_NAME}"
    xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="feihkbfmkphhihnblcjkblekfihpjbld">
    <updatecheck codebase="{codebase}" version="{version}" />
  </app>
</gupdate>
'''
    with open(UPDATES_XML_PATH, "w") as f:
        f.write(xml)


def to_win_path(linux_path):
    """Convert a WSL/Linux path to a Windows path using wslpath."""
    result = subprocess.run(["wslpath", "-w", linux_path], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else linux_path


def pack_crx(ext_dir=EXTENSION_DIR):
    """Pack extension from ext_dir using Chrome CLI. Returns path to .crx file."""
    ext_abs = os.path.abspath(ext_dir)
    pem_abs = os.path.abspath(PEM_PATH)

    if not os.path.isfile(CHROME_PATH):
        print(f"ERROR: Chrome not found at {CHROME_PATH}")
        print("Update CHROME_PATH in publish.py if Chrome is installed elsewhere.")
        sys.exit(1)

    if not os.path.isfile(pem_abs):
        print(f"ERROR: Private key not found at {pem_abs}")
        print("extension.pem is required to sign the .crx with the correct extension ID.")
        sys.exit(1)

    # Chrome is a Windows executable — convert WSL paths to Windows paths
    ext_win = to_win_path(ext_abs)
    pem_win = to_win_path(pem_abs)

    cmd = [
        CHROME_PATH,
        f"--pack-extension={ext_win}",
        f"--pack-extension-key={pem_win}",
        "--no-message-box",
    ]
    print(f"Packing .crx ...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    # Chrome outputs extension.crx next to the extension/ dir
    raw_crx = ext_abs + ".crx"
    if not os.path.isfile(raw_crx):
        print("ERROR: Chrome did not produce a .crx file.")
        print(f"stdout: {result.stdout}")
        print(f"stderr: {result.stderr}")
        sys.exit(1)

    # Rename to onshape-assistant.crx
    if os.path.isfile(CRX_OUTPUT_NAME):
        os.remove(CRX_OUTPUT_NAME)
    shutil.move(raw_crx, CRX_OUTPUT_NAME)
    print(f"Packed: {CRX_OUTPUT_NAME} ({os.path.getsize(CRX_OUTPUT_NAME):,} bytes)")
    return CRX_OUTPUT_NAME


def build_and_sign_firefox(version):
    """Build Firefox extension and sign via Mozilla API."""
    # Build
    print("Building Firefox extension...")
    result = subprocess.run([sys.executable, "build-firefox.py"], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ERROR building Firefox extension: {result.stderr}")
        sys.exit(1)
    print(result.stdout.strip())

    # Sign via web-ext (running directly in WSL environment)
    print("Signing Firefox extension...")
    result = subprocess.run([
        "/home/kevin/.npm-global/bin/web-ext", "sign",
        "--source-dir", "build/firefox",
        "--api-key", MOZILLA_API_KEY,
        "--api-secret", MOZILLA_API_SECRET,
        "--channel", "unlisted",
        "--artifacts-dir", ".",
    ], capture_output=True, text=True, timeout=600)

    if result.returncode != 0:
        print(f"ERROR signing Firefox extension: {result.stderr}")
        print(result.stdout)
        print("WARNING: Firefox signing failed — continuing without XPI (Chrome-only release)")
        return None

    # Find and rename the signed .xpi (web-ext names it with addon ID prefix).
    # Sort by mtime descending so we always pick the freshly signed file,
    # not a leftover from a previous release run.
    import glob
    signed_files = sorted(
        [f for f in glob.glob("*.xpi") if f != XPI_OUTPUT_NAME],
        key=os.path.getmtime,
        reverse=True,
    )
    if not signed_files:
        print("ERROR: Signed .xpi not found after web-ext sign")
        sys.exit(1)
    if os.path.isfile(XPI_OUTPUT_NAME):
        os.remove(XPI_OUTPUT_NAME)
    shutil.move(signed_files[0], XPI_OUTPUT_NAME)
    print(f"Signed: {XPI_OUTPUT_NAME} ({os.path.getsize(XPI_OUTPUT_NAME):,} bytes)")
    return XPI_OUTPUT_NAME


def update_updates_firefox_json(version):
    url = f"https://github.com/{GITHUB_REPO}/releases/download/v{version}/{XPI_OUTPUT_NAME}"
    data = {
        "addons": {
            "onshape-assistant@artila.dev": {
                "updates": [{"version": version, "update_link": url}]
            }
        }
    }
    with open(UPDATES_FIREFOX_PATH, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"Updated {UPDATES_FIREFOX_PATH} -> v{version}")


def run(cmd, check=True):
    """Run a shell command, print it, return result."""
    print(f"  $ {' '.join(cmd)}")
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def git_commit_and_push(version):
    """Stage release files, commit to dev (with dev_build), merge to main (strip dev_build there), push both."""
    run(["git", "add", UPDATES_XML_PATH, MANIFEST_PATH, UPDATES_FIREFOX_PATH])
    msg = f"Release v{version}: bump version and update download URL"
    run(["git", "commit", "-m", msg])

    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True, text=True, check=True
    ).stdout.strip()
    run(["git", "push", "origin", branch])
    print(f"Pushed to {branch}")

    # Merge to main — strip dev_build before committing so production manifest is clean
    print("Merging to main...")
    run(["git", "checkout", "main"])
    run(["git", "merge", branch, "--no-commit"])
    main_manifest = read_manifest()
    main_manifest.pop("dev_build", None)
    write_manifest(main_manifest)
    run(["git", "add", MANIFEST_PATH])
    run(["git", "commit", "-m", msg])
    run(["git", "push", "origin", "main"])
    print("Pushed to main")

    run(["git", "checkout", branch])
    print(f"Returned to {branch}")
    # dev manifest is restored by git checkout — dev_build was never stripped from dev

    return branch


def create_github_release(version, crx_path, xpi_path):
    """Create a GitHub Release and upload the .crx (and .xpi if available)."""
    tag = f"v{version}"
    assets = [crx_path]
    if xpi_path:
        assets.append(xpi_path)
    cmd = [
        GH_PATH, "release", "create", tag,
        *assets,
        "--title", tag,
        "--notes", f"Onshape Assistant {tag}",
        "--repo", GITHUB_REPO,
    ]
    result = run(cmd, check=False)
    if result.returncode != 0:
        print(f"ERROR creating release: {result.stderr}")
        sys.exit(1)
    url = result.stdout.strip()
    print(f"Release created: {url}")
    return url


def main():
    # Preflight
    if not os.path.isdir(EXTENSION_DIR):
        print(f"ERROR: {EXTENSION_DIR}/ directory not found. Run from OnshapeTools root.")
        sys.exit(1)

    manifest = read_manifest()
    if not manifest.get("dev_build"):
        print("ERROR: manifest.json is missing 'dev_build: true'.")
        print("A previous publish.py run may have crashed before restoring it.")
        print("Fix: add  \"dev_build\": true  to extension/manifest.json, then re-run.")
        sys.exit(1)

    current = manifest["version"]
    suggested = bump_version(current)

    print(f"Current version: {current}")
    new_version = input(f"New version [{suggested}]: ").strip() or suggested

    # Validate version format
    if not re.match(r"^\d+(\.\d+)+$", new_version):
        print(f"ERROR: Invalid version format '{new_version}'. Use X.Y or X.Y.Z")
        sys.exit(1)

    if new_version == current:
        print("ERROR: New version must differ from current version.")
        sys.exit(1)

    print(f"\nPublishing v{new_version}...\n")

    # 1. Update manifest version (keep dev_build — never strip from the real extension/)
    manifest["version"] = new_version
    write_manifest(manifest)
    print(f"Updated {MANIFEST_PATH} -> {new_version}")

    # 2. Pack .crx from a temp copy with dev_build stripped — real extension/ is never modified
    print(f"\nCreating temp copy for Chrome packing...")
    temp_dir = os.path.abspath(TEMP_EXTENSION_DIR)
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)
    try:
        shutil.copytree(EXTENSION_DIR, temp_dir)
        with open(os.path.join(temp_dir, "manifest.json")) as f:
            temp_manifest = json.load(f)
        temp_manifest.pop("dev_build", None)
        with open(os.path.join(temp_dir, "manifest.json"), "w") as f:
            json.dump(temp_manifest, f, indent=2)
            f.write("\n")
        crx_path = pack_crx(temp_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        print(f"Cleaned up {TEMP_EXTENSION_DIR}/")

    # 2b. Build and sign Firefox
    print("\nBuilding and signing Firefox extension...")
    xpi_path = build_and_sign_firefox(new_version)

    # 3b. Update updates-firefox.json (only if XPI signed successfully)
    if xpi_path:
        update_updates_firefox_json(new_version)

    # 3. Update updates.xml
    update_updates_xml(new_version)
    print(f"Updated {UPDATES_XML_PATH} -> v{new_version}")

    # 4. Git commit + push
    print("\nCommitting and pushing...")
    branch = git_commit_and_push(new_version)

    # 5. Create GitHub Release
    print("\nCreating GitHub Release...")
    release_url = create_github_release(new_version, crx_path, xpi_path)

    # 6. Summary
    print("\n" + "=" * 50)
    print(f"  Version:  {new_version}")
    print(f"  Branch:   {branch}")
    print(f"  Release:  {release_url}")
    print(f"  .crx:     {crx_path}")
    print(f"  .xpi:     {xpi_path}")
    print("=" * 50)



if __name__ == "__main__":
    main()
