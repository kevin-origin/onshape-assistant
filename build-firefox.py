import json, re, shutil, os

SRC = "extension"
DST = "build/firefox"

if os.path.exists(DST):
    shutil.rmtree(DST)
shutil.copytree(SRC, DST)

# Ensure kill switch is always commented out in the Firefox build
bg_path = os.path.join(DST, "background.js")
with open(bg_path) as f:
    bg = f.read()
bg = re.sub(r'^(\s*)const BLOCKED_EMAILS', r'\1// const BLOCKED_EMAILS', bg, flags=re.MULTILINE)
with open(bg_path, "w") as f:
    f.write(bg)

manifest_path = os.path.join(DST, "manifest.json")
with open(manifest_path) as f:
    m = json.load(f)

# Remove debugger permission, add alarms
m["permissions"] = [p for p in m["permissions"] if p != "debugger"]
if "alarms" not in m["permissions"]:
    m["permissions"].append("alarms")

# Swap service_worker for background scripts array
m["background"] = {"scripts": ["background.js"]}

# Add gecko settings
m["browser_specific_settings"] = {
    "gecko": {
        "id": "onshape-assistant@artila.dev",
        "strict_min_version": "128.0",
        "update_url": "https://raw.githubusercontent.com/kevin-origin/onshape-assistant/main/updates-firefox.json"
    }
}

# Remove Chrome's top-level update_url (Firefox uses the one inside gecko settings)
m.pop("update_url", None)

with open(manifest_path, "w") as f:
    json.dump(m, f, indent=2)

print(f"Firefox build written to {DST}/")
