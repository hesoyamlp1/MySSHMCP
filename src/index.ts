#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSHManager } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { registerTools } from "./tools.js";
import { runCLI } from "./cli.js";

// CLI 命令列表
const CLI_COMMANDS = ["list", "add", "remove", "rm", "test", "config", "help", "--help", "-h", "--version", "-V"];

/**
 * 检查是否是 CLI 模式
 */
function isCLIMode(): boolean {
  const args = process.argv.slice(2);

  // 没有参数时启动 MCP 服务器
  if (args.length === 0) {
    return false;
  }

  // 如果第一个参数是 CLI 命令，则进入 CLI 模式
  return CLI_COMMANDS.includes(args[0]);
}

/**
 * 启动 MCP 服务器
 */
async function startServer(): Promise<void> {
  const server = new McpServer({
    name: "ssh-mcp-server",
    version: "1.0.0",
  });

  const sshManager = new SSHManager();
  const configManager = new ConfigManager();

  registerTools(server, sshManager, configManager);

  const transport = new StdioServerTransport();

  await server.connect(transport);

  process.on("SIGINT", async () => {
    await sshManager.disconnect();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await sshManager.disconnect();
    process.exit(0);
  });
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  if (isCLIMode()) {
    await runCLI();
  } else {
    await startServer();
  }
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
