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
generate_admin_guide.py       — PDF guide generator (FPDF)
onshape-assistant-sync/
  src/index.js                — Cloudflare Worker: KV-backed merge permissions API
  wrangler.toml               — Worker config
updates.xml                   — Auto-update manifest (Chrome polls this for new .crx)
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
| `QC Note placement` | `placeQcNotes()` — CDP: place annotation notes on drawings |
| `QC Point recording` | `startQcRecording()` — captures click coords for QC notes |
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
| `start-qc-recording` | Start QC coordinate capture |
| `delete-qc-point` / `toggle-qc-point` / `clear-qc-points` | QC point management |
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

After Kevin approves a plan:
- Identify all files that need editing
- Select up to 3 remote devices at random from the connected device list
- Distribute files across those devices — no two devices may edit the same file, but one device may edit multiple files
- Assign each device its files and run the edits in parallel
- Each device pushes its changes to a shared feature branch and opens a single PR
- Kevin reviews and merges

Example: plan touches background.js, content.js, popup.js → device A gets background.js, device B gets content.js + popup.js (or split across 3 if 3 devices available)

**Chrome + Firefox parity:** Every code change must be applied to both extensions. Since the Firefox build is generated from `extension/` via `build-firefox.py`, changes to `extension/` files automatically flow to Firefox. However, always check whether the change involves any CDP/HAS_DEBUGGER logic that needs Firefox-specific handling. When 2 remotes are available, prefer assigning one remote per browser concern:
- One remote handles `extension/` file edits (Chrome)
- The other handles any Firefox-specific follow-up (build-firefox.py, updates-firefox.json, HAS_DEBUGGER guards)

**Usage monitoring:** After assigning a task to a remote device, periodically check its `capture-pane` output for "out of usage". If detected:
- Mark that device as exhausted
- Reassign its remaining incomplete files to one of the other active devices
- Continue without interrupting Kevin unless all devices are exhausted

---

## Remote device connections (Rohit + any future remotes)

When asked to connect to a remote device or start a session on one:

1. Create the tmux session with a keepalive window to prevent WSL from shutting down:
   ```bash
   ssh user@IP "wsl tmux new-session -d -s shared"
   ssh user@IP "wsl tmux new-window -t shared"
   ssh user@IP "wsl tmux send-keys -t shared:1 'tail -f /dev/null' Enter"
   ```
2. Launch Claude with `--dangerously-skip-permissions` in window 0:
   ```bash
   ssh user@IP "wsl tmux send-keys -t shared:0 'cd ~/OnshapeTools && claude --dangerously-skip-permissions' Enter"
   ```
3. Always use `ssh user@IP "wsl tmux ..."` — never attach interactively
4. Read the session with `capture-pane -t shared:0 -p`, write with `send-keys -t shared:0`
5. If the tmux socket is missing (`No such file or directory`), WSL shut down — recreate from step 1

Rohit's machine: `rohit@10.30.3.8`

---

## Multi-agent workflow

### Role assignment sequence

Once the monitor is open, run this automatically — no prompting needed:

1. **Map panes to agents** — send `/status` to each pane, parse the `Email:` line, build a pane-index→agent-name table
2. **Randomly shuffle** the active agents
3. **Assign roles:**
   - Agents 1–3: Chrome editors — assign `background.js`, `content.js`, `popup.js` one each (random)
   - Agent 4: Firefox editor
   - Agent 5: Service worker specialist
   - Agent 6: Reviewer — receives the same three files as the Chrome editors
4. **Send each agent their briefing** (templates below) via `tmux send-keys -t claude-monitor:0.N`
5. **Poll for acknowledgement** — read each pane until you see their ack string
6. **Report to Kevin:** table of agent → role → assigned file

### Chrome editor briefing

Send to each of the 3 Chrome editors (substitute `[FILE]`):

```
You are a Chrome extension file editor for this session. You are NOT the planner.
Assigned file: [FILE]

Do these steps now, in order:
1. Read CLAUDE.md at /mnt/c/Users/kevin/Desktop/OnshapeTools/CLAUDE.md in full
2. Read extension/[FILE]
3. Reply exactly: "acknowledged: chrome editor for [FILE]" — then wait for your task

Constraints:
- Edit [FILE] only — no other files
- MV3: no inline onclick, always addEventListener
- Auth: session cookies only, never API keys
- DOM selectors: never guess — observe first
- Do not commit — planner handles git
- Only communicate with the planner — never contact other agents directly
- When you finish a task, ALWAYS run: bash ~/tell.sh planner "done: [file] — [brief summary]"
```

### Firefox editor briefing

```
You are the Firefox compatibility editor for this session. You are NOT the planner.

Do these steps now, in order:
1. Read CLAUDE.md at /mnt/c/Users/kevin/Desktop/OnshapeTools/CLAUDE.md in full
2. Reply exactly: "acknowledged: firefox editor" — then wait

When the planner tells you Chrome editors are done, read every file they touched,
then apply Firefox-specific changes (CDP/HAS_DEBUGGER guards, build-firefox.py).

Constraints: only touch build-firefox.py and HAS_DEBUGGER guards. Do not commit.
- When you finish a task, ALWAYS run: bash ~/tell.sh planner "done: firefox — [brief summary]"
```

### Service worker specialist briefing

```
You are the service worker console specialist for this session. You are NOT the planner.

Your two jobs:
1. GENERATE — when the planner or Kevin needs to observe DOM changes or run diagnostics, write the exact chrome.runtime.sendMessage(...) command to paste into the Chrome service worker console, plus what to do manually to trigger the event.
2. INTERPRET — when Kevin pastes raw console output back (DOM mutations, JSON dumps, error traces), parse it and extract the actionable selectors, values, or root causes. Reply with a clean summary: selectors found, what they mean, and what the editor should target.

Do these steps now, in order:
1. Read CLAUDE.md at /mnt/c/Users/kevin/Desktop/OnshapeTools/CLAUDE.md in full
2. Read extension/background.js
3. Reply exactly: "acknowledged: sw specialist" — then wait

Rules:
- Never guess selectors — always provide a command to observe first
- All commands are for the Chrome service worker console at chrome://extensions → service worker → console
- **Every generated command MUST be written to /mnt/c/Users/kevin/Desktop/OnshapeTools/observer-commands.txt** — prepend it at the top of the file (keep existing content below). Never only reply with it in chat.
- Do not edit files other than observer-commands.txt. Do not commit.
- Only communicate with the planner — never contact other agents directly
- When you finish a task or have findings ready, ALWAYS run: bash ~/tell.sh planner "your findings here"
```

### Reviewer briefing

Send to Agent 6:

```
You are the code reviewer for this session. You are NOT the planner.

Do these steps now, in order:
1. Read CLAUDE.md at /mnt/c/Users/kevin/Desktop/OnshapeTools/CLAUDE.md in full
2. Reply exactly: "acknowledged: reviewer" — then wait for tasks

When the planner tells you a task is complete, re-read the affected file and report any issues you notice — bugs, edge cases, broken logic, anything that looks wrong. Keep it short: one line per issue.

Constraints:
- Do not edit any files. Do not commit.
- Only communicate with the planner — never contact other agents directly
- When you have findings ready, ALWAYS run: bash ~/tell.sh planner "review: [brief findings]"
- If you find no issues, still run: bash ~/tell.sh planner "review: all clear"
```

### Usage monitoring

After briefing agents, periodically check panes for "out of usage". If detected:
- Mark that agent exhausted
- Reassign their file to another active Chrome editor
- Notify Kevin only if all agents are exhausted

---

## Hard rules
- **Credentials are hardcoded** in scripts — do not refactor to env vars, unless credentials are unavailable in which case ask and substitute
- After Kevin approves any edit: commit and `git push origin dev` immediately
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
python publish.py   # bump version, pack CRX, push, create GitHub release

## Onshape API notes

- Company ID: `6810c247e7c40668c32816a6`
- `filter=6` for documents by owner (`filter=7` = label filter, wrong)
- `globaltreenodes/folder/{COMPANY_ID}` returns 403 on Pro — use `parentId` from docs + `GET /api/v10/folders/{fid}`