# mcp-ssh-pty

MCP Server for SSH remote command execution with PTY shell support.

## Installation

```bash
claude mcp add ssh -- npx -y mcp-ssh-pty
```

With custom config path:

```bash
claude mcp add ssh -e SSH_MCP_CONFIG_PATH=~/ssh-servers.json -- npx -y mcp-ssh-pty
```

## Configuration

Create a `ssh-servers.json` file:

```json
{
  "servers": [
    {
      "name": "my-server",
      "host": "192.168.1.100",
      "port": 22,
      "username": "root",
      "privateKeyPath": "~/.ssh/id_rsa"
    },
    {
      "name": "dev-server",
      "host": "10.0.0.50",
      "port": 22,
      "username": "ubuntu",
      "password": "your-password"
    }
  ]
}
```

Config file search order:
1. `SSH_MCP_CONFIG_PATH` environment variable
2. `./ssh-servers.json`
3. `~/.config/ssh-mcp/servers.json`

## Tools

### ssh

SSH connection management and command execution.

**Actions:**
- `list` - List available servers
- `connect` - Connect to a server
- `disconnect` - Disconnect current session
- `status` - View connection status

**Quick command:**
```
ssh({ command: "ls -la" })
```

**Example:**
```
ssh({ action: "list" })
ssh({ action: "connect", server: "my-server" })
ssh({ command: "whoami" })
ssh({ action: "disconnect" })
```

### ssh_shell

PTY Shell session control for interactive programs.

**Actions:**
- `send` - Send command or input
- `read` - Read output buffer
- `signal` - Send signal (SIGINT/SIGTSTP/SIGQUIT)
- `close` - Close shell session

**Examples:**

Interactive program:
```
ssh({ command: "mysql -u root -p" })
ssh_shell({ action: "send", input: "password" })
ssh_shell({ action: "send", input: "SHOW DATABASES;" })
```

Read truncated output:
```
ssh({ command: "cat /var/log/syslog" })
ssh_shell({ action: "read", lines: 500 })
```

Stop running command:
```
ssh({ command: "tail -f /var/log/nginx/access.log" })
ssh_shell({ action: "signal", signal: "SIGINT" })
```

## License

MIT
