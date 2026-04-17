# @mori-mori/mcp-ssh-pty

MCP Server for SSH remote command execution with PTY shell support.

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

## 架构：跨机 MCP（VPS + mac 场景）

典型场景：Claude Code 只跑在 VPS 上，但大部分运维目标在 mac 及其内网机（0.2/...）。
希望 "VPS 的 Claude Code 可以直接调 mac 的 MCP" 来避免 261M jar 经 VPS 中转之类的拓扑浪费。

方案：**mac 上把 MCP 以 HTTP daemon 跑，通过已有反向 SSH 隧道暴露给 VPS**。

```
mac (NAT 后)
  ├─ mcp-ssh-pty --http --port 7777 --host 127.0.0.1 --token XYZ
  └─ ssh -R 2222:localhost:22 -R 7777:localhost:7777 vps   # 多加一个 -R 端口

vps
  └─ claude mcp add --transport http ssh-mac http://127.0.0.1:7777/mcp \
         --header "Authorization: Bearer XYZ"
```

VPS 同时保留本地 stdio MCP（`ssh-vps`）兜底，这样 mac 宕机不影响 VPS 自身操作。
mac 的 ssh-servers.json 里可加一条 `vps` 条目，让 mac MCP 也能 sftp mac↔vps 双向传输。

### 建议安全实践

- mac HTTP 模式**必须**设置 `--token`，并只绑 `127.0.0.1`（由反向隧道暴露到 VPS 的 loopback）
- 不要 `--host 0.0.0.0` 直接暴露到局域网/公网
- token 可写入 mac launchd plist 或 systemd EnvironmentFile 中

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

```
ssh({ command: "ls -la" })
ssh({ command: "whoami" })
```

### Interactive Programs

```
ssh({ command: "mysql -u root -p" })
ssh({ command: "password123" })
ssh({ command: "SHOW DATABASES;" })
```

### Read Buffer

```
ssh({ read: true })                # Last 20 lines
ssh({ read: true, lines: -1 })     # All
ssh({ read: true, lines: 100 })    # 100 lines
```

### Signal Control

```
ssh({ command: "tail -f /var/log/syslog" })
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
