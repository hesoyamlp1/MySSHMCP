import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHManager } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { ToolResponse } from "./types.js";

export function registerTools(
  server: McpServer,
  sshManager: SSHManager,
  configManager: ConfigManager
): void {
  // 工具1: 列出所有服务器
  server.tool(
    "list_servers",
    "列出所有配置的 SSH 服务器",
    {},
    async (): Promise<ToolResponse> => {
      try {
        const servers = configManager.listServers();
        const status = sshManager.getStatus();

        const list = servers.map((s) => ({
          name: s.name,
          host: s.host,
          port: s.port || 22,
          username: s.username,
          connected: status.serverName === s.name,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(list, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `错误: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // 工具2: 连接服务器
  server.tool(
    "connect_server",
    "连接到指定的 SSH 服务器",
    {
      server_name: z.string().describe("要连接的服务器名称"),
    },
    async ({ server_name }): Promise<ToolResponse> => {
      try {
        const serverConfig = configManager.getServer(server_name);
        if (!serverConfig) {
          const available = configManager.listServers().map((s) => s.name);
          return {
            content: [
              {
                type: "text",
                text: `服务器 '${server_name}' 不存在。可用服务器: ${available.join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        await sshManager.connect(serverConfig);

        return {
          content: [
            {
              type: "text",
              text: `成功连接到服务器 '${server_name}' (${serverConfig.username}@${serverConfig.host}:${serverConfig.port || 22})`,
            },
          ],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `连接失败: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // 工具3: 断开连接
  server.tool(
    "disconnect_server",
    "断开当前 SSH 连接",
    {},
    async (): Promise<ToolResponse> => {
      const status = sshManager.getStatus();
      if (!status.connected) {
        return {
          content: [{ type: "text", text: "当前没有活跃的连接" }],
        };
      }

      const serverName = status.serverName;
      await sshManager.disconnect();

      return {
        content: [
          {
            type: "text",
            text: `已断开与服务器 '${serverName}' 的连接`,
          },
        ],
      };
    }
  );

  // 工具4: 执行命令
  server.tool(
    "execute_command",
    "在当前连接的服务器上执行 shell 命令",
    {
      command: z.string().describe("要执行的 shell 命令"),
      timeout: z
        .number()
        .optional()
        .default(30000)
        .describe("超时时间(毫秒)，默认30秒"),
    },
    async ({ command, timeout }): Promise<ToolResponse> => {
      try {
        const status = sshManager.getStatus();
        if (!status.connected) {
          return {
            content: [
              {
                type: "text",
                text: "未连接到服务器，请先使用 connect_server 连接",
              },
            ],
            isError: true,
          };
        }

        const result = await sshManager.executeCommand(command, timeout);

        let output = `[${status.serverName}] $ ${command}\n\n`;
        if (result.stdout) {
          output += result.stdout + "\n";
        }
        if (result.stderr) {
          output += `\n[STDERR]\n${result.stderr}\n`;
        }
        output += `\n[Exit Code: ${result.exitCode}]`;

        return {
          content: [{ type: "text", text: output }],
          isError: result.exitCode !== 0,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `执行失败: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // 工具5: 获取连接状态
  server.tool(
    "get_connection_status",
    "获取当前 SSH 连接状态",
    {},
    async (): Promise<ToolResponse> => {
      const status = sshManager.getStatus();

      let text: string;
      if (status.connected) {
        text = `已连接: ${status.username}@${status.host} (${status.serverName})`;
      } else {
        text = "未连接到任何服务器";
      }

      return {
        content: [{ type: "text", text }],
      };
    }
  );
}
