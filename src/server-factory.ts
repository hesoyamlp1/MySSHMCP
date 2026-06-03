import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHManager } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { NotesManager } from "./notes-manager.js";
import { registerTools } from "./tools.js";

/**
 * 构造一个「直连模式」MCP server（ssh/sftp 工具 + 一份 SSHManager）。
 * stdio / http / hub 的 in-process local node 都复用它。
 */
export function buildDirectServer(version: string): { server: McpServer; sshManager: SSHManager } {
  const server = new McpServer({ name: "ssh-mcp-server", version });
  const sshManager = new SSHManager();
  const configManager = new ConfigManager();
  const notesManager = new NotesManager();
  registerTools(server, sshManager, configManager, notesManager);
  return { server, sshManager };
}
