import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SSHManager, LOCAL_SERVER } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { NotesManager } from "./notes-manager.js";
import { ShortcutConfig } from "./types.js";
import { saveIfLarge } from "./output-store.js";
import { renderShortcut } from "./shortcut-renderer.js";

/**
 * 检查输出是否过大，如果过大则保存到本地文件并截断返回
 */
function truncateIfLarge(resultObj: Record<string, unknown>): string {
  const json = JSON.stringify(resultObj, null, 2);
  const output = resultObj.output as string | undefined;

  if (!output) return json;

  const saveResult = saveIfLarge(output);
  if (!saveResult.saved) return json;

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

/**
 * 把 shortcuts 字典转成模型可见的摘要列表（不暴露 command 模板和 secret 值）。
 * detail 决定字段粒度。getSource 用于 full 模式标注每条来自全局还是服务器级。
 */
function summarizeShortcuts(
  shortcuts: Record<string, ShortcutConfig> | undefined,
  detail: "names" | "brief" | "full",
  getSource?: (name: string) => "global" | "server" | null
): unknown {
  if (!shortcuts) return [];
  const entries = Object.entries(shortcuts);
  if (detail === "names") return entries.map(([name]) => name);
  if (detail === "brief") {
    return entries.map(([name, cfg]) => ({
      name,
      description: cfg.description,
      runsOn: cfg.runsOn,
    }));
  }
  return entries.map(([name, cfg]) => ({
    name,
    description: cfg.description,
    runsOn: cfg.runsOn,
    source: getSource ? getSource(name) ?? undefined : undefined,
    args: cfg.args ?? [],
    secretKeys: Object.keys(cfg.secrets ?? {}),
  }));
}

export function registerTools(
  server: McpServer,
  sshManager: SSHManager,
  configManager: ConfigManager,
  notesManager: NotesManager
): void {
  server.registerTool(
    "ssh",
    {
      description: `SSH 远程服务器连接管理和 PTY Shell 交互。

## 连接管理 (action)
- list: 列出所有可用服务器（附带备注摘要）
- connect: 连接服务器（需提供 server 参数，自动附带完整备注）
- disconnect: 断开当前连接
- status: 查看连接状态和 shell 缓冲区行数
- notes: 读写服务器备注（配合 content 参数写入）
- sudo: 获取服务器的 sudo 密码（需在配置中设置 sudoPassword，或回退到登录 password）
- shortcuts: 列出当前（或指定 server 的）所有 shortcut 详情（名称/描述/参数 schema）

## Shortcuts（命名命令模板）
运维者可以在 ssh-servers.json 里为每个服务器预配置常用复杂命令（如 docker exec mysql 查询、tail 容器日志等）作为 shortcut。模型只需知道 shortcut 名和参数即可调用，复杂的命令拼接、容器内服务凭证完全对模型透明。

发现：
- ssh({ action: "list" }) 每个服务器条目里会带 shortcuts 名称数组
- 连接成功的响应里会带 shortcuts 摘要（含描述）
- ssh({ action: "shortcuts" }) 查当前服务器的 shortcut 详情（含 args schema）

调用：
- ssh({ shortcut: "mysql", args: { sql: "SELECT * FROM users LIMIT 5" } })
- 不带参数的简单 shortcut：ssh({ shortcut: "applog" })
- 多行内容（自动 heredoc）：ssh({ shortcut: "mysql_query", args: { sql: "SELECT 1;\\nSELECT 2;" } })
- 调试不执行：ssh({ shortcut: "mysql_query", args: {...}, dryRun: true })

特性：
- 全局 shortcut：配置文件顶层定义的 shortcut 对所有服务器生效；同名时该服务器自己的 shortcut 覆盖全局
- args 自动 shell-escape：command 模板里的 args 被自动单引号包裹，无需也不应在 args 值里手动加引号
- args 多行内容：当 shortcut 配置了 stdin 字段时，对应 args 通过 heredoc 字面量传递，可含任意换行/引号
- args 枚举校验：声明了 enum 的参数若传非法值，会立即报错
- args 默认值：声明了 default 的参数可不传，自动用默认值
- secrets：数据库密码等敏感配置仅用于服务端渲染，不会回传到模型上下文
- runsOn 元数据：标注 shortcut 实际执行的目标机器（用于 ssh 跳板等场景），不影响执行
- dryRun：返回渲染后的命令字符串但不执行，secrets 显示为 <secret:NAME> 占位符
- shortcut 在当前 PTY shell 中执行，行为和普通 command 一致，支持 timeout 参数

## 命令执行 (command)
直接提供 command 参数执行命令，支持交互式程序。

## Shell 控制
- read: 设为 true 读取缓冲区（配合 lines/offset/clear）
- signal: 发送信号 SIGINT(Ctrl+C)/SIGTSTP(Ctrl+Z)/SIGQUIT

## 智能输出检测
- 快速命令（<2秒）：检测到提示符后返回
- 慢速命令（2-5秒）：标记 slow=true
- 超时命令（>maxTimeout）：截断到最近 200 行，标记 truncated=true
- 持续输出：输出稳定后返回，标记 waiting=true

## timeout 参数
对于耗时较长的命令（如 pip install、apt upgrade、docker build 等），可以指定 timeout 参数（单位：秒，默认 5，最大 300）。
服务端会在 timeout 时间内持续等待命令完成，避免反复轮询浪费上下文。

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
ssh({ command: "pip install tensorflow", timeout: 120 })  # 等待最多 120 秒
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

### 服务器备注
ssh({ action: "notes" })                         # 读取当前服务器的备注
ssh({ action: "notes", content: "1panel 管理, openresty, *.example.com SSL" })  # 写入备注

### 获取 sudo 密码
ssh({ action: "sudo" })                          # 获取当前连接服务器的 sudo 密码
ssh({ action: "sudo", server: "my-server" })    # 获取指定服务器的 sudo 密码（无需先连接）

⚠️ 使用 sudo 密码时的安全建议：
- 优先用 sudo -S 从 stdin 读取，避免密码出现在 ps/history 中：
  ssh({ command: "echo '密码' | sudo -S -p '' your-command" })
- 如无必要，优先让目标机配置 NOPASSWD，避免密码流转

## 输出过长处理
如输出超过 8000 字符，完整内容会保存到本地文件，仅返回尾部摘要 + 文件路径，可通过 Read/Grep 工具查看。`,
      inputSchema: {
        action: z
          .enum(["list", "connect", "disconnect", "status", "notes", "sudo", "shortcuts"])
          .optional()
          .describe("连接管理操作"),
        server: z.string().optional().describe("服务器名称（connect 时必填）"),
        content: z.string().optional().describe("备注内容（notes 写入时使用）"),
        command: z.string().optional().describe("要执行的命令"),
        timeout: z.number().optional().describe("命令最大等待时间（秒），默认 5，最大 300。对于 pip install、apt upgrade 等长时间命令建议设置较大值"),
        read: z.boolean().optional().describe("读取缓冲区"),
        lines: z.number().optional().describe("读取行数，默认 20，-1 返回全部"),
        offset: z.number().optional().describe("读取起始偏移，默认 0"),
        clear: z.boolean().optional().describe("读取后清空缓冲区"),
        signal: z
          .enum(["SIGINT", "SIGTSTP", "SIGQUIT"])
          .optional()
          .describe("发送信号：SIGINT(Ctrl+C)/SIGTSTP(Ctrl+Z)/SIGQUIT"),
        shortcut: z.string().optional().describe("要执行的 shortcut 名称（运维预配置的命名命令）"),
        args: z.record(z.string()).optional().describe("shortcut 参数键值对，会被自动 shell-escape"),
        dryRun: z.boolean().optional().describe("仅用于 shortcut：渲染但不执行，secrets 显示为占位符"),
      },
    },
    async ({ action, server: serverName, content, command, timeout, read, lines, offset, clear, signal, shortcut, args, dryRun }): Promise<CallToolResult> => {
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
          const result = shellManager.read(lines, offset, clear);

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

        // 3a. 执行 shortcut（命名命令模板）
        if (shortcut) {
          const status = sshManager.getStatus();
          if (!status.connected) {
            return {
              content: [{ type: "text", text: "未连接服务器，请先使用 ssh({ action: 'connect', server: '服务器名' }) 连接" }],
              isError: true,
            };
          }

          const currentName = status.serverName!;
          const effective = configManager.getEffectiveShortcuts(currentName);
          if (!effective[shortcut]) {
            const available = Object.keys(effective);
            return {
              content: [{
                type: "text",
                text: `服务器 '${currentName}' 没有名为 '${shortcut}' 的 shortcut。可用: ${available.join(", ") || "（无）"}`,
              }],
              isError: true,
            };
          }

          // dryRun: 渲染后直接返回，secrets 占位符化，不执行
          if (dryRun) {
            let rendered: string;
            try {
              rendered = renderShortcut(shortcut, effective[shortcut], args ?? {}, "dryRun");
            } catch (e) {
              return {
                content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
                isError: true,
              };
            }
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  server: currentName,
                  shortcut,
                  args: args ?? {},
                  dryRun: true,
                  rendered,
                }, null, 2),
              }],
            };
          }

          let rendered: string;
          try {
            rendered = renderShortcut(shortcut, effective[shortcut], args ?? {});
          } catch (e) {
            return {
              content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
              isError: true,
            };
          }

          const shellManager = sshManager.getShellManager();
          const timeoutMs = timeout
            ? Math.min(Math.max(timeout, 5), 300) * 1000
            : undefined;
          const result = await shellManager.send(rendered, timeoutMs ? { maxTimeout: timeoutMs } : undefined);

          // 注意：不返回 rendered（含 secret 明文），只返回 shortcut name + args
          return {
            content: [{
              type: "text",
              text: truncateIfLarge({
                server: status.serverName,
                shortcut,
                args: args ?? {},
                ...result,
              }),
            }],
            isError: !result.complete && !result.waiting,
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
          const timeoutMs = timeout
            ? Math.min(Math.max(timeout, 5), 300) * 1000
            : undefined;
          const result = await shellManager.send(command, timeoutMs ? { maxTimeout: timeoutMs } : undefined);

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

            const list = [
              {
                name: LOCAL_SERVER.name,
                connected: status.serverName === LOCAL_SERVER.name,
                type: "built-in",
                notes: notesManager.readSummary(LOCAL_SERVER.name),
              },
              ...servers.map((s) => ({
                name: s.name,
                connected: status.serverName === s.name,
                type: "configured",
                notes: notesManager.readSummary(s.name),
                shortcuts: summarizeShortcuts(configManager.getEffectiveShortcuts(s.name), "names"),
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

            if (serverName === "local") {
              await sshManager.connect(LOCAL_SERVER);
              const notes = notesManager.read("local");
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    message: "成功连接到本地 Shell",
                    notes: notes || undefined,
                  }, null, 2),
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

            const notes = notesManager.read(serverName);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  message: `成功连接到 '${serverName}'，PTY Shell 已就绪`,
                  notes: notes || undefined,
                  shortcuts: summarizeShortcuts(configManager.getEffectiveShortcuts(serverName), "brief"),
                }, null, 2),
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

          case "notes": {
            const targetServer = serverName || sshManager.getStatus().serverName;
            if (!targetServer) {
              return {
                content: [{ type: "text", text: "请指定服务器名称（server 参数）或先连接服务器" }],
                isError: true,
              };
            }

            if (content !== undefined) {
              const path = notesManager.write(targetServer, content);
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    message: `备注已保存`,
                    server: targetServer,
                    path,
                  }, null, 2),
                }],
              };
            }

            const notes = notesManager.read(targetServer);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  server: targetServer,
                  notes: notes || "（暂无备注）",
                }, null, 2),
              }],
            };
          }

          case "sudo": {
            const targetServer = serverName || sshManager.getStatus().serverName;
            if (!targetServer) {
              return {
                content: [{ type: "text", text: "请指定服务器名称（server 参数）或先连接服务器" }],
                isError: true,
              };
            }

            if (targetServer === "local") {
              return {
                content: [{ type: "text", text: "本地连接不支持获取 sudo 密码" }],
                isError: true,
              };
            }

            const serverConfig = configManager.getServer(targetServer);
            if (!serverConfig) {
              return {
                content: [{ type: "text", text: `服务器 '${targetServer}' 不存在` }],
                isError: true,
              };
            }

            const sudoPassword = serverConfig.sudoPassword ?? serverConfig.password;
            if (!sudoPassword) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    server: targetServer,
                    hasPassword: false,
                    message: "未配置 sudoPassword，且该服务器使用密钥登录没有 password 可回退。请在配置文件中为该服务器添加 sudoPassword 字段，或在目标机配置 NOPASSWD。",
                  }, null, 2),
                }],
              };
            }

            const source = serverConfig.sudoPassword ? "sudoPassword" : "password (回退)";
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  server: targetServer,
                  source,
                  sudoPassword,
                  warning: "密码已进入上下文。使用时优先 `echo '密码' | sudo -S -p '' <命令>`，避免 ps/history 泄漏。",
                }, null, 2),
              }],
            };
          }

          case "shortcuts": {
            const targetServer = serverName || sshManager.getStatus().serverName;
            if (!targetServer) {
              return {
                content: [{ type: "text", text: "请指定服务器名称（server 参数）或先连接服务器" }],
                isError: true,
              };
            }

            if (targetServer === "local") {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({ server: "local", shortcuts: [] }, null, 2),
                }],
              };
            }

            const serverConfig = configManager.getServer(targetServer);
            if (!serverConfig) {
              return {
                content: [{ type: "text", text: `服务器 '${targetServer}' 不存在` }],
                isError: true,
              };
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  server: targetServer,
                  shortcuts: summarizeShortcuts(
                    configManager.getEffectiveShortcuts(targetServer),
                    "full",
                    (name) => configManager.getShortcutSource(targetServer, name)
                  ),
                }, null, 2),
              }],
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

  // SFTP 文件传输工具
  server.registerTool(
    "sftp",
    {
      description: `通过 SFTP 在本地和远程服务器之间传输文件。

需要先通过 ssh 工具连接服务器后才能使用。SFTP 通道会在首次调用时自动创建。

## 操作
- upload: 上传本地文件到远程服务器
- download: 从远程服务器下载文件到本地

## 使用示例
sftp({ action: "upload", localPath: "/tmp/config.json", remotePath: "/home/user/config.json" })
sftp({ action: "download", remotePath: "/var/log/app.log", localPath: "/tmp/app.log" })

## 注意
- 目录列表、文件删除、创建目录等操作请直接通过 ssh 工具执行 shell 命令
- 本地连接（local）不支持 SFTP`,
      inputSchema: {
        action: z
          .enum(["upload", "download"])
          .describe("传输操作：upload 上传 / download 下载"),
        localPath: z.string().describe("本地文件路径"),
        remotePath: z.string().describe("远程文件路径"),
      },
    },
    async ({ action, localPath, remotePath }): Promise<CallToolResult> => {
      try {
        const status = sshManager.getStatus();
        if (!status.connected) {
          return {
            content: [{ type: "text", text: "未连接服务器，请先使用 ssh({ action: 'connect', server: '服务器名' }) 连接" }],
            isError: true,
          };
        }

        if (sshManager.isLocal()) {
          return {
            content: [{ type: "text", text: "本地连接不支持 SFTP，请连接远程服务器后使用" }],
            isError: true,
          };
        }

        const client = sshManager.getClient();
        if (!client) {
          return {
            content: [{ type: "text", text: "SSH Client 不可用" }],
            isError: true,
          };
        }

        const sftpManager = sshManager.getSftpManager();

        if (action === "upload") {
          const result = await sftpManager.upload(client, localPath, remotePath);
          return {
            content: [{ type: "text", text: result }],
          };
        } else {
          const result = await sftpManager.download(client, remotePath, localPath);
          return {
            content: [{ type: "text", text: result }],
          };
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
