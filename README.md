<!-- Keep in sync with README.zh-CN.md -->
English | [简体中文](./README.zh-CN.md)

# @mori-mori/mcp-ssh-pty

MCP Server for SSH remote command execution. By default, commands run over a headless `exec` channel — one shot in, one result out, each isolated, with the `exitCode` handed straight back, output that needs no cleanup, and no way to wedge the session. For interactive REPLs, TUIs, or anything that has to keep shell state around, switch to `mode:"pty"`: a persistent PTY shell that's created lazily the first time you need it.

## Installation

```bash
npm install -g @mori-mori/mcp-ssh-pty
```

### Start MCP Server

```bash
# stdio mode (default, spawned as a child process by Claude Code)
mcp-ssh-pty

# HTTP mode (runs as a standalone daemon, can be connected to by a remote Claude Code)
mcp-ssh-pty --http --port 7777 --host 127.0.0.1
mcp-ssh-pty --http --port 7777 --host 127.0.0.1 --token <shared-secret>
```

HTTP mode arguments can also be supplied via environment variables: `MCP_HTTP_PORT` / `MCP_HTTP_HOST` / `MCP_HTTP_TOKEN`.

### Add to Claude Code

```bash
# stdio (local)
claude mcp add --transport stdio ssh -- mcp-ssh-pty

# or via npx (no install)
claude mcp add --transport stdio ssh -- npx -y @mori-mori/mcp-ssh-pty

# HTTP (remote or local daemon)
claude mcp add --transport http ssh-remote http://127.0.0.1:7777/mcp
# with Bearer token:
claude mcp add --transport http ssh-remote http://127.0.0.1:7777/mcp \
  --header "Authorization: Bearer <shared-secret>"
```

## Architecture: unified multi-machine management (hub mode)

The typical setup: Claude Code runs only on a VPS, but you want to manage the VPS itself plus several Macs (and each of their LAN machines) at once — while registering just **one** MCP.

The answer is **hub mode**. The same binary plays two roles:

- **Direct mode** (default / `--http`): does the real SSH work (the exec channel by default, PTY when you ask for it). Each Mac runs its own `--http` daemon and exposes it to the VPS over a reverse tunnel.
- **Hub mode** (`--hub`): runs on the VPS and shows Claude a single `ssh`/`sftp`, then routes internally by `node` to each Mac's daemon — so it's an MCP server and a client of every daemon at the same time. The VPS itself joins the hub as an in-process node, so it needs no daemon of its own.

```
Claude Code (VPS)
  └─ one registration: ssh-hub (stdio) → mcp-ssh-pty --hub  → reads ~/.mori/ssh/hub.json
       ├─ in-process direct           → vps          (VPS local shell)
       ├─ http://127.0.0.1:27778/mcp → macbook-air  (office · primary)  ┐ each Mac daemon listens on 27777 locally,
       ├─ http://127.0.0.1:27779/mcp → mac-mini-1   (office · backup)   ┤ reverse tunnels stagger to different VPS ports
       └─ http://127.0.0.1:27780/mcp → mac-mini-2   (home)              ┘ (27777 reserved/empty, hub ports start at 27778)
     ssh({action:"list"}) → probes each node's online status; connect node=macbook-air → routes to that daemon
```

- One registration covers everything, yet each Mac's own daemon still does the work — so you keep **one-hop sftp**, local direct connections, and per-machine notes/shortcuts.
- Each node is an independent downstream connection, so connections (exec channel or PTY) to several Macs can be **alive at the same time**; the hub only routes between them.

Hub config `~/.mori/ssh/hub.json` (see `hub.example.json`):

```json
{ "nodes": [
  { "name": "vps", "local": true },
  { "name": "macbook-air", "url": "http://127.0.0.1:27778/mcp", "token": "..." },
  { "name": "mac-mini-1",  "url": "http://127.0.0.1:27779/mcp", "token": "..." },
  { "name": "mac-mini-2",  "url": "http://127.0.0.1:27780/mcp", "token": "..." }
] }
```

Registration + usage:

```bash
claude mcp add ssh-hub -- mcp-ssh-pty --hub
# ssh({action:"list"})                              # all nodes + online status + each node's servers
# ssh({node:"macbook-air", action:"connect", server:"local"})   # connect to macbook-air's local shell
# ssh({command:"..."})                              # run on the current node's current connection
```

> For full deployment, port discipline (each Mac daemon's reverse tunnel must **stagger** onto a different VPS port), deploying a single Mac's daemon, and troubleshooting, see `skills/deploy-ssh-mcp/SKILL.md`.
> The `ssh-mac` approach — one HTTP registration per Mac — still works for a single-machine direct connection, but for managing several machines together, prefer the hub.

### hub resident daemon (`--hub --http`, since v2.7.0)

The default `--hub` is stdio, which means **every** Claude Code session spawns its own hub process (~100M each). Open five or six sessions on the VPS and the hubs alone eat 500M. Adding `--http` collapses that into **a single resident daemon that serves every session** — each MCP session still gets its own "current node + downstream connections to each Mac", and they never cross-talk:

```bash
# daemon (on the VPS, bound to loopback only)
mcp-ssh-pty --hub --http --port 27790 --host 127.0.0.1 --token <secret>
#   --idle-min N   idle session reclaim threshold (minutes); hub default 1440 (24h), 0 = never reclaim; direct daemon default 30
# registration (HTTP, replaces the stdio one)
claude mcp add --transport http ssh-hub http://127.0.0.1:27790/mcp --header "Authorization: Bearer <secret>"
# check it's alive
curl -s http://127.0.0.1:27790/health   # {"ok":true,"name":"ssh-hub","activeSessions":N,...}
```

Key points:
- **Restarting the daemon drops the MCP session for every connected client** (they get a 404 `session_not_found`), so each one has to `/mcp` to reconnect — think this through before upgrading. The stdio `--hub` still works, so anyone who'd rather avoid this can stay on stdio.
- The idle-reclaim threshold is deliberately loose on the hub side (24h): Claude sessions often sit idle for well over half an hour, and reclaiming one forces the next `ssh` to re-initialize. Hub sessions are tiny anyway, the downstream Mac daemons do their own 30-minute reclaim, and the hub just reconnects on its next call.
- Measured on the VPS itself: a single `true` through the HTTP hub runs ~25ms; remote commands to a Mac ~180ms each, with the first connect taking 1.1–1.4s (mostly tunnel round-trips).
- **Config reload**: `hub.json` (the node list / notes) is read once when the daemon starts and cached for the life of the process, so after editing it you need `systemctl restart ssh-hub` (and connected sessions must `/mcp` reconnect). The vps node's `ssh-servers.json`, by contrast, is read per MCP session — new sessions pick up changes right away, existing ones just need a reconnect.

## CLI Commands

### List servers

```bash
mcp-ssh-pty list           # Auto-detect config level
mcp-ssh-pty list --local   # Project level only
mcp-ssh-pty list --global  # User level only
mcp-ssh-pty list --all     # Show both levels
```

### Add server

```bash
# Interactive mode
mcp-ssh-pty add

# Save to project level
mcp-ssh-pty add my-server -l -H 192.168.1.100 -u root -k ~/.ssh/id_rsa

# Save to user level
mcp-ssh-pty add my-server -g -H 192.168.1.100 -u root -p mypassword
```

### Remove server

```bash
mcp-ssh-pty remove my-server
mcp-ssh-pty remove --local   # From project level
mcp-ssh-pty remove --global  # From user level
```

### Test connection

```bash
mcp-ssh-pty test my-server
```

### Interactive configuration

```bash
mcp-ssh-pty config
```

## Configuration

### Config file locations

| Level | Path | Priority |
|-------|------|----------|
| Project | `./.mori/ssh/ssh-servers.json` | High |
| User | `~/.mori/ssh/ssh-servers.json` | Low |
| Custom | `SSH_MCP_CONFIG_PATH` env | Highest |

### Config format

```json
{
  "servers": [
    {
      "name": "my-server",
      "host": "192.168.1.100",
      "port": 22,
      "username": "root",
      "privateKeyPath": "~/.ssh/id_rsa"
    }
  ]
}
```

## MCP Usage

### List Servers

```
ssh({ action: "list" })
```

Returns:
```json
[
  { "name": "local", "connected": false, "type": "built-in" },
  { "name": "my-server", "connected": false, "type": "configured" }
]
```

### Connect

```
ssh({ action: "connect", server: "local" })      # Local shell
ssh({ action: "connect", server: "my-server" })  # Remote SSH
```

### Command Execution

Goes through the **exec channel** by default: one-shot, isolated, won't get wedged by heredocs / line continuations.

**Return shape stays close to native Bash (since v2.8.0)**: on success you get raw stdout back directly (real newlines, no JSON wrapper), with stderr appended if there is any; only when something goes wrong does it tack a line on the end — `[exit 3]` / `[timeout]` / `[signal …]` / `[output truncated]` (and sets isError). A success with no output comes back as `(exit 0, no output)`. To the model this reads just like native Bash, and it saves tokens.

```
ssh({ command: "ls -la" })                            # returns the directory listing directly (real newlines)
ssh({ command: "make test", timeout: 120 })           # on failure, trailing [exit N] + isError
ssh({ command: "python3 -", stdin: "print(1+1)" })    # feed multi-line content to stdin (exec channel)
ssh({ command: "npm test", cwd: "/repo" })            # run in a given directory (skips cd x &&; cwd is not persistent across calls)
```

**One-shot addressing (since v2.8.0)**: pass `server` (and `node` under hub) alongside `command` and you can skip the separate connect — if nothing's connected it connects for you, if you're already on that machine it reuses the connection, and the one call lands on the target. A bare `ssh({command})` still runs on whatever connection is currently stuck to.

```
ssh({ command: "uname -a", server: "local" })                    # direct daemon: one step
ssh({ node: "mac-mini-2", server: "local", command: "sw_vers" }) # hub: connect to the Mac and execute in one call
```

> The PATH the exec channel uses: at startup the daemon grabs the login shell's `$PATH` once (the same one you see in your terminal) and unions it with its own, so on a Mac you can run `sysctl` / `brew` and friends without manually `export`-ing anything. That cost is paid once, not on every command.

**connect loads notes on demand (since v2.8.0)**: `connect` no longer dumps the whole notes blob into context — it just returns a one-liner ("connected + N notes"). When you actually want a machine's notes / usage tips, pull the full text with `ssh({action:"notes"})` (loaded on demand like a skill, so you don't pay for it on every reconnect). Shortcuts still come back with connect in short form; for the full list use `ssh({action:"shortcuts"})`.

