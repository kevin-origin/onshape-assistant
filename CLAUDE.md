# Onshape Assistant — CLAUDE.md

## File map

```
extension/
  background.js     ~3930 lines — service worker, all Onshape API calls, CDP automation
  content.js        ~1750 lines — injected into cad.onshape.com, ISOLATED world: DOM scanning, overlays, guards
  content-main.js     ~100 lines — injected into cad.onshape.com, MAIN world: fetch intercept + assembly button guard
  popup.js            ~700 lines — popup UI logic, section navigation, display helpers
  popup.html                     — popup markup; sections: Drawing, Scanner, Violations, Interference, Merge
  manifest.json                  — MV3, permissions, host_permissions, service_worker, content_scripts
publish.py                       — automates version bump, CRX pack, GitHub release
generate_admin_guide.py          — PDF guide generator (FPDF)
onshape-assistant-sync/
  src/index.js                   — Cloudflare Worker: KV-backed merge permissions API
  wrangler.toml                  — Worker config
updates.xml                      — Auto-update manifest (Chrome polls this for new .crx)
```

### Why two content scripts?

`content.js` (ISOLATED world) — `chrome.*` APIs available, no `window.fetch` access. `content-main.js` (MAIN world) — can intercept `window.fetch` and read Angular state, no `chrome.*` APIs. They communicate via `document.documentElement.dataset` (`data-oxt-*` attributes).

---

## Session startup — Kevin's planner

**On every new session start, your very first output must be:**
```
Run the monitor: bash ~/claude-monitor.sh
```
After the user confirms the monitor is open, immediately:
1. **Ensure inbox file exists** before starting the monitor: `touch /tmp/planner_inbox.txt` — the Monitor tool will fail with exit 1 if the file doesn't exist yet.
2. Start the planner inbox monitor: `Monitor(command="tail -f /tmp/planner_inbox.txt", persistent=true)` — this delivers agent `tell.sh` notifications directly to the chat
3. **Verify Claude is running in all panes** before sending `/status` — capture each pane and check for the Claude TUI prompt. If any pane shows a bare bash shell (`$` prompt), Claude has crashed. Rerun the monitor: `tmux kill-session -t claude-monitor 2>/dev/null; bash ~/claude-monitor.sh &`. After rerunning, wait ~5 seconds for Claude to load before proceeding.
4. Run the full agent setup sequence in "Multi-agent workflow" below — no further prompting needed

---

## background.js / content.js / popup.js — navigation

All major sections are marked `// Section name`. Use Grep to locate any section or function — do not read the full file.

```bash
Grep("// Drawing Creator", "extension/background.js")   # → jump to line, then read offset
Grep("checkInterference", "extension/background.js")
Grep("scanTabFolders", "extension/content.js")
```

Message types in background.js are dispatched in the `// Message handler` section. Grep for the message type string to find its handler and sender.

---

## content-main.js — MAIN world script

Two IIFE-scoped guards (`initAssemblyCreationGuard`, `initAssemblyFetchGuard`). No `chrome.*` APIs.

**Data flow:** `content.js` writes `document.documentElement.dataset.oxtAssemblyCount`. `initAssemblyCreationGuard` watches that attribute and applies `pointer-events:none / opacity:0.4` to the assembly button. `initAssemblyFetchGuard` patches `window.fetch` as a backstop — intercepts POST to `/api/v[N]/assemblies` and returns synthetic 400.

**Confirmed DOM selectors (live-observed 2026-04-26):**
- Dropdown: `ul#document-tabs-create-ul`
- Assembly button: `a#create-assembly-button` (id stable, no text-matching fallback needed)

---

## onshape-assistant-sync/src/index.js — Cloudflare Worker

Routes (all require `X-API-Key: artila-onshape-sync-2026`). KV namespace: `PERMISSIONS` — key = docId, value = JSON array of owner emails.

---

## publish.py — release flow

Non-obvious behavior:
1. **Strips `dev_build: true`** from manifest.json before packing (must not appear in production CRX)
2. Commits to dev → merges to main → pushes both
3. **Restores `dev_build: true`** to dev branch manifest and commits
4. Creates GitHub Release with CRX + XPI attached

---

## Extension coding rules

- **MV3**: no inline `onclick` — always `addEventListener`
- **Auth**: session cookies only (`credentials: "include"` + XSRF token). Never use API keys in the extension
- **DOM selectors**: check `dom-map.md` first — if the element is already mapped, use it. If not, observe first (`observe-dom-changes` → manual action → `read-dom-changes`), then update `dom-map.md`
- **Async elements**: always use `waitForEl(selector, callback)` — never `if (!el) return`. Onshape renders elements async via Angular
- **Drawing units**: positions are millimeters, origin bottom-left, y increases upward
- **View identification**: use `viewMatrix` values, not index
  - Non-integer values → Isometric
  - `m[0]=1` and `m[6]=1` → Front
  - `m[0]=1` and `m[5]=1` → Top
  - `m[1]=±1` → Left/Right

---

## Kill switch (background.js — `Kill switch` section)

Three-layer design — only active on production CRX builds (main), never on dev:

- **Layer 1** — `chrome.storage.sync` flag: checked instantly on every SW start, survives browser restarts, no network needed
- **Layer 2** — `chrome.storage.local` cache: 90-minute offline fallback, populated by Layer 3
- **Layer 3** — remote fetch from Cloudflare Worker `/api/blocked-emails`: no new build needed to block/unblock

**Dev vs production:** `manifest.json` on dev has `"dev_build": true`. The kill switch checks `!chrome.runtime.getManifest().dev_build` — false on dev (skipped entirely), true on production CRX (all three layers active). `publish.py` strips this flag before packing and restores it to dev after the merge.

**To block a user (no build required):**
```bash
curl -X PUT https://onshape-assistant-sync.artilabot.workers.dev/api/blocked-emails \
  -H "X-API-Key: artila-onshape-sync-2026" \
  -H "Content-Type: application/json" \
  -d '{"blocked":["user@example.com"]}'
```
Takes effect on all installed instances within 60 minutes (hourly alarm) or on next Chrome restart.

**To unblock:** run the same curl with the email removed from the array. The sync flag is cleared automatically within one alarm cycle.

**`BLOCKED_EMAILS = []`** in background.js is a local fallback only — the authoritative list lives in the Cloudflare Worker KV.

---

## Task splitting across remote devices

**Kevin's Claude is the planner only — it must never edit code files directly.** All file edits must be delegated to remote devices.

**Usage monitoring:** After assigning a task to a remote device, periodically check its `capture-pane` output for "out of usage". If detected:
- Mark that device as exhausted
- Reassign its remaining incomplete files to one of the other active devices
- Continue without interrupting Kevin unless all devices are exhausted

---

## Multi-agent workflow

### Known agents

Local Claude accounts in the claude-monitor tmux session:
- claude_vishal, claude_kaustubh, claude_rohith, claude_hriday, claude_harini (and others)

**Before sending any agent their first task**, verify their working directory is `/mnt/c/Users/kevin/Desktop/OnshapeTools`. If it is not, send `cd /mnt/c/Users/kevin/Desktop/OnshapeTools` to their pane before the briefing. All file edits, git commands, and tasks must be run from this path.

Identify active agents by reading each pane's `/status` output — do not assume which panes are occupied.

### Role assignment sequence

Once the monitor is open, run this automatically — no prompting needed:

1. **Map panes to agents** — use `bash ~/tell.sh` (no args) to list active agents and their pane indices. Only fall back to sending `/status` to individual panes if tell.sh cannot identify them (e.g. Claude hasn't started yet in that pane).
2. Select the agents with lowest usage for tasks

Constraints:
- Edit [FILE] only — no other files
- MV3: no inline onclick, always addEventListener
- Auth: session cookies only, never API keys
- DOM selectors: never guess — observe first
- Do not commit — planner handles git
- Only communicate with the planner — never contact other agents directly
- **On every session start, check your own identity immediately**: run `/status` and read the `Email:` line. If your email is `kevin@origin.tech` you are the planner — follow the planner workflow above. If your email is anything else, you are a worker agent — do not assign tasks to other agents, do not manage panes, do not act as a coordinator. Your only job is to execute the task you were given and report back via tell.sh.
- When you finish a task, ALWAYS run: bash ~/tell.sh planner "done: [file] — [brief summary]"
```

### Usage monitoring

**Trigger: every time an agent sends a tell.sh inbox message.** Since agents only send tell.sh when they finish a task (i.e. they are idle and waiting), that is the right moment to check their usage — no interruption risk.

After receiving any inbox message, before sending the agent their next task:
1. Identify the agent's pane index from your pane→agent table
2. Send `/usage` to their pane (two separate send-keys calls with sleep 1 between, per hard rules):
   ```bash
   tmux send-keys -t claude-monitor:0.N "/usage"
   sleep 1
   tmux send-keys -t claude-monitor:0.N Enter
   ```
3. Wait 2 seconds, then capture the pane and read the usage %
4. Send Escape to dismiss the overlay:
   ```bash
   sleep 2
   tmux capture-pane -t claude-monitor:0.N -p   # read the %
   tmux send-keys -t claude-monitor:0.N Escape
   ```
5. If usage ≥ 75%: warn Kevin before assigning more work to that agent
6. If usage = "out of extra usage" / frozen: mark exhausted, reassign their file, notify Kevin only if all agents exhausted

**Hourly fallback poll:** In addition to the tell.sh trigger, once per hour loop through all active agent panes and run the same `/usage` check on each. This catches agents that run out mid-task before they can send a tell.sh.

Use **CronCreate** (not Monitor) for this. CronCreate fires a prompt to the planner on a schedule — the planner then uses its full tool set to send `/usage` to each pane, interpret results, and reassign if needed.

Create both crons **immediately after all agents have acknowledged their briefings** (step 5 of the role assignment sequence):
```
// Hourly usage sweep
CronCreate(
  cron: "7 * * * *",   // every hour at :07, off the :00 mark
  prompt: "Hourly usage sweep: send /usage to every active agent pane, capture the result, send Escape to dismiss. Report each agent's usage %. If any agent is ≥75%, warn Kevin. If any agent shows 'out of extra usage', mark exhausted and reassign their file."
)

// Every 30 min context sweep
CronCreate(
  cron: "17,47 * * * *",   // at :17 and :47 each hour
  prompt: "Context sweep: (1) Check your own context with /context — if your free space is below 50%, run /compact on yourself first. (2) For each active agent pane, send /context, wait 2s, capture the pane, parse the 'Free space' % line, send Escape to dismiss. If any agent has less than 50% free space remaining, send /compact to that pane. Report all free space %s including your own."
)
```

---

## Hard rules
- **Credentials are hardcoded** in scripts — do not refactor to env vars, unless credentials are unavailable in which case ask and substitute
- **Always edit on `dev`, never `main`**: before touching any file, verify `git branch` shows `dev`. If on main, run `git checkout dev` first. This applies to all agents and all sessions.
- After Kevin approves any edit: commit and `git push origin dev` immediately
- **At session startup only, before sending initial briefings:** escape ALL active agent panes once (loop Escape over every pane with a sleep between each) to clear any /status overlays. Do NOT escape before every individual tmux message — only once at the start of the briefing sequence.
- **tmux send-keys — always split text and Enter**: never use `tmux send-keys -t PANE "message" Enter` in one call. Always do two separate calls with a sleep in between:
  ```bash
  tmux send-keys -t PANE "message"
  sleep 1
  tmux send-keys -t PANE Enter
  ```
  Combining them causes Enter to fire before the TUI registers the text, leaving messages unsubmitted.
- **Workflow improvements**: after debugging and fixing any workflow error (monitor setup, agent briefing, usage checks, etc.), ask Kevin: "Should I update this workflow in CLAUDE.md?" — do not silently apply the fix without offering to document it.
- **SW relay — agents run it themselves**: agents must never ask Kevin to run commands in the service worker or to start the SW relay. Agents must launch the relay themselves (`pkill -f sw-relay.py 2>/dev/null; python3 ~/sw-relay.py > /tmp/sw-relay.log 2>&1 &`), verify it connected, and use `sw-exec.py` directly. Kevin is never involved in SW execution steps.

---

## Commands

```bash
echo "" | python3 publish.py   # bump version (accepts default), pack CRX, push, create GitHub release
```

`publish.py` has one interactive prompt (version number). Pipe an empty string to accept the auto-suggested patch bump. To specify a version explicitly: `echo "2.1.13" | python3 publish.py`

### Version number convention (`MAJOR.MINOR.PATCH`)

- **MAJOR** — complete rewrite or major UI overhaul
- **MINOR** — new feature added
- **PATCH** — bug fix or tweak to an existing feature

## Service worker testing (sw-relay)

Run arbitrary JS in the Chrome extension service worker from WSL — no manual console needed.

**Setup — Claude runs all of this autonomously, never asks Kevin:**
1. Launch Chrome:
   ```bash
   powershell.exe -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--remote-debugging-port=9223','--user-data-dir=C:\Users\kevin\AppData\Local\Google\Chrome\Debug'"
   ```
2. Load the unpacked extension: `chrome://extensions` → Enable Developer mode → Load unpacked → `C:\Users\kevin\Desktop\OnshapeTools\extension\`
3. Start sw-relay in background (log to file — do NOT use `-File chrome-debug.ps1`, it doesn't open Chrome):
   ```bash
   pkill -f sw-relay.py 2>/dev/null; python3 ~/sw-relay.py > /tmp/sw-relay.log 2>&1 &
   ```
4. Verify connected:
   ```bash
   sleep 5 && cat /tmp/sw-relay.log
   # expect: [relay] CDP connected: ws://127.0.0.1:9223/devtools/page/...
   ```
5. `python3 ~/sw-exec.py "<js expression>"` — sends expression, prints result

**Architecture:**
```
sw-exec.py → ws://localhost:9300/cmd → sw-relay.py → CDP Runtime.evaluate → SW
```

- `sw-relay.py` uses `urllib.request` (not asyncio) for `/json/list` — asyncio TCP reads time out in WSL2 mirrored networking
- `awaitPromise: true` — Promises resolve before result is returned
- Wrap multi-statement code in `(async () => { ... })()` — top-level await not supported in CDP eval

**Examples:**
```bash
python3 ~/sw-exec.py "typeof onshapeFetch"
python3 ~/sw-exec.py "(async()=>{ return JSON.stringify(await getSessionUser()) })()"
python3 ~/sw-exec.py "new Promise(r => chrome.storage.local.get(null, r))"
```

## Onshape API notes

- If any Onshape API call returns a 429, flag it to Kevin immediately — endpoint, method, and which feature triggered it.
- Company ID: `6810c247e7c40668c32816a6`
- `filter=6` for documents by owner (`filter=7` = label filter, wrong)
- `globaltreenodes/folder/{COMPANY_ID}` returns 403 on Pro — use `parentId` from docs + `GET /api/v10/folders/{fid}`
- BOM Template - Origin ID: `dc9153301b06a1d59d889555` — pass as `?templateId=` to `GET /api/v10/assemblies/d/{did}/{wvm}/{wvmid}/e/{eid}/bom`