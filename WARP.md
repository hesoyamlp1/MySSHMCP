# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Project Overview

mcp-ssh-pty is an MCP (Model Context Protocol) server that enables SSH remote command execution with PTY shell support. It allows AI assistants to connect to remote servers and local shells via a unified interface.

## Development Commands

```bash
# Build the TypeScript project
npm run build

# Watch mode for development
npm run dev

# Run the MCP server (no arguments starts server mode)
node dist/index.js

# Run CLI commands
node dist/index.js list
node dist/index.js add
node dist/index.js test <server-name>
node dist/index.js config
```

## Architecture

### Dual-Mode Entry Point (index.ts)
The application runs in two modes determined by command-line arguments:
- **MCP Server Mode**: No arguments → starts `McpServer` with stdio transport
- **CLI Mode**: Arguments matching `CLI_COMMANDS` → runs interactive CLI via commander

### Core Components

**SSHManager** (`ssh-manager.ts`)
- Manages SSH connections via `ssh2` library and local shell connections via `node-pty`
- Built-in `local` server uses system default shell
- Supports SOCKS4/5 proxy connections via `socks` library
- Delegates shell interaction to `ShellManager`

**ShellManager** (`shell-manager.ts`)
- Provides unified PTY interface for both remote SSH and local shells
- Maintains output buffer with configurable line limits
- Implements smart command completion detection with prompt pattern recognition
- Handles signal sending (SIGINT, SIGTSTP, SIGQUIT) via control characters

**ConfigManager** (`config.ts`)
- Two-tier configuration: project-level (`.claude/ssh-servers.json`) and user-level (`~/.claude/ssh-servers.json`)
- Project-level takes priority; custom path via `SSH_MCP_CONFIG_PATH` env var

**Sanitizer** (`sanitizer.ts`)
- Global singleton that filters sensitive info (IPs, passwords, usernames) from MCP responses
- Server credentials are auto-registered on connection

### MCP Tool Interface (tools.ts)
Single `ssh` tool with multiple operation modes:
- Connection management: `action: "list" | "connect" | "disconnect" | "status"`
- Command execution: `command: string`
- Buffer reading: `read: true` with optional `lines`, `offset`, `clear`
- Signal control: `signal: "SIGINT" | "SIGTSTP" | "SIGQUIT"`

### Output Detection Strategy
Commands have intelligent completion detection:
1. Quick path (<2s): Returns when prompt detected
2. Slow path (2-5s): Marks `slow=true`
3. Timeout (>5s): Truncates to 200 lines, marks `truncated=true`
4. Waiting: Output stable but no prompt, marks `waiting=true`
