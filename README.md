# @mori-mori/mcp-ssh-pty

MCP Server for SSH remote command execution with PTY shell support.

## Installation

```bash
npm install -g @mori-mori/mcp-ssh-pty
```

### Start MCP Server

```bash
mcp-ssh-pty
```

### Add to Claude Code

```bash
# 全局安装后
claude mcp add --transport stdio ssh -- mcp-ssh-pty

# 或使用 npx（无需安装）
claude mcp add --transport stdio ssh -- npx -y @mori-mori/mcp-ssh-pty
```

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
| Project | `./.mori/ssh-servers.json` | High |
| User | `~/.mori/ssh-servers.json` | Low |
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
