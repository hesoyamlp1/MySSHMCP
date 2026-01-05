import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SSHManager } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { sanitize } from "./sanitizer.js";
import { ShellResult } from "./types.js";

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

export function registerTools(
  server: McpServer,
  sshManager: SSHManager,
  configManager: ConfigManager
): void {
  // 工具1: ssh - 连接管理 + 快捷命令
  server.registerTool(
    "ssh",
    {
      description: `SSH 远程服务器连接管理和命令执行。使用持久 PTY Shell，支持交互式操作。

## 操作类型 (action)
- list: 列出所有可用服务器
- connect: 连接服务器（需提供 server 参数）
- disconnect: 断开当前连接
- status: 查看连接状态和 shell 缓冲区行数

## 快捷命令 (command)
直接提供 command 参数可执行命令，无需指定 action。

## 智能输出检测
命令执行后自动检测完成状态：
- 快速命令（<2秒）：检测到提示符后返回完整输出
- 慢速命令（2-5秒）：返回完整输出，标记 slow=true
- 超时命令（>5秒）：自动截断到最近 200 行，标记 truncated=true
- 持续输出（如 tail -f）：输出稳定后返回，标记 waiting=true

## 返回字段说明
- output: 命令输出内容
- totalLines: 总行数
- complete: 是否检测到命令完成（出现提示符）
- truncated: 是否被截断（超时时）
- slow: 是否耗时较长
- waiting: 命令可能仍在运行或等待输入
- message: 状态描述

## 使用示例
1. 列出服务器: ssh({ action: "list" })
2. 连接: ssh({ action: "connect", server: "my-server" })
3. 执行命令: ssh({ command: "ls -la" })
4. 查看状态: ssh({ action: "status" })
5. 断开: ssh({ action: "disconnect" })

## 注意事项
- 如果 truncated=true，使用 ssh_shell read 获取完整输出
- 如果 waiting=true，命令可能需要输入或是持续运行的程序，使用 ssh_shell 继续交互`,
      inputSchema: {
        action: z
          .enum(["list", "connect", "disconnect", "status"])
          .optional()
          .describe("操作类型：list/connect/disconnect/status"),
        server: z.string().optional().describe("服务器名称（connect 时必填）"),
        command: z.string().optional().describe("要执行的命令（直接执行，无需 action）"),
      },
    },
    async ({ action, server: serverName, command }): Promise<CallToolResult> => {
      try {
        // 快捷命令模式
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
              text: JSON.stringify({
                server: status.serverName,
                command,
                ...result,
              }, null, 2),
            }],
            isError: !result.complete && !result.waiting,
          };
        }

        // 默认 action 为 status
        const effectiveAction = action || "status";

        switch (effectiveAction) {
          case "list": {
            const servers = configManager.listServers();
            const status = sshManager.getStatus();

            // 只返回服务器名称，不暴露 IP/端口/用户名
            const list = servers.map((s) => ({
              name: s.name,
              connected: status.serverName === s.name,
            }));

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

            const serverConfig = configManager.getServer(serverName);
            if (!serverConfig) {
              const available = configManager.listServers().map((s) => s.name);
              return {
                content: [{
                  type: "text",
                  text: `服务器 '${serverName}' 不存在。可用服务器: ${available.join(", ")}`,
                }],
                isError: true,
              };
            }

            await sshManager.connect(serverConfig);

            // 不暴露 IP/端口/用户名
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
              // 不暴露 host/username
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

  // 工具2: ssh_shell - PTY Shell 会话控制
  server.registerTool(
    "ssh_shell",
    {
      description: `PTY Shell 高级会话控制。用于交互式程序、长输出处理、信号发送等场景。

## 操作类型 (action)

### send - 发送命令或输入
发送命令到 shell，智能等待完成。适用于：
- 需要多次交互的程序（如 mysql, python 交互模式）
- 需要发送特定输入（如回答 y/n 提示）
参数：input（必填）- 要发送的内容

### read - 读取缓冲区
获取 shell 输出缓冲区内容。适用于：
- 命令被截断后获取完整输出
- 查看持续运行命令的最新输出
- 分页读取大量输出
参数：
- lines: 返回行数（默认 20 行，-1 返回全部）
- offset: 起始偏移（默认 0）
- clear: 读取后清空缓冲区（默认 false）

### signal - 发送信号
向当前进程发送控制信号：
- SIGINT: Ctrl+C，中断当前命令
- SIGTSTP: Ctrl+Z，暂停进程
- SIGQUIT: Ctrl+\，退出进程
参数：signal（必填）

### close - 关闭 shell
关闭当前 shell 会话，但保持 SSH 连接。

## 使用场景示例

### 场景1：查看大文件
\`\`\`
ssh({ command: "cat /var/log/syslog" })
# 返回 truncated=true，只有最近 200 行
ssh_shell({ action: "read", lines: 500, offset: 0 })
# 获取前 500 行
\`\`\`

### 场景2：交互式程序
\`\`\`
ssh({ command: "mysql -u root -p" })
# 返回 waiting=true，等待密码
ssh_shell({ action: "send", input: "password123" })
# 发送密码
ssh_shell({ action: "send", input: "SHOW DATABASES;" })
# 执行 SQL
\`\`\`

### 场景3：监控日志
\`\`\`
ssh({ command: "tail -f /var/log/nginx/access.log" })
# 返回 waiting=true
# ... 等待一段时间 ...
ssh_shell({ action: "read" })
# 查看新日志
ssh_shell({ action: "signal", signal: "SIGINT" })
# 停止 tail
\`\`\`

### 场景4：vim 等全屏程序
\`\`\`
ssh_shell({ action: "send", input: "vim config.txt" })
ssh_shell({ action: "send", input: "i" })  # 进入插入模式
ssh_shell({ action: "send", input: "new content" })
ssh_shell({ action: "send", input: "\\x1b" })  # ESC 键
ssh_shell({ action: "send", input: ":wq" })  # 保存退出
\`\`\``,
      inputSchema: {
        action: z
          .enum(["send", "read", "signal", "close"])
          .describe("操作类型：send/read/signal/close"),
        input: z.string().optional().describe("send 时的命令或输入内容"),
        signal: z
          .enum(["SIGINT", "SIGTSTP", "SIGQUIT"])
          .optional()
          .describe("signal 时的信号类型：SIGINT(Ctrl+C)/SIGTSTP(Ctrl+Z)/SIGQUIT"),
        lines: z.number().optional().describe("read 时返回的行数，默认 20 行，-1 返回全部"),
        offset: z.number().optional().describe("read 时的起始行偏移，默认 0"),
        clear: z.boolean().optional().describe("read 后是否清空缓冲区，默认 false"),
      },
    },
    async ({ action, input, signal, lines, offset, clear }): Promise<CallToolResult> => {
      try {
        const status = sshManager.getStatus();
        if (!status.connected) {
          return {
            content: [{ type: "text", text: "未连接服务器，请先使用 ssh 工具连接" }],
            isError: true,
          };
        }

        const shellManager = sshManager.getShellManager();
        if (!shellManager.isOpen()) {
          return {
            content: [{ type: "text", text: "Shell 未打开" }],
            isError: true,
          };
        }

        switch (action) {
          case "send": {
            if (!input) {
              return {
                content: [{ type: "text", text: "缺少 input 参数" }],
                isError: true,
              };
            }

            const result = sanitizeResult(await shellManager.send(input));

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  server: status.serverName,
                  input,
                  ...result,
                }, null, 2),
              }],
              isError: !result.complete && !result.waiting,
            };
          }

          case "read": {
            const result = sanitizeResult(shellManager.read(lines, offset, clear));

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  server: status.serverName,
                  ...result,
                }, null, 2),
              }],
            };
          }

          case "signal": {
            if (!signal) {
              return {
                content: [{ type: "text", text: "缺少 signal 参数" }],
                isError: true,
              };
            }

            const success = shellManager.sendSignal(signal);

            return {
              content: [{
                type: "text",
                text: success ? `已发送 ${signal}` : `发送 ${signal} 失败`,
              }],
              isError: !success,
            };
          }

          case "close": {
            shellManager.close();

            return {
              content: [{ type: "text", text: "Shell 已关闭" }],
            };
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
