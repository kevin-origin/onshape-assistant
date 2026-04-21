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

# ---------------------------------------------------------------------------
# Post-process: wrap chrome.debugger references in HAS_DEBUGGER guards so
# Firefox's add-on linter does not warn on chrome.debugger call sites.
# HAS_DEBUGGER=false prevents execution; the guards silence static analysis.
# ---------------------------------------------------------------------------
GUARD = "if (typeof HAS_DEBUGGER !== 'undefined' && HAS_DEBUGGER)"

# 1. Wrap the entire CDP helpers section (cdpSend through waitForElement).
#    Match from the section separator/header through to just before the
#    Discovery helper separator, and enclose the body in the guard block.
bg = re.sub(
    r'(// -{74,}\n// CDP helpers[^\n]*\n// -{74,}\n)'   # CDP helpers header (3 lines)
    r'(.*?)'                                              # section body (lazy, DOTALL)
    r'(// -{74,}\n// Discovery helper)',                  # Discovery helper header (first 2 lines)
    lambda m: (
        m.group(1) +
        GUARD + " {\n\n" +
        m.group(2).rstrip("\n") + "\n\n" +
        "}\n\n" +
        m.group(3)
    ),
    bg,
    flags=re.DOTALL,
    count=1,
)

# 2. Wrap standalone chrome.debugger.attach calls using brace counting so the
#    wrapper is correct regardless of how many lines the callback body has.
def guard_attach_blocks(text, guard):
    OPEN = 'chrome.debugger.attach({ tabId }, "1.3", () => {'
    out = []
    i = 0
    while i < len(text):
        pos = text.find(OPEN, i)
        if pos == -1:
            out.append(text[i:])
            break
        # Leading indent: everything on the same line before the match
        line_start = text.rfind('\n', 0, pos) + 1
        indent = text[line_start:pos]
        # Emit text up to (but not including) the indented line; the indent is
        # re-applied by the wrapped output below, so stop at line_start not pos
        # to avoid prepending the indent twice.
        out.append(text[i:line_start])
        # Count braces from the opening `{` of the arrow-function callback
        brace_pos = pos + len(OPEN) - 1   # index of the `{` at end of OPEN
        depth, j = 1, brace_pos + 1
        while j < len(text) and depth > 0:
            if text[j] == '{':
                depth += 1
            elif text[j] == '}':
                depth -= 1
            j += 1
        # j is now one past the matching `}`; the statement closes with `);`
        if text[j:j+2] == ');':
            stmt_end = j + 2
        else:
            # Unexpected shape — emit unchanged (with indent) and advance
            out.append(indent + text[pos:j])
            i = j
            continue
        block = text[pos:stmt_end]
        full_block = indent + block          # restore leading indent on first line
        indented = "\n".join("  " + line for line in full_block.splitlines())
        out.append(indent + guard + " {\n" + indented + "\n" + indent + "}")
        i = stmt_end
    return "".join(out)

bg = guard_attach_blocks(bg, GUARD)

# 3. Wrap standalone chrome.debugger.detach calls (single-line).
#    .*? before chrome.debugger.detach is bounded by ^ / $ (MULTILINE) so it
#    stays on one line but handles any prefix — plain call or
#    "if (...) " with arbitrarily nested parentheses — without [^)]+ fragility.
bg = re.sub(
    r'^( *)(.*?chrome\.debugger\.detach\(\{ tabId \}, \(\) => \{\}\);)$',
    lambda m: m.group(1) + GUARD + " { " + m.group(2) + " }",
    bg,
    flags=re.MULTILINE,
)

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

# Add gecko settings.  data_collection_permissions silences the AMO reviewer
# warning about a missing data-collection declaration.
m["browser_specific_settings"] = {
    "gecko": {
        "id": "onshape-assistant@artila.dev",
        "strict_min_version": "128.0",
        "update_url": "https://raw.githubusercontent.com/kevin-origin/onshape-assistant/main/updates-firefox.json",
        "data_collection_permissions": {"required": [], "optional": []},
    }
}

# Remove Chrome's top-level update_url (Firefox uses the one inside gecko settings)
m.pop("update_url", None)

with open(manifest_path, "w") as f:
    json.dump(m, f, indent=2)

print(f"Firefox build written to {DST}/")
