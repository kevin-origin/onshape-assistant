# Onshape Assistant — CLAUDE.md

## Last stable KV release: v2.1.35
D1 migration not yet deployed — Worker still uses KV for heartbeats/active/violations/dedup.
If D1 migration breaks anything, roll back to this release.

## Reference repo
onshape-to-robot source is cloned locally at `onshape-to-robot-ref/` (gitignored). Use Grep/Read on it directly — do NOT fetch from GitHub. Key files: `onshape_to_robot/robot.py`, `onshape_to_robot/onshape.py`, `onshape_to_robot/utils.py`.

## File map
```
extension/
  background.js     ~3930 lines — service worker, all Onshape API calls, CDP automation
  content.js        ~1750 lines — injected into cad.onshape.com, ISOLATED world: DOM scanning, overlays, guards
  content-main.js     ~100 lines — MAIN world: fetch intercept + assembly button guard
  popup.js            ~700 lines — popup UI logic, section navigation, display helpers
  popup.html                     — popup markup; sections: Drawing, Scanner, Violations, Interference, Merge
  manifest.json                  — MV3, permissions, host_permissions, service_worker, content_scripts
publish.py                       — automates version bump, CRX pack, GitHub release
onshape-assistant-sync/src/index.js — Cloudflare Worker: KV-backed merge permissions API
updates.xml                      — Auto-update manifest (Chrome polls this for new .crx)
```

`content.js` (ISOLATED world) — `chrome.*` APIs, no `window.fetch`. `content-main.js` (MAIN world) — intercepts `window.fetch`, no `chrome.*`. Communicate via `document.documentElement.dataset` (`data-oxt-*`).

**content-main.js:** Two guards: `initAssemblyCreationGuard` (watches `oxtAssemblyCount`, disables assembly button), `initAssemblyFetchGuard` (patches `window.fetch`, blocks POST to `/api/v[N]/assemblies`). DOM: dropdown `ul#document-tabs-create-ul`, button `a#create-assembly-button`.

**Worker routes** (all require `X-API-Key: artila-onshape-sync-2026`). KV namespace `PERMISSIONS` — key = docId, value = JSON array of owner emails.

**publish.py:** Strips `dev_build: true` → commits dev → merges main → pushes both → creates GitHub Release (CRX + XPI) → restores `dev_build: true` to dev.

---

## Session startup — Kevin's planner

**First output every session:**
```
Run the monitor: bash ~/claude-monitor.sh
```
After monitor confirmed:
1. `touch /tmp/planner_inbox.txt` — Monitor fails if missing
2. `Monitor(command="tail -f /tmp/planner_inbox.txt", persistent=true)`
3. Verify Claude running in all panes (bare `$` = crashed → `tmux kill-session -t claude-monitor 2>/dev/null; bash ~/claude-monitor.sh &`, wait 5s)
4. Run full agent setup (Multi-agent workflow below) — no prompting needed

---

## Navigation

All major sections marked `// Section name`. Always Grep, never read full file.
```bash
Grep("// Drawing Creator", "extension/background.js")  # → jump to line, read offset
Grep("checkInterference", "extension/background.js")
```
Message types dispatched in `// Message handler` — Grep the message type string to find handler + sender.

---

## Extension coding rules
- **MV3**: no inline `onclick` — always `addEventListener`
- **Auth**: session cookies only (`credentials: "include"` + XSRF token). Never API keys in extension
- **DOM selectors**: check `dom-map.md` first. If unmapped: observe → manual action → read changes → update `dom-map.md`
- **Async elements**: always `waitForEl(selector, callback)` — never `if (!el) return`
- **Drawing units**: millimeters, origin bottom-left, y increases upward
- **View identification**: use `viewMatrix` values — non-integer → Isometric; `m[0]=1,m[6]=1` → Front; `m[0]=1,m[5]=1` → Top; `m[1]=±1` → Left/Right

---

## Kill switch (`Kill switch` section in background.js)

Three layers, production only (`dev_build: true` skips all). Layer 1: `chrome.storage.sync` (instant, persistent). Layer 2: `chrome.storage.local` 90-min cache. Layer 3: remote fetch `/api/blocked-emails`.

**Block/unblock (no build needed):**
```bash
curl -X PUT https://onshape-assistant-sync.artilabot.workers.dev/api/blocked-emails \
  -H "X-API-Key: artila-onshape-sync-2026" -H "Content-Type: application/json" \
  -d '{"blocked":["user@example.com"]}'
```
Takes effect within 60 min (hourly alarm) or next Chrome restart. Remove email from array to unblock.

---

## Cloudflare KV write limit

Free tier: **1,000 writes/day** (error 10048 if exceeded, resets midnight UTC).
```bash
cd /mnt/c/users/kevin/Desktop/OnshapeTools/onshape-assistant-sync
XDG_CONFIG_HOME="/mnt/c/users/kevin/AppData/Roaming/xdg.config" npx wrangler kv key put --binding=MERGE_PERMS --remote --preview false "kv-write-check" "ok"
```
Success → under limit. Error 10048 → exhausted. If hit: emergency kill switch or upgrade to Workers Paid ($5/mo → 1M writes/day).

**Get exact read/write counts:** OAuth token auto-refreshes on any wrangler command — always read token AFTER running one.
```bash
# 1. Refresh token (run the quick test above first), then:
TOKEN=$(cat "/mnt/c/users/kevin/AppData/Roaming/xdg.config/.wrangler/config/default.toml" | grep oauth_token | cut -d'"' -f2)
ACCOUNT_ID="ab136a8e8c784423b11c15ecce062727"
TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
TOMORROW=$(date -u -d '+1 day' +%Y-%m-%dT00:00:00Z)
curl -s "https://api.cloudflare.com/client/v4/graphql" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\": \"{ viewer { accounts(filter: {accountTag: \\\"$ACCOUNT_ID\\\"}) { kvOperationsAdaptiveGroups(limit: 10, filter: { datetime_geq: \\\"$TODAY\\\", datetime_leq: \\\"$TOMORROW\\\" }, orderBy: [sum_requests_DESC]) { sum { requests } dimensions { actionType } } } } }\"}" | python3 -m json.tool
```
Output: `actionType: "read"` / `"write"` with counts.

---

## Multi-agent workflow

**Kevin's Claude = planner only. Never edit files directly — delegate all edits.**

**Agent setup (run automatically after monitor confirmed):**
1. `bash ~/tell.sh` — lists active agents + pane indices. Fall back to `/status` per pane only if tell.sh fails.
2. Escape all panes once to clear overlays (loop with sleep between each) — only at session start, not before every message
3. Verify each agent's cwd = `/mnt/c/Users/kevin/Desktop/OnshapeTools` — send `cd` if not
4. Select lowest-usage agents for tasks
5. After all agents acknowledge briefings, create both crons (below)

**Agent constraints (include in every briefing):**
Edit assigned file only · MV3/addEventListener · session cookies only · never guess DOM selectors · do not commit · report via `bash ~/tell.sh planner "done: [file] — [summary]"` · check own identity with `/status` on session start

**Usage monitoring:** On every tell.sh inbox message, before next task: send `/usage` to agent pane (two send-keys calls + sleep), wait 2s, capture pane, send Escape. Warn Kevin if ≥75%; mark exhausted + reassign if "out of extra usage".

**Crons (create after all agents briefed):**
```
CronCreate(cron:"7 */4 * * *", prompt:"Usage sweep: /usage every active agent pane, capture %, send Escape. Warn Kevin ≥75%, mark exhausted + reassign if out of usage.")
CronCreate(cron:"17 */2 * * *", prompt:"Context sweep: /context on yourself first (compact if <50% free), then each agent pane. Send /compact to any agent <50% free. Report all %s.")
```

---

## Hard rules
- **Credentials are hardcoded** — do not refactor to env vars (ask if unavailable)
- **Always edit on `dev`** — verify `git branch` before touching files. `git checkout dev` if on main.
- After Kevin approves any edit: commit + `git push origin dev` immediately
- **tmux send-keys — always split text and Enter** into two calls with sleep between:
  ```bash
  tmux send-keys -t PANE "message"
  sleep 1
  tmux send-keys -t PANE Enter
  ```
- **Workflow improvements**: after fixing any workflow error, ask Kevin "Should I update CLAUDE.md?" — never silently apply
- **SW relay — agents run autonomously**: never ask Kevin. Launch: `pkill -f sw-relay.py 2>/dev/null; python3 ~/sw-relay.py > /tmp/sw-relay.log 2>&1 &`

---

## Commands

```bash
echo "" | python3 publish.py          # patch bump (default)
echo "2.1.13" | python3 publish.py    # explicit version
```
Version: **MAJOR** = rewrite/UI overhaul · **MINOR** = new feature · **PATCH** = bug fix/tweak

## Service worker testing (sw-relay)

Claude runs setup autonomously — never asks Kevin.
1. Launch Chrome: `powershell.exe -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList '--remote-debugging-port=9223','--user-data-dir=C:\Users\kevin\AppData\Local\Google\Chrome\Debug'"`
2. Load unpacked extension: `chrome://extensions` → Developer mode → Load unpacked → `C:\Users\kevin\Desktop\OnshapeTools\extension\`
3. `pkill -f sw-relay.py 2>/dev/null; python3 ~/sw-relay.py > /tmp/sw-relay.log 2>&1 &`
4. `sleep 5 && cat /tmp/sw-relay.log` — expect `[relay] CDP connected: ws://127.0.0.1:9223/...`
5. `python3 ~/sw-exec.py "<js>"` — e.g. `python3 ~/sw-exec.py "(async()=>{ return JSON.stringify(await getSessionUser()) })()"`

Notes: `sw-relay.py` uses `urllib.request` (asyncio TCP times out in WSL2). Wrap multi-statement code in `(async () => { ... })()`.

## Onshape API notes
- 429 response → flag to Kevin immediately (endpoint + feature)
- Company ID: `6810c247e7c40668c32816a6`
- `filter=6` = by owner (`filter=7` = label, wrong)
- `globaltreenodes/folder/{COMPANY_ID}` → 403 on Pro — use `GET /api/v10/folders/{fid}` with `parentId`
- BOM Template Origin ID: `dc9153301b06a1d59d889555` — pass as `?templateId=` to BOM endpoint