`sftp({action:"read"})` follows the same idea as the native `Read`: it returns file contents with `cat -n` line numbers instead of a JSON wrapper. (Control responses like `connect` / `list` / `status` stay structured JSON — they're state data, not command or file content.)

### Interactive / persistent shell (`mode:"pty"`)

Reach for `mode:"pty"` when you're in an interactive REPL, a TUI (vim/top/less), running `tail -f` and needing Ctrl-C, or holding cwd/env across commands (the PTY is created lazily on first use, and `interactive` / `signal` / `read` all imply pty).

```
ssh({ command: "mysql -u root -p", mode: "pty" })
ssh({ command: "password123", mode: "pty", interactive: true })
ssh({ command: "SHOW DATABASES;", mode: "pty", interactive: true })
```

> ⚠️ Only pty mode risks getting wedged by a heredoc or line continuation: under `mode:"pty"`, don't inline heredocs or leave a quote unclosed. For multi-line content, use `sftp.write` or the default exec channel's `stdin` instead.

### Read Buffer

```
ssh({ read: true })                # Last 20 lines
ssh({ read: true, lines: -1 })     # All
ssh({ read: true, lines: 100 })    # 100 lines
```

### Signal Control (`mode:"pty"`)

```
ssh({ command: "tail -f /var/log/syslog", mode: "pty" })
ssh({ read: true })
ssh({ signal: "SIGINT" })          # Ctrl+C
```

### Disconnect

```
ssh({ action: "disconnect" })
```

### Status

```
ssh({ action: "status" })
```

## Built-in Servers

| Name | Description |
|------|-------------|
| `local` | Local shell (uses system default shell) |

## License

MIT
