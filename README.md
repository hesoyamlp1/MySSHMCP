# @mori-mori/mcp-ssh-pty

MCP Server for SSH remote command execution. 命令默认走无头 `exec` 通道（一发一收、独立、直接拿 exitCode、输出无需清洗、不会卡死 session）；交互式 REPL / TUI / 需保留 shell 状态的场景用 `mode:"pty"`（持久 PTY shell，首次用到才懒加载）。

## Installation

```bash
npm install -g @mori-mori/mcp-ssh-pty
```

### Start MCP Server

```bash
# stdio 模式（默认，被 Claude Code 作为子进程拉起）
mcp-ssh-pty

# HTTP 模式（作为独立 daemon 运行，可被远程 Claude Code 连接）
mcp-ssh-pty --http --port 7777 --host 127.0.0.1
mcp-ssh-pty --http --port 7777 --host 127.0.0.1 --token <shared-secret>
```

HTTP 模式参数也可通过环境变量提供：`MCP_HTTP_PORT` / `MCP_HTTP_HOST` / `MCP_HTTP_TOKEN`。

### Add to Claude Code

```bash
# stdio（本机）
claude mcp add --transport stdio ssh -- mcp-ssh-pty

# 或使用 npx（无需安装）
claude mcp add --transport stdio ssh -- npx -y @mori-mori/mcp-ssh-pty

# HTTP（远程或本机 daemon）
claude mcp add --transport http ssh-remote http://127.0.0.1:7777/mcp
# 带 Bearer token：
claude mcp add --transport http ssh-remote http://127.0.0.1:7777/mcp \
  --header "Authorization: Bearer <shared-secret>"
```

## 架构：多机统一管理（hub 模式）

典型场景：Claude Code 只跑在 VPS 上，要同时管理 VPS 自己 + 多台 mac（及各自内网机），而且只想注册**一个** MCP。

方案：**hub 模式**。同一个二进制有两种角色：

- **直连模式**（默认 / `--http`）：直接做 SSH 命令执行的活（默认 exec 通道，可选 PTY）。每台 mac 上各跑一个 `--http` daemon，经反向隧道暴露到 VPS。
- **hub 模式**（`--hub`）：跑在 VPS，对 Claude 只露一个 `ssh`/`sftp`，内部按 `node` 路由到各 mac 的 daemon（自己既是 MCP server 又是各 daemon 的 client）。VPS 自己作为一个 in-process node 直接进 hub，不用额外起 daemon。

```
Claude Code (VPS)
  └─ 一条注册：ssh-hub (stdio) → mcp-ssh-pty --hub  → 读 ~/.mori/ssh/hub.json
       ├─ in-process 直连           → vps          （VPS 本机 shell）
       ├─ http://127.0.0.1:27778/mcp → macbook-air  （公司·主力）  ┐ 各 mac daemon 本地都听 27777，
       ├─ http://127.0.0.1:27779/mcp → mac-mini-1   （公司·备用）  ┤ 反向隧道错开暴露到 VPS 不同端口
       └─ http://127.0.0.1:27780/mcp → mac-mini-2   （家里）       ┘ （27777 保留留空，hub 端口从 27778 起）
     ssh({action:"list"}) → 逐 node 探活 online；connect node=macbook-air → 路由到该 daemon
```

- 一条注册管全部；每台 mac 仍是自己的 daemon 在干活 → 保留**一跳 sftp**、本地直连、各自 notes/shortcuts。
- 每个 node 是独立下游连接 → 多台 mac 的连接（exec 通道 / PTY）可**同时活着**，hub 只负责路由。

hub 配置 `~/.mori/ssh/hub.json`（见 `hub.example.json`）：

```json
{ "nodes": [
  { "name": "vps", "local": true },
  { "name": "macbook-air", "url": "http://127.0.0.1:27778/mcp", "token": "..." },
  { "name": "mac-mini-1",  "url": "http://127.0.0.1:27779/mcp", "token": "..." },
  { "name": "mac-mini-2",  "url": "http://127.0.0.1:27780/mcp", "token": "..." }
] }
```

注册 + 用法：

```bash
claude mcp add ssh-hub -- mcp-ssh-pty --hub
# ssh({action:"list"})                              # 所有 node + online + 各 node 的 server
# ssh({node:"macbook-air", action:"connect", server:"local"})   # 连 macbook-air 本机
# ssh({command:"..."})                              # 在当前 node 当前连接上执行
```

> 完整部署、端口纪律（每台 mac daemon 反向隧道**错开**到不同 VPS 端口）、单台 mac daemon 的部署、排错见 `skills/deploy-ssh-mcp/SKILL.md`。
> `ssh-mac` 那种「每台 mac 一条 HTTP 注册」仍可用作单机直连，但多机统一管理推荐 hub。

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

默认走 **exec 通道**：一发一收、独立、直接返回 stdout/stderr/exitCode，输出无需清洗，且不会被 heredoc / 续行符卡死 session。

```
ssh({ command: "ls -la" })                            # 默认 exec，返回 stdout + exitCode
ssh({ command: "make test", timeout: 120 })
ssh({ command: "python3 -", stdin: "print(1+1)" })    # 多行内容喂 stdin（exec 通道）
```

### Interactive / 持久 shell（`mode:"pty"`）

交互式 REPL、TUI（vim/top/less）、`tail -f` + Ctrl-C、需要跨命令保留 cwd/env 时用 `mode:"pty"`（PTY 首次用到才懒加载；`interactive` / `signal` / `read` 都隐含 pty）。

```
ssh({ command: "mysql -u root -p", mode: "pty" })
ssh({ command: "password123", mode: "pty", interactive: true })
ssh({ command: "SHOW DATABASES;", mode: "pty", interactive: true })
```

> ⚠️ 仅 pty 模式有 heredoc/续行符卡死风险：`mode:"pty"` 下别内联 heredoc 或留未闭合引号；多行内容用 `sftp.write` 或默认 exec 的 `stdin`。

### Read Buffer

```
ssh({ read: true })                # Last 20 lines
ssh({ read: true, lines: -1 })     # All
ssh({ read: true, lines: 100 })    # 100 lines
```

### Signal Control（`mode:"pty"`）

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
