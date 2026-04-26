# Onshape Assistant — CLAUDE.md

## File map

```
extension/
  background.js   ~3930 lines — service worker, all Onshape API calls, CDP automation
  content.js      ~1750 lines — injected into cad.onshape.com, DOM scanning, overlays
  popup.js         ~700 lines — popup UI logic, section navigation, display helpers
  popup.html                  — popup markup; sections: Drawing, Scanner, Violations, Interference, Merge
  manifest.json               — MV3, permissions, host_permissions, service_worker, content_scripts
publish.py                    — automates version bump, CRX pack, GitHub release
build-edge.py                 — copies extension/ to build/edge/, strips update_url from manifest
generate_admin_guide.py       — PDF guide generator (FPDF)
onshape-assistant-sync/
  src/index.js                — Cloudflare Worker: KV-backed merge permissions API
  wrangler.toml               — Worker config
updates.xml                   — Auto-update manifest (Chrome polls this for new .crx)
updates-edge.xml              — Auto-update manifest (Edge polls this for new .zip)
```

---

## Session startup — Kevin's planner

**On every new session start, your very first output must be:**
```
Run the monitor: bash ~/claude-monitor.sh
```
After the user confirms the monitor is open, immediately:
1. Start the planner inbox monitor: `Monitor(command="tail -f /tmp/planner_inbox.txt", persistent=true)` — this delivers agent `tell.sh` notifications directly to the chat
2. Run the full agent setup sequence in "Multi-agent workflow" below — no further prompting needed

---

## background.js — sections

Find any section with: `// Section name`

| Section header | What lives there |
|---|---|
| `Session user cache` | `getSessionUser()` — cached `/api/v10/users/sessioninfo` |
| `Kill switch` | Blocked emails array (`[]` on dev, `[emails...]` on main — never comment out the block) |
| `Team members cache` | `getTeamMembers()` — cached team member list |
| `Onshape API via session cookies` | `onshapeFetch()`, `getXsrfToken()`, `onshapePost()` |
| `Drawing Creator` | `createDrawingsForUrl()` — full drawing creation orchestrator; `broadcastDrawLog()`, `parsePartStudioUrl()`, `computeScale()`, `pollModify()` |
| `Auto-dimension helpers` | `identifyViewOrientation()`, `getViewGeometry()`, `findBoundingEdges()`, `addOverallDimensions()` |
| `Tab navigation helpers` | `navigateTab()`, `waitForTabLoad()` |
| `Try sending scan message` | `trySendScan()` |
| `Store scan result` | `storeDocScanResult()` — persists to `chrome.storage.local` |
| `Violation checker` | `checkDocViolations()` — checks folder/tab structure per doc |
| `DOM automation: add drawing sheet` | `addSheetViaIframe()` — iframe injection to add sheets |
| `CDP helpers` | `cdpSend`, `cdpClick`, `cdpRightClick`, `cdpTypeText`, `cdpPressKey`, `cdpDrag`, `waitForElement()` |
| `Discovery helper` | `discoverContextMenu()` — dumps right-click menu DOM (dev/diagnostics) |
| `Folder creation orchestrator` | `createTabFolders()`, `sortDefaultTabs()` |
| `New-doc setup` | `createInitialVersion()`, `createDevelopmentBranch()`, `enableWorkspaceProtection()` |
| `Unpack Illegal Folders` | `unpackIllegalFolders()` — CDP right-click → Unpack |
| `Tab Sorter` | `sortStrayTabs()` — moves stray root-level tabs into folders |
| `Interference Detection` | `checkInterference()` — CDP assembly interference check |
| `Message handler` | `chrome.runtime.onMessage` dispatch — all message types (see below) |
| `SPA navigation detection` | Notifies content.js when Onshape URL changes without reload |
| `Storage cleanup` | `cleanupDeletedDocs()` — purge storage for dead docs |
| `Auto-reload` | `checkForLocalUpdate()` — dev-mode file-change detection |

### background.js message types

