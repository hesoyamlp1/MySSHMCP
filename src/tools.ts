import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SSHManager, LOCAL_SERVER } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { sanitize } from "./sanitizer.js";
import { ShellResult } from "./types.js";
import { saveIfLarge } from "./output-store.js";

/**
 * 过滤 ShellResult 中的敏感信息
 */
function sanitizeResult(result: ShellResult): ShellResult {
  return {
    ...result,
    output: sanitize(result.output),
    message: sanitize(result.message),
  };
}

/**
 * 检查输出是否过大，如果过大则保存到本地文件并截断返回
 */
function truncateIfLarge(resultObj: Record<string, unknown>): string {
  const json = JSON.stringify(resultObj, null, 2);
  const output = resultObj.output as string | undefined;

  if (!output) return json;

  const saveResult = saveIfLarge(output);
  if (!saveResult.saved) return json;

  // 替换 output 为尾部摘要 + 提示
  const truncated = {
    ...resultObj,
    output: saveResult.tail,
    _overflow: {
      totalChars: saveResult.totalChars,
      savedTo: saveResult.filePath,
      hint: `⚠️ 输出过长（共 ${saveResult.totalChars} 字符），已保存完整内容至: ${saveResult.filePath}。当前仅显示最后 2000 字符。如需查看完整内容，请使用 Read 工具读取该文件，或使用 Grep 工具搜索关键内容。`,
    },
  };

  return JSON.stringify(truncated, null, 2);
}

export function registerTools(
  server: McpServer,
  sshManager: SSHManager,
  configManager: ConfigManager
): void {
  server.registerTool(
    "ssh",
    {
      description: `SSH 远程服务器连接管理和 PTY Shell 交互。

## 连接管理 (action)
- list: 列出所有可用服务器
- connect: 连接服务器（需提供 server 参数）
- disconnect: 断开当前连接
- status: 查看连接状态和 shell 缓冲区行数

## 命令执行 (command)
直接提供 command 参数执行命令，支持交互式程序。

## Shell 控制
- read: 设为 true 读取缓冲区（配合 lines/offset/clear）
- signal: 发送信号 SIGINT(Ctrl+C)/SIGTSTP(Ctrl+Z)/SIGQUIT

## 智能输出检测
- 快速命令（<2秒）：检测到提示符后返回
- 慢速命令（2-5秒）：标记 slow=true
- 超时命令（>5秒）：截断到最近 200 行，标记 truncated=true
- 持续输出：输出稳定后返回，标记 waiting=true

## 返回字段
- output: 命令输出
- totalLines: 总行数
- complete: 是否完成（出现提示符）
- truncated: 是否被截断
- slow: 是否耗时较长
- waiting: 可能在等待输入或仍在运行

## 使用示例

### 基本操作
ssh({ action: "list" })
ssh({ action: "connect", server: "my-server" })
ssh({ command: "ls -la" })
ssh({ action: "status" })
ssh({ action: "disconnect" })

### 读取缓冲区
ssh({ read: true })                    # 读取最近 20 行
ssh({ read: true, lines: -1 })         # 读取全部
ssh({ read: true, lines: 100 })        # 读取 100 行

### 交互式程序
ssh({ command: "mysql -u root -p" })   # 启动 mysql
ssh({ command: "password123" })         # 输入密码
ssh({ command: "SHOW DATABASES;" })     # 执行 SQL

### 信号控制
ssh({ command: "tail -f /var/log/syslog" })
ssh({ read: true })                     # 查看输出
ssh({ signal: "SIGINT" })               # Ctrl+C 停止

## 安全说明
- 输出中的 IP 地址会被替换为 [IP]，密码等敏感信息会被替换为 [REDACTED]
- 这是系统自动脱敏处理，不影响实际命令执行
- 如输出过长（超过 8000 字符），完整内容会保存到本地文件，仅返回尾部摘要`,
      inputSchema: {
        action: z
          .enum(["list", "connect", "disconnect", "status"])
          .optional()
          .describe("连接管理操作"),
        server: z.string().optional().describe("服务器名称（connect 时必填）"),
        command: z.string().optional().describe("要执行的命令"),
        read: z.boolean().optional().describe("读取缓冲区"),
        lines: z.number().optional().describe("读取行数，默认 20，-1 返回全部"),
        offset: z.number().optional().describe("读取起始偏移，默认 0"),
        clear: z.boolean().optional().describe("读取后清空缓冲区"),
        signal: z
          .enum(["SIGINT", "SIGTSTP", "SIGQUIT"])
          .optional()
          .describe("发送信号：SIGINT(Ctrl+C)/SIGTSTP(Ctrl+Z)/SIGQUIT"),
      },
    },
    async ({ action, server: serverName, command, read, lines, offset, clear, signal }): Promise<CallToolResult> => {
      try {
        // 1. 发送信号
        if (signal) {
          const status = sshManager.getStatus();
          if (!status.connected) {
            return {
              content: [{ type: "text", text: "未连接服务器" }],
              isError: true,
            };
          }

          const shellManager = sshManager.getShellManager();
          const success = shellManager.sendSignal(signal);

          return {
            content: [{
              type: "text",
              text: success ? `已发送 ${signal}` : `发送 ${signal} 失败`,
            }],
            isError: !success,
          };
        }

        // 2. 读取缓冲区
        if (read) {
          const status = sshManager.getStatus();
          if (!status.connected) {
            return {
              content: [{ type: "text", text: "未连接服务器" }],
              isError: true,
            };
          }

          const shellManager = sshManager.getShellManager();
          const result = sanitizeResult(shellManager.read(lines, offset, clear));

          return {
            content: [{
              type: "text",
              text: truncateIfLarge({
                server: status.serverName,
                ...result,
              }),
            }],
          };
        }

        // 3. 执行命令
        if (command) {
          const status = sshManager.getStatus();
          if (!status.connected) {
            return {
              content: [{ type: "text", text: "未连接服务器，请先使用 ssh({ action: 'connect', server: '服务器名' }) 连接" }],
              isError: true,
            };
          }

          const shellManager = sshManager.getShellManager();
          const result = sanitizeResult(await shellManager.send(command));

          return {
            content: [{
              type: "text",
              text: truncateIfLarge({
                server: status.serverName,
                command,
                ...result,
              }),
            }],
            isError: !result.complete && !result.waiting,
          };
        }

        // 4. 连接管理操作
        const effectiveAction = action || "status";

        switch (effectiveAction) {
          case "list": {
            const servers = configManager.listServers();
            const status = sshManager.getStatus();

            // 添加内置的 local 服务器
            const list = [
              {
                name: LOCAL_SERVER.name,
                connected: status.serverName === LOCAL_SERVER.name,
                type: "built-in",
              },
              ...servers.map((s) => ({
                name: s.name,
                connected: status.serverName === s.name,
                type: "configured",
              })),
            ];

            return {
              content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
            };
          }

          case "connect": {
            if (!serverName) {
              return {
                content: [{ type: "text", text: "缺少 server 参数" }],
                isError: true,
              };
            }

            // 检查是否是本地连接
            if (serverName === "local") {
              await sshManager.connect(LOCAL_SERVER);
              return {
                content: [{
                  type: "text",
                  text: "成功连接到本地 Shell",
                }],
              };
            }

            const serverConfig = configManager.getServer(serverName);
            if (!serverConfig) {
              const available = ["local", ...configManager.listServers().map((s) => s.name)];
              return {
                content: [{
                  type: "text",
                  text: `服务器 '${serverName}' 不存在。可用服务器: ${available.join(", ")}`,
                }],
                isError: true,
              };
            }

            await sshManager.connect(serverConfig);

            return {
              content: [{
                type: "text",
                text: `成功连接到 '${serverName}'，PTY Shell 已就绪`,
              }],
            };
          }

          case "disconnect": {
            const status = sshManager.getStatus();
            if (!status.connected) {
              return {
                content: [{ type: "text", text: "当前没有活跃的连接" }],
              };
            }

            const name = status.serverName;
            await sshManager.disconnect();

            return {
              content: [{ type: "text", text: `已断开与 '${name}' 的连接` }],
            };
          }

          case "status": {
            const status = sshManager.getStatus();
            const shellManager = sshManager.getShellManager();

            if (status.connected) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    connected: true,
                    server: status.serverName,
                    shellOpen: shellManager.isOpen(),
                    bufferLines: shellManager.getBufferLineCount(),
                  }, null, 2),
                }],
              };
            } else {
              return {
                content: [{ type: "text", text: JSON.stringify({ connected: false }, null, 2) }],
              };
            }
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `错误: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
