# mcp-ssh-pty

MCP Server for SSH remote command execution with PTY shell support.

## Installation

```bash
npm install -g mcp-ssh-pty
```

### Add to Claude Code

```bash
claude mcp add ssh -- npx -y mcp-ssh-pty
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
# Interactive mode (will ask for config level)
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

```
? 选择配置级别:
❯ 📁 项目级别 (已存在)
  🌐 用户级别 (新建)

? 选择操作:
❯ 📋 查看所有服务器
  ➕ 添加服务器
  ✏️  编辑服务器
  🗑️  删除服务器
  🔌 测试连接
  🔄 切换配置级别
  📁 显示配置文件路径
  🚪 退出
```

## Configuration

### Config file locations

| Level | Path | Priority |
|-------|------|----------|
| Project | `./.claude/ssh-servers.json` | High |
| User | `~/.claude/ssh-servers.json` | Low |
| Custom | `SSH_MCP_CONFIG_PATH` env | Highest |

Project level config overrides user level when exists.

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

### Connection

```
ssh({ action: "list" })
ssh({ action: "connect", server: "my-server" })
ssh({ action: "status" })
ssh({ action: "disconnect" })
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

## License

MIT
