# Claude Code Multi-Device Setup — Complete Guide
*Let your Claude Code coordinate and run Claude Code on multiple devices simultaneously*

---

## What This Sets Up

- Your Claude Code (on your device) can SSH into any remote device and run Claude Code there as a subagent
- You give one high-level instruction and your Claude Code handles execution across all machines
- tmux keeps remote sessions alive even if your connection drops — reconnect and pick up where you left off
- Remote Claude Code pushes changes to GitHub under their own account, with branch protection keeping main safe

### How It Works

```
Your device
  |-- Claude Code (yours, in WSL)
        |-- SSHes into Remote user's device
        |     -> reads/writes to their tmux session
        |     -> runs Claude Code there as subagent
        |-- SSHes into Device 3
        |     -> runs Claude Code there as subagent
        |-- Coordinates everything from your single terminal
```

### How Claude Reads and Writes to Remote Tmux

Claude never "attaches" to the remote tmux session visually. Instead it uses two commands over SSH:

```bash
# READ (see what's on screen):
ssh user@IP "wsl tmux capture-pane -t shared -p"

# WRITE (send keystrokes):
ssh user@IP "wsl tmux send-keys -t shared 'your text' Enter"
```

This means Claude can operate the remote Claude Code session invisibly while you watch it in your own tmux window.

---

## Location Key

Every code block is labeled with one of these:

| Label | Meaning |
|---|---|
| `[YOUR WSL]` | Ubuntu/WSL on your device |
| `[REMOTE PowerShell]` | PowerShell as Admin on the remote device |
| `[REMOTE WSL]` | Ubuntu/WSL on the remote device (after WSL is installed) |
| `[GITHUB.COM]` | Action taken in the browser |

> **Steps and sub-steps written in italics must be repeated for every new person you add.**
> Steps in normal text are one-time setup on your own device only.

---

## Important: Windows Paths Inside WSL

WSL has its own filesystem separate from Windows. To access Windows files from WSL, replace `C:\` with `/mnt/c/`

```
Windows:  C:\Users\YOUR_USERNAME\Desktop\MyProject
WSL:      /mnt/c/Users/YOUR_USERNAME/Desktop/MyProject
```

```bash
# [YOUR WSL]
cd /mnt/c/Users/YOUR_USERNAME/Desktop/MyProject
```

---

## Important: Windows Remote Shell Requires "wsl" Prefix

When you SSH into a Windows machine, the default shell is Windows CMD — not bash. Every Linux command must be prefixed with `wsl` to run inside their WSL environment.

```bash
# WRONG:
ssh user@IP "tmux ls"

# CORRECT:
ssh user@IP "wsl tmux ls"
```

Commands that look like they're failing on a Windows remote are usually just missing the `wsl` prefix.

---

## Important: Quote Escaping on Windows Remotes

Nested quotes break when passed through Windows CMD. If you need to run a complex command on a Windows remote, pipe it via stdin instead — this bypasses all quoting issues:

```bash
echo 'your complex command here' | ssh user@IP "wsl bash"
```

This is also how Claude runs multi-part commands on Windows remotes without quoting errors.

---

## Daily Login — What To Do Each Session

Once everything is set up, this is all you need each session.

**Your device:**

1. Open Ubuntu (WSL) from Start menu
2. Navigate to your project if needed:
   ```bash
   cd /mnt/c/Users/YOUR_USERNAME/Desktop/YourProject
   ```
3. Launch Claude Code:
   ```bash
   claude
   ```
4. Claude Code logs you in automatically. If it asks you to log in again:
   ```bash
   claude auth login
   ```

**Remote device — reconnecting to an existing session:**

Everything is done from YOUR device over SSH. You never need physical access to the remote after initial setup.

```bash
# [YOUR WSL]
ssh username@REMOTE_IP    # connects to remote Windows shell
wsl                       # drops into their WSL
tmux attach -t shared     # reconnects to the session
```

The session stays alive on their machine even if you close your terminal. Claude Code, git auth, everything is still there exactly as you left it.

If the session is gone (their device restarted):

```bash
# [YOUR WSL]
ssh username@REMOTE_IP
wsl
tmux new -s shared -d
tmux attach -t shared
claude                    # relaunch Claude Code inside the session
```

---

## Adding a New Person To the Setup

The instructions are exactly the same for every new person you add. For each new device:

1. *Complete Steps 1–5 for their device (SSH, WSL, tmux)*
2. *Complete Steps 6–9 on their device (Node.js, npm globals, Claude Code, authentication)*
3. *Complete Step 11 to set up their GitHub access*
4. On YOUR device, run Step 10 again — just the `ssh-manager server add` part:
   ```bash
   # [YOUR WSL]
   ssh-manager server add
   ```
   Fill in their details (name, IP, username, key path).
5. Verify they appear:
   ```bash
   ssh-manager server list
   ```

Steps 0, 2, 7, 8, and the MCP install part of Step 10 are **one-time only** on your device — never repeated for new people.

---

## Step 0 — Your Device: Install WSL

> *One-time setup on your device only. Skip if already on Linux or macOS.*

```powershell
# [YOUR PowerShell as Admin]
wsl --install
```

Restart your PC. After restart, open the Ubuntu app from your Start menu and complete setup (create a Linux username and password). Use Ubuntu as your terminal for everything from here on — not PowerShell or CMD.

---

## *Step 1 — Remote Devices: Disable Sleep + Enable SSH*

### *1A — Disable Sleep*

SSH requires the remote device to be powered on and connected to the network. Sleep and hibernate both cut network connectivity and will drop the SSH connection. **Screen/monitor sleep is fine — only PC sleep needs to be disabled.**

**Windows:**
```
Settings -> System -> Power & Sleep -> Sleep -> Never
```

**macOS:**
```
System Settings -> Battery -> Prevent automatic sleeping when display is off -> ON
```

**Linux:**
```bash
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

### *1B — Enable SSH*

**If the remote device is Windows:**

```powershell
# [REMOTE PowerShell as Admin]
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

> **RESTART THE REMOTE PC** — Windows requires this before SSH becomes available.

After restart:

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType 'Automatic'
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
Get-Service sshd       # should show Status: Running
```

**If the remote device is Linux:**

```bash
# [REMOTE terminal]
sudo apt update && sudo apt install openssh-server -y
sudo systemctl enable ssh && sudo systemctl start ssh
```

**If the remote device is macOS:**

```
[REMOTE device — System Settings]
System Settings -> General -> Sharing -> Remote Login -> ON
```

**Get the remote device's IP and username:**

```powershell
# [REMOTE PowerShell]  (Windows remote)
ipconfig             # look for IPv4 Address under Wi-Fi or Ethernet. Ignore 169.254.x.x
echo $env:USERNAME
```

```bash
# [REMOTE terminal]  (Linux/macOS remote)
hostname -I
whoami
```

---

## Step 2 — Your Device: Generate SSH Key

> *One-time setup on your device only. Skip if you already have `~/.ssh/id_ed25519`.*

```bash
# [YOUR WSL]
# Press Enter at every prompt — do not type a custom filename.
ssh-keygen -t ed25519 -C "my-terminal-key"
```

You should see:
```
Your identification has been saved in ~/.ssh/id_ed25519
Your public key has been saved in ~/.ssh/id_ed25519.pub
```

```bash
ls ~/.ssh/    # should show id_ed25519 and id_ed25519.pub
```

---

## *Step 3 — Copy Your Key To Each Remote Device*

**If the remote device is Linux or macOS:**

```bash
# [YOUR WSL]
ssh-copy-id username@IP_ADDRESS
# asks for their password once, never again
```

**If the remote device is Windows:**

Windows SSH for admin accounts uses a special key location. This is why password auth and standard key setup both fail on Windows.

*Part A — Get your public key:*

```bash
# [YOUR WSL]
cat ~/.ssh/id_ed25519.pub
```

Copy the entire output (one long line starting with `ssh-ed25519`) and send it to the remote user.

*Part B — Add key to the remote device:*

```powershell
# [REMOTE PowerShell as Admin]
New-Item -ItemType Directory -Force -Path "C:\ProgramData\ssh"
New-Item -ItemType File -Force -Path "C:\ProgramData\ssh\administrators_authorized_keys"
notepad "C:\ProgramData\ssh\administrators_authorized_keys"
# Paste the public key in Notepad, save and close
icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "SYSTEM:(F)" /grant "Administrators:(F)"
Restart-Service sshd
```

*Test connection — should connect with no password:*

```bash
# [YOUR WSL]
ssh username@IP_ADDRESS
```

---

## *Step 4 — Remote Devices: Install WSL (Windows Only)*

```powershell
# [REMOTE PowerShell as Admin]  (can run while SSHed in)
wsl --install
```

> **THE REMOTE DEVICE MUST RESTART.**
> After restart, the remote user must open the Ubuntu app on their own device and complete WSL setup (create a Linux username and password). **This is the only step that cannot be done over SSH — they must do it locally once.**

Once WSL is set up, SSH back in:

```bash
# [YOUR WSL]
ssh username@IP
wsl
# You are now inside their WSL environment
```

---

## *Step 5 — Remote Devices: Install Tmux + Start Session*

```bash
# [REMOTE WSL]  (after: ssh username@IP, then: wsl)
sudo apt install tmux -y
tmux new -s shared -d      # starts session in background
tmux ls                    # verify: shows "shared: 1 windows"
tmux attach -t shared      # attach to work inside it
```

To detach without closing: press `Ctrl+B` then `D`. The session keeps running on their machine.

**To reconnect after a dropped connection:**

```bash
# [YOUR WSL]
ssh username@IP
wsl
tmux attach -t shared      # picks up exactly where you left off
```

---

## Step 6 — All Devices: Install Node.js

**Your device** *(one-time)*:

```bash
# [YOUR WSL]
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

*Each remote device* *(repeat for every new person)*:

```bash
# [REMOTE WSL]  (inside the tmux session)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

---

## Step 7 — All Devices: Configure npm Globals

Prevents permission errors when installing global packages.

**Your device** *(one-time)*:

```bash
# [YOUR WSL]
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$PATH:~/.npm-global/bin"' >> ~/.bashrc
source ~/.bashrc
```

*Each remote device* *(repeat for every new person)*:

```bash
# [REMOTE WSL]  (inside the tmux session)
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$PATH:~/.npm-global/bin"' >> ~/.bashrc
source ~/.bashrc
```

---

## Step 8 — All Devices: Install Claude Code

**Your device** *(one-time)*:

```bash
# [YOUR WSL]
npm install -g @anthropic-ai/claude-code
claude --version    # verify
```

*Each remote device* *(repeat for every new person)*:

```bash
# [REMOTE WSL]  (inside the tmux session)
npm install -g @anthropic-ai/claude-code
claude --version    # verify
```

---

## Step 9 — All Devices: Authenticate Claude Code

**Your device** *(one-time)*:

```bash
# [YOUR WSL]
claude
# On first run it asks you to log in. Follow the browser prompt or enter your API key.
# Once logged in, type: /exit
```

*Each remote device* *(repeat for every new person)*:

```bash
# [REMOTE WSL]  (inside the tmux session)
claude
# The remote user logs in with their own Anthropic account (Team, Pro, Max, or API billing).
# Do NOT share accounts. Once logged in, type: /exit
```

After first login, credentials are saved automatically. You will not need to log in again unless the device is reset or credentials are cleared.

> **Note:** If Claude Code says "out of usage", the account's daily limit is hit. It resets at 4pm UTC. This is expected — when one account is out, the other keeps working.

---

## Step 10 — Your Device: Install MCP SSH Manager

**Install once on your device:**

```bash
# [YOUR WSL]
npm install -g mcp-ssh-manager
sudo apt install -y jq sshpass        # removes warnings
claude mcp add ssh-manager --scope user -- npx mcp-ssh-manager
claude mcp list    # should show ssh-manager with checkmark
```

*Add each remote device (repeat for every new person)*:

```bash
ssh-manager server add
```

*Fill in the prompts:*
```
Server name:  username         <- label, no spaces
Hostname/IP:  REMOTE_IP
Port:         22               <- press Enter for default
Username:     username
Auth type:    key
Key path:     ~/.ssh/id_ed25519
```

*Verify:*
```bash
ssh-manager server list
```

> **Note:** The MCP SSH tool can be unreliable on Windows remotes due to how it handles command timeouts internally. If commands are failing or returning Windows TIMEOUT errors, fall back to direct SSH:
> ```bash
> ssh user@IP "wsl your-command-here"
> ```
> This is more reliable for Windows remotes and is what Claude will use automatically when the MCP tool misbehaves.

---

## *Step 11 — Remote Devices: Set Up GitHub Access*

*This step sets up the remote device so it can push code to your GitHub repo under the remote user's own GitHub account. Do this AFTER Step 9.*

### *11A — Choose a Safe Working Folder*

*Do NOT use a folder inside OneDrive or Windows Documents. Use the WSL home directory instead — it is on the WSL virtual disk and completely separate from OneDrive.*

*Verify the remote user's home is on the WSL disk:*

```bash
# [YOUR WSL]
ssh username@REMOTE_IP "wsl df -h /home/username"
```

*The filesystem should show `/dev/sdd` or similar (the WSL virtual disk). If it shows `drvfs` or a `C:` path, you are in a Windows-mounted folder — use `~/ProjectName` instead.*

*Create the project folder:*

```bash
# [YOUR WSL]
ssh username@REMOTE_IP "wsl mkdir ~/YourProjectName"
```

### *11B — Clone the Repo*

```bash
# [YOUR WSL]
ssh username@REMOTE_IP "wsl git clone https://github.com/YOUR_ORG/YOUR_REPO.git /home/username/YourProjectName"

# Verify:
ssh username@REMOTE_IP "wsl ls /home/username/YourProjectName"
```

### *11C — Set Up Passwordless Sudo*

*Required so Claude can run installs on the remote without needing an interactive password prompt.*

*Check the remote user is in the sudo group:*

```bash
# [YOUR WSL]
ssh username@REMOTE_IP "wsl groups username"
# Should include "sudo" in the list
```

*Enable passwordless sudo (pipe via stdin to avoid quoting issues):*

```bash
# [YOUR WSL]
echo 'echo "username ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/username-nopasswd' | ssh username@REMOTE_IP "wsl bash"
```

*If that fails (sudo still needs a password), do it interactively from inside the shared tmux session:*

1. *Attach to the session: `tmux attach -t shared`*
2. *Open a second window: `Ctrl+B` then `C`*
   *(or Claude can create one remotely: `ssh username@IP "wsl tmux new-window -t shared"`)*
3. *In window 1, run:*
   ```bash
   echo "username ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/username-nopasswd
   ```
4. *Type the password when prompted*
5. *Switch back to window 0: `Ctrl+B` then `0`*

### *11D — Add Remote User as GitHub Collaborator*

*The remote user needs their own GitHub account. They push under their own identity — not yours.*

```
[GITHUB.COM]
github.com/YOUR_ORG/YOUR_REPO
-> Settings -> Collaborators -> Add people -> enter their GitHub username
-> Set permission: Write
```

*They will receive an email invitation. They must accept it.*

### *11E — Install gh CLI on the Remote Device*

*gh is not installed by default. Install via the official GitHub repo (the Ubuntu default repo can fail due to mirror sync issues):*

```bash
# [YOUR WSL]
cat << 'EOF' | ssh username@REMOTE_IP "wsl bash"
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh -y
EOF

# Verify:
ssh username@REMOTE_IP "wsl gh --version"
```

### *11F — Authenticate gh on the Remote Device*

*This must be done interactively. Claude can run the command but you must enter the code in a browser.*

*From inside the shared tmux session (window 1 — the plain bash shell), run:*

```bash
gh auth login --web -h github.com
# Select: HTTPS
# Authenticate Git with your GitHub credentials: Y
```

*A one-time code appears (e.g. `EF0F-8F21`). Open `github.com/login/device` in your browser NOW and enter the code. After entering in the browser, press Enter in the terminal to complete.*

> **Important:** Have the browser tab open at `github.com/login/device` before you start. If you wait too long, the code expires and you must start over.

*Verify:*

```bash
# [YOUR WSL]
ssh username@REMOTE_IP "wsl gh auth status"
# Should show: Logged in as theirusername
```

### 11G — Set Up gh on Your Own WSL *(optional but useful)*

Lets Claude make GitHub API calls (e.g. setting branch protection) directly from your machine.

```bash
# [YOUR WSL]
sudo apt install gh -y
gh auth login --web -h github.com
# Follow the same browser flow above with your own account

# Verify:
gh auth status
```

### 11H — Protect the Main Branch *(optional)*

Prevents remote users from pushing directly to main. They must open a PR that you review and approve. Requires Step 11G above.

```bash
# [YOUR WSL]
gh api repos/YOUR_ORG/YOUR_REPO/branches/main/protection \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null
}
EOF
```

> **Note:** User/team restrictions on branch protection are only available for organization repos, not personal repos. The PR requirement applies to everyone including you, but as repo admin you can bypass it when needed.

---

## Step 12 — Start Using It

Open two terminal windows:
- **Window 1** — your WSL, your Claude Code
- **Window 2** — SSHed into the remote's tmux session *(optional, for watching their side)*

```bash
# [YOUR WSL]  -- Window 1
cd /mnt/c/Users/YOUR_USERNAME/Desktop/YourProject   # if needed
claude
```

**Example instructions to give Claude Code:**

- *"List all my SSH servers"*
- *"SSH into username's machine and run Claude Code there to set up the backend"*
- *"On username's device, go to ~/project and run Claude Code to write unit tests for auth.js"*
- *"Set up the backend on username's machine and the frontend on mine, make sure they connect"*

Your Claude Code handles the SSH, launches Claude Code on their machine as a subagent, gives it the task, and reports back — all from your single terminal.

**How task splitting works in practice:**

You create plans and coordinate from your device. Claude splits implementation work between your device and the remote, running tasks in parallel on both. When the remote Claude finishes, it pushes to a branch. You review and merge the PR.

When one account hits its daily usage limit, all work continues on the other device. This is the core benefit of the multi-device setup.

---

## Useful Tmux Commands

| Command | What it does |
|---|---|
| `tmux new -s shared` | Start a new session |
| `tmux new -s shared -d` | Start in background |
| `tmux attach -t shared` | Attach to session |
| `tmux ls` | List sessions |
| `Ctrl+B then D` | Detach (keeps session running) |
| `Ctrl+B then C` | New window |
| `Ctrl+B then 0` | Switch to window 0 |
| `Ctrl+B then 1` | Switch to window 1 |
| `Ctrl+B then [` | Scroll mode (arrow keys, Q to exit) |
| `exit` | Close current window |

**Create a new tmux window remotely (without attaching):**

```bash
# [YOUR WSL]
ssh username@IP "wsl tmux new-window -t shared"
```

---

## Troubleshooting

**T1 — SSH install on Windows says RestartNeeded: True**

Normal — Windows requires reboot after installing OpenSSH. After restarting:
```powershell
Start-Service sshd
```

---

**T2 — "Connection refused" when SSHing in**

1. SSH not running: `Get-Service sshd` — if not running: `Start-Service sshd`
2. Wrong IP — recheck with `ipconfig` on the remote device. IPs change when reconnecting to WiFi.
3. Firewall blocking port 22 — run firewall command from Step 1.

---

**T3 — Ping times out**

Normal on Windows. Windows blocks ping but SSH works fine. Don't use ping to test. Use instead:
```bash
# [YOUR WSL]
ssh -v username@IP    # shows exactly what's happening
```

---

**T4 — Password auth failing on Windows**

Skip passwords entirely. Use SSH key auth from Step 3. The `administrators_authorized_keys` location and the `icacls` permissions command are both required — most guides miss these.

---

**T5 — "No identities found" when running ssh-copy-id**

You are likely running from PowerShell instead of WSL. Switch to WSL and check:
```bash
ls ~/.ssh/    # should show id_ed25519 and id_ed25519.pub
```
If empty, go back to Step 2 and regenerate from WSL.

---

**T6 — npm permission error (EACCES) when installing packages**

Go back to Step 7 and configure npm globals first, then retry the install.

---

**T7 — `claude: node not found` after installing Claude Code**

Node.js not installed or not in PATH. Go back to Step 6 and install using the nodesource script. Do not use `apt install nodejs` alone — it installs an outdated version.

---

**T8 — `ssh-manager` command not found after install**

```bash
echo 'export PATH="$PATH:$(npm config get prefix)/bin"' >> ~/.bashrc
source ~/.bashrc
```

---

**T9 — tmux session not found after reconnecting**

Remote device likely restarted, killing the tmux session. Start a fresh one:
```bash
ssh username@IP
wsl
tmux new -s shared -d
tmux attach -t shared
```

---

**T10 — Devices on different networks**

Local IPs only work on the same network. For devices on different networks, install Tailscale:
```bash
# [YOUR WSL] and [REMOTE WSL]
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Windows/macOS: download from tailscale.com instead. Each device gets a permanent `100.x.x.x` IP that works from anywhere. Use that instead of local IPs everywhere in this guide.

---

**T11 — Terminal shows green text / random number strings when typing**

Bracketed paste mode mismatch between your terminal emulator and tmux. Fix it:
```bash
printf '\e[?2004l'
```
Or close the terminal and reconnect: `ssh username@IP` → `wsl` → `tmux attach -t shared`. A fresh connection usually clears it.

---

**T12 — gh auth code expires before completion**

The device code is valid for ~15 minutes. Just run `gh auth login` again — a new code is generated each time. Have the browser tab open at `github.com/login/device` before you start so you can enter the code immediately.

---

**T13 — "sudo: a terminal is required" on remote**

Claude cannot run interactive sudo commands over SSH. Either:
- A) Set up passwordless sudo first (Step 11C)
- B) Run the command yourself inside the shared tmux session using the `!` prefix in Claude Code:
  ```
  ! sudo your-command-here
  ```

---

**T14 — MCP SSH manager returns Windows TIMEOUT errors**

The mcp-ssh-manager tool uses a Windows TIMEOUT wrapper internally which can cause spurious errors on Windows remotes. Fall back to direct SSH:
```bash
ssh user@IP "wsl your-command-here"
```
This is more reliable and is what Claude will use automatically when the MCP tool misbehaves.

---

**T15 — `wsl` opens Docker Desktop instead of Ubuntu**

Running plain `wsl` defaults to whichever distro is set as default. Fix:
```bash
wsl -d Ubuntu

# To check available distros:
wsl -l

# To set Ubuntu as default:
wsl --set-default Ubuntu
```
