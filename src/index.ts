#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSHManager } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { registerTools } from "./tools.js";

async function main() {
  const server = new McpServer({
    name: "ssh-mcp-server",
    version: "1.0.0",
  });

  const sshManager = new SSHManager();
  const configManager = new ConfigManager();

  registerTools(server, sshManager, configManager);

  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error("SSH MCP Server 已启动");
  console.error(`配置文件路径: ${configManager.getConfigPath()}`);

  process.on("SIGINT", async () => {
    console.error("收到 SIGINT，正在关闭...");
    await sshManager.disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("收到 SIGTERM，正在关闭...");
    await sshManager.disconnect();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
