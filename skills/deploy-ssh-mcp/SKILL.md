---
name: deploy-ssh-mcp
description: "Use this skill when deploying, reinstalling, or migrating the mcp-ssh-pty HTTP daemon on a mac (or swapping between multiple macs), or when onboarding a new mac as the ssh-mac MCP control plane for VPS-side Claude Code. Triggers: 'setup mcp-ssh-pty on mac', 'new mac for ssh-mac', 'switch mac', 'migrate mac mcp', 'mac mcp failed', 'ssh-mac connect local broken', 'VSCode grabbed port 27777', 'launchd mcp EADDRINUSE', or any request to make the VPS Claude Code reach back into a mac's internal network via the HTTP-transport MCP."
---

# Deploy ssh-mac MCP on a mac

## Architecture recap

Claude Code runs on VPS only. Mac is the control plane for home/office LAN.

```
VPS (Claude Code)                           mac (daemon)
  │                                          │
  │ claude mcp add ssh-mac http://127:27777  │
  │                                          │
  │ HTTP POST /mcp ─────────┐                │
  │                         ▼                ▼
  │       VPS:127.0.0.1:27777 ◄─── reverse tunnel ──► mac:127.0.0.1:27777
  │                                          │       (mcp-ssh-pty daemon)
  │                                          │
  │                                          ├─ ssh 127.0.0.1 (loopback, real PTY)
  │                                          ├─ ssh 0.2 / 239 / ...  (LAN)
  │                                          └─ ssh VIRCS (back to VPS)
```

**Why this setup**: mac is closer to LAN targets than VPS; cross-LAN file transfer stays one hop; VPS keeps stdio `ssh` MCP only for project-scope debugging of this repo.

## Critical constants

| | value | where |
|---|---|---|
| Port | `27777` | plist, ssh config, VPS mcp registration — all three must match |
| Token | Same secret on both ends | `~/.mori/ssh/http-token` (mac) + `Authorization: Bearer <token>` (VPS mcp) |
| VSCode port conflict | Handled in plist wrapper | plist auto-kills `Code Helper`/Electron when it grabs 27777 |

## Full deployment on a new mac

Run `scripts/mac-deploy.sh` from this repo. It covers all steps below. Manual recipe:

### 1. Install runtime

```bash
npm i -g @mori-mori/mcp-ssh-pty   # needs ≥ 2.2.0
```

Confirm version:

```bash
cat "$(npm root -g)/@mori-mori/mcp-ssh-pty/package.json" | grep version
```

### 2. Token

```bash
mkdir -p ~/.mori/ssh
echo '<YOUR_TOKEN_HERE>' > ~/.mori/ssh/http-token   # 与 VPS 侧 claude mcp add 的 Bearer 值保持一致
chmod 600 ~/.mori/ssh/http-token
```

### 3. SSH loopback (required for `connect local`)

mac's HTTP daemon runs under launchd → no TTY → node-pty fails. v2.2.0+ transparently falls back to ssh-to-self via sshd. Needs:

```bash
# a. mac sshd running (System Settings → General → Sharing → Remote Login: ON)
# b. allowed users includes current user (same settings page)
# c. self pub key in authorized_keys
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Verify:
ssh -o BatchMode=yes $USER@127.0.0.1 'echo ok'
```

### 4. SSH config on mac (reverse tunnel to VPS)

Add under `Host vircs` block in `~/.ssh/config`:

```
RemoteForward 2222  localhost:22
RemoteForward 27777 localhost:27777
```

(`9022` for company Git is unrelated but usually coexists.)

### 5. ssh-servers.json (what mac daemon knows)

`~/.mori/ssh/ssh-servers.json` — must include a `VIRCS` entry for VPS, plus any LAN targets. Add `globalHints` at top explaining when to prefer this MCP.

### 6. launchd plist with auto-kill wrapper

**Critical**: VSCode Remote-SSH grabs random high ports including 27777 on start. Naive plist → daemon loses race → EADDRINUSE. Fix: wrapper script checks `lsof -tiTCP:27777`, if owner is Code Helper / Electron → kill it → exec daemon.

Template lives at `templates/com.mori.mcp-ssh-pty-http.plist` in this repo. **Node path (`v24.13.0` vs `v22.18.0`) must match host's nvm install** — the script handles this.

```bash
launchctl load ~/Library/LaunchAgents/com.mori.mcp-ssh-pty-http.plist
launchctl list | grep mcp-ssh   # pid non-zero + exit=0 = healthy
```

### 7. Bring up reverse tunnel

Either `ssh -fN vircs` (explicit) or let VSCode Remote-SSH maintain the session. Verify from VPS:

```bash
ss -tlnp | grep :27777
curl -sS http://127.0.0.1:27777/health
```

## Swap macs (mac1 offline → mac2 online)

Same port 27777 is used; only one mac binds reverse tunnel at a time. No VPS-side change needed.

1. mac1 sleep/shutdown → VPS:127.0.0.1:27777 released
2. mac2 boots → launchd auto-loads plist → daemon listening on mac2:27777
3. mac2's ssh vircs re-establishes reverse tunnel (VSCode reconnect or `ssh -fN vircs`) → VPS:27777 → mac2:27777
4. VPS Claude Code's `ssh-mac` MCP now transparently operates on mac2

## Migrating old mac1 to v2.2.0 + auto-kill plist

Copy `scripts/migrate-mac1.sh` to mac1 and run it. It:
- Upgrades mcp-ssh-pty to latest
- Adds self pub key to authorized_keys (for SSH loopback)
- Rewrites plist with auto-kill wrapper (keeping mac1-specific node path)
- Reloads launchd
- Verifies daemon is listening

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ssh-mac: ✗ Failed to connect` | tunnel missing or daemon dead | `ss -tlnp \| grep 27777` on VPS; if empty → mac reconnect; if listening → check daemon on mac |
| `EADDRINUSE 27777` in mcp-http.err | VSCode grabbed port before daemon | ensure plist wrapper is the auto-kill version; `launchctl kickstart -k gui/$(id -u)/com.mori.mcp-ssh-pty-http` |
| `connect local` → `posix_spawnp failed` | pre-2.2.0 version, no loopback fallback | upgrade npm package |
| `connect local` → ECONNRESET | sshd rejected loopback auth | add self pub key to authorized_keys; chmod 600 |
| `connect mac` from VPS → ECONNRESET | mac sshd not running / user not allowed | System Settings → Sharing → Remote Login ON, allow your user |
| hints in config not showing | ConfigManager caches on startup | `launchctl kickstart -k gui/$(id -u)/com.mori.mcp-ssh-pty-http` |

## When updating hints / server list

```bash
# edit ~/.mori/ssh/ssh-servers.json
launchctl kickstart -k gui/$(id -u)/com.mori.mcp-ssh-pty-http   # reload
```

Note: this kills active MCP sessions — Claude Code HTTP client will reconnect automatically on next tool call, but the tool schema in any already-running session won't refresh until session restart.