| Message type | Purpose |
|---|---|
| `check-kill-switch` | Check if current user is blocked |
| `fetch-parts` | List parts in a Part Studio |
| `create-drawings` | Trigger `createDrawingsForUrl()` |
| `tab-folder-result` | Receive scan result from content.js |
| `folder-scan-notify` | Notify popup of scan completion |
| `check-releases` | Check release violations |
| `test-add-sheet` | Test iframe sheet addition |
| `check-versions` | Check version count violations |
| `create-folders` | Trigger `createTabFolders()` |
| `sort-tabs` | Trigger `sortStrayTabs()` |
| `unpack-illegal-folders` | Trigger `unpackIllegalFolders()` |
| `check-interference` | Trigger `checkInterference()` |
| `discover-context-menu` | Trigger `discoverContextMenu()` |
| `observe-dom-changes` | Start DOM mutation observer |
| `read-dom-changes` | Read captured mutations |
| `observe-drawing-iframe` | Observe drawing iframe DOM |
| `read-drawing-iframe` | Read captured iframe mutations |
| `rescan-active-tab` | Force rescan current tab |
| `get-session-user` | Return cached session user |
| `get-team-members` | Return cached team members |
| `check-merge-allowed` | Check if user can merge |
| `save-merge-owners` | Persist merge owners to sync backend |
| `get-merge-perms` | Fetch merge permissions |
| `list-company-folders` | List top-level company folders |
| `list-subfolders` | List subfolders of a folder |
| `create-doc-in-folder` | Create new doc inside a folder |
| `get-doc-creator` | Fetch doc creator info |

---

## content.js — sections

| Section header | What lives there |
|---|---|
| `Release settings page guard` | Blocks non-admin users from `/companySettings/.../release` with full-page overlay |
| `Helpers` | `sleep()`, `getDocIdFromUrl()`, `getWidFromUrl()`, `getDocName()`, `getAllTabsBreadcrumb()`, `getTabNames()`, `getBreadcrumbDepth()` |
| `Main scan` | `clickAllTabs()`, `scanTabFolders()`, `sendScanResult()`, `waitForTabBar()` |
| `Auto-scan logic` | `autoScan()` — debounced trigger on DOM change; `maybeOfferFolderCreation()` |
| `Folder creation overlay` | `showFolderOverlay()`, `showProgressToast()`, `removeFolderOverlay()` |
| `CDP automation overlay` | `showCdpOverlay()` / `removeCdpOverlay()` — shown while debugger is attached |
| `Message handler` | `chrome.runtime.onMessage` dispatch (see below) |
| `Auto-scan on page load` | `runOnDocLoad()` — entry point, sets up observers |
| `Export Drawing detection` | Blocks export when violations/no releases exist; watches for export modal via MutationObserver |
| `Merge dialog blocker` | Blocks non-owners from merging; MutationObserver watches for merge modal |
| `Merge owner selection overlay` | `showMergeOwnerOverlay()` — assign merge permission owners |
| `Create Document Interceptor` | `initCreateDocInterceptor()`, `showCreateDocOverlay()`, `showFolderPicker()` — force folder selection |
| `Version Description Enforcer` | `initVersionDescriptionEnforcer()`, `attachVersionDescriptionGuard()` — block empty version submits |
| `Workspace protection guard` | `initProtectionGuard()` — enforce owner-only access to protection toggle |

### content.js message types received

| Message type | Handler |
|---|---|
| `scan-tab-folders` | Trigger `scanTabFolders()` |
| `folder-creation-progress` / `folder-creation-done` | Update folder overlay progress |
| `show-merge-owner-popup` | Show `showMergeOwnerOverlay()` |
| `unpack-progress` / `unpack-done` | Update unpack toast |
| `tab-sort-progress` / `tab-sort-done` | Update sort toast |
| `interference-progress` / `interference-done` | Update interference toast |
| `setup-new-doc-progress` / `setup-new-doc-done` | Update new-doc setup toast |
| `generate-folders` | Trigger folder creation from overlay confirm |
| `cdp-overlay-show` / `cdp-overlay-hide` | Show/hide CDP overlay |
| `spa-navigated` | Re-run `runOnDocLoad()` on URL change |

---

## popup.js — sections

| Section header | What lives there |
|---|---|
| `Section navigation` | `showSection()`, all nav button listeners |
| `Load saved config` / `Save config on change` | Persist popup settings to storage |
| `Status display` | `showStatus()`, `hideStatus()` |
| `Drawing Creator` | `appendDrawLog()`, `showPartSelection()`, `updateSelectAll()`, draw button listeners |
| `Listen for messages from background.js` | Receives draw log updates, progress events |
| `Load last scan result` | `loadLastScanForCurrentDoc()` |
| `Scan This Doc` | Manual rescan button listener |
| `Results display` | `showSingleResult()`, `validateFolders()` |
| `Violations display` | `loadViolations()` |
| `Merge Permissions display + edit` | `loadMergePermissions()`, save button listener |

---

## onshape-assistant-sync/src/index.js — Cloudflare Worker

Routes (all require `X-API-Key: artila-onshape-sync-2026`):

| Route | Method | Purpose |
|---|---|---|
| `/permissions/:docId` | GET | Fetch merge owners for a doc |
| `/permissions/:docId` | POST | Save merge owners for a doc |
| `/permissions` | GET | List all docs with permissions |

KV namespace: `PERMISSIONS` — key = docId, value = JSON array of owner emails.

---

## publish.py — functions

| Function | Purpose |
|---|---|
| `read_manifest()` / `write_manifest()` | Parse/write extension/manifest.json |
| `bump_version()` | Increment patch version string |
| `update_updates_xml()` | Patch version + URL in updates.xml |
| `pack_crx()` | Shell out to `chrome.exe --pack-extension` |
| `git_commit_and_push()` | Commit + push to dev |
| `create_github_release()` | `gh release create` with .crx asset |
| `main()` | Orchestrates full release flow |

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

**Never comment out the kill switch block.** Commenting only `BLOCKED_EMAILS` causes a `ReferenceError` (functions still reference it). Commenting the whole block means the functions disappear — a dev→main merge then silently removes all kill switch protection.

Control the kill switch by changing only the **array content**:

```js
// dev branch — kill switch active but blocks nobody:
const BLOCKED_EMAILS = [];

// main branch — kill switch active and blocking:
const BLOCKED_EMAILS = ["kevin@10xconstruction.ai", "kevin@origin.tech"];
```

- **`dev` branch**: `BLOCKED_EMAILS = []` — all functions uncommented and active
- **`main` branch**: `BLOCKED_EMAILS = [emails...]` — all functions uncommented and active
- `publish.py` will abort the release if `BLOCKED_EMAILS` is empty (safety guard)

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

Identify active agents by reading each pane's `/status` output — do not assume which panes are occupied.

### Role assignment sequence

Once the monitor is open, run this automatically — no prompting needed:

1. **Map panes to agents** — send `/status` to each pane, parse the `Email:` line, build a pane-index→agent-name table
2. Select the agents with lowest usage for tasks

Constraints:
- Edit [FILE] only — no other files
- MV3: no inline onclick, always addEventListener
- Auth: session cookies only, never API keys
- DOM selectors: never guess — observe first
- Do not commit — planner handles git
- Only communicate with the planner — never contact other agents directly
- When you finish a task, ALWAYS run: bash ~/tell.sh planner "done: [file] — [brief summary]"
```


Rules for service worker testing:
- Never guess selectors — always provide a command to observe first
- All commands are for the Chrome service worker console at chrome://extensions → service worker → console
- **Every generated command MUST be written to /mnt/c/Users/kevin/Desktop/OnshapeTools/observer-commands.txt** — prepend it at the top of the file (keep existing content below). Never only reply with it in chat.
- Do not edit files other than observer-commands.txt. Do not commit.
- Only communicate with the planner — never contact other agents directly
- When you finish a task or have findings ready, ALWAYS run: bash ~/tell.sh planner "your findings here"
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

---

## Commands

```bash
python3 publish.py   # bump version, pack CRX, push, create GitHub release
```

**Post-release check — run after every publish.py:**
```bash
git show main:updates-firefox.json   # must show the new version number
```
If it still shows the old version, the dev→main merge was skipped (publish.py exits early if Firefox signing fails). Fix manually:
```bash
git checkout main && git merge dev --no-edit && git push origin main && git checkout dev
```

## Service worker testing (sw-relay)

Run arbitrary JS in the Chrome extension service worker from WSL — no manual console needed.

**Setup:**
1. Launch Chrome: `powershell.exe -File /mnt/c/Users/kevin/Desktop/chrome-debug.ps1` — then load the unpacked extension manually
2. `python3 ~/sw-relay.py` — connects to Chrome CDP at localhost:9223, listens on ws://localhost:9300/cmd
3. `python3 ~/sw-exec.py "<js expression>"` — sends expression, prints result

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

- Company ID: `6810c247e7c40668c32816a6`
- `filter=6` for documents by owner (`filter=7` = label filter, wrong)
- `globaltreenodes/folder/{COMPANY_ID}` returns 403 on Pro — use `parentId` from docs + `GET /api/v10/folders/{fid}`