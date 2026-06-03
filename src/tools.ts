import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SSHManager, LOCAL_SERVER } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { NotesManager } from "./notes-manager.js";
import { ShortcutConfig, ServerConfig } from "./types.js";
import { saveIfLarge } from "./output-store.js";
import { probeTcp } from "./net-probe.js";
import { SSH_INPUT_SHAPE, SFTP_INPUT_SHAPE } from "./tool-schemas.js";
import { renderShortcut, renderShortcutSplit } from "./shortcut-renderer.js";
import { execLocal, execRemote, ExecResult } from "./exec-runner.js";

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
 * 跑一条 exec（绕过 PTY）：local 走 child_process，远端走 ssh2 client.exec
 */
async function runExec(
  sshManager: SSHManager,
  command: string,
  stdin: string | undefined,
  timeoutMs: number | undefined
): Promise<ExecResult> {
  if (sshManager.isLocal()) {
    return execLocal(command, { stdin, timeoutMs });
  }
  const client = sshManager.getClient();
  if (!client) throw new Error("SSH Client 不可用（请先连接）");
  return execRemote(client, command, { stdin, timeoutMs });
}

/**
 * 把 ExecResult 包装成模型友好的 JSON。stdout/stderr 各自检查是否过大。
 */
function shapeExecResult(
  base: Record<string, unknown>,
  result: ExecResult
): string {
  const payload: Record<string, unknown> = {
    ...base,
    exitCode: result.exitCode,
    timedOut: result.timedOut || undefined,
    truncated: result.truncated || undefined,
    signal: result.signal,
    bytesStdout: result.bytesStdout,
    bytesStderr: result.bytesStderr,
    stdout: result.stdout,
    stderr: result.stderr || undefined,
    mode: "exec",
  };
  // 复用 truncateIfLarge：把 stdout 当作 output 字段过一遍
  // 单独处理：stdout 大时存盘
  const stdoutSave = saveIfLarge(result.stdout);
  if (stdoutSave.saved) {
    payload.stdout = stdoutSave.tail;
    payload._overflow = {
      totalChars: stdoutSave.totalChars,
      savedTo: stdoutSave.filePath,
      hint: `⚠️ stdout 过长（${stdoutSave.totalChars} 字符），完整内容保存至 ${stdoutSave.filePath}，仅显示尾部 2000 字符。`,
    };
  }
  return JSON.stringify(payload, null, 2);
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
- list: 列出所有可用服务器（每条带 online 端口探活 + 备注摘要 + 全局 hints）；传 onlineOnly=true 只列当前在线（反向隧道已连）的机器
- connect: 连接服务器（需提供 server 参数，自动附带完整备注 + 全局 hints + 该服务器 hints）
- disconnect: 断开当前连接
- status: 查看连接状态和 shell 缓冲区行数
- notes: 读写服务器备注（配合 content 参数写入）
- sudo: 获取服务器的 sudo 密码（需在配置中设置 sudoPassword，或回退到登录 password）
- shortcuts: 列出当前（或指定 server 的）所有 shortcut 详情（名称/描述/参数 schema）

## Hints（指令性提示）
运维者在 ssh-servers.json 顶层 globalHints 或服务器条目 hints 字段里配置的"模型必读"指引。
list 响应附带 globalHints；connect 响应附带 globalHints + 该服务器 hints。
典型用途：跨 MCP 拓扑决策、不要手动 cp jar、新特性提醒等。遇到 hints 字段务必按其指示行动。

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

### 默认路径：PTY shell（持久 session）
适合：cd / source / 启动 REPL / 跟踪日志 / 短促命令。环境（cwd / env / shell 状态）会被后续命令继承。

### 替代路径：exec 通道（独立、无 PTY）
触发条件：传入 stdin 参数 **或** 显式 exec=true。
适合：
- 多行内容做命令的 stdin（kubectl apply -f -、python3 -、psql、jq 等）—— **必用** exec，PTY heredoc 极易被 bracketed-paste 弄花
- 任何只关心 stdout/stderr/exitCode 的一次性命令
exec 路径**不继承** PTY shell 当前 cwd 和 env，每次都是 sshd 默认环境（远端）/ daemon cwd（local）。
如果命令依赖前一句 cd 后的工作目录，要么显式 'cd /xxx && your-cmd' 一次写完，要么继续走 PTY。

## Shell 控制
- read: 设为 true 读取缓冲区（配合 lines/offset/clear）
- signal: 发送信号
  - SIGINT(Ctrl+C) / SIGTSTP(Ctrl+Z) / SIGQUIT
  - RESET：Ctrl-C → 等待 → Ctrl-U → 换行。卡在 heredoc>/dquote>/cmdand 续行 prompt 时用，比单 SIGINT 狠
- action=reset_shell：保留 SSH 连接，**关掉当前 PTY shell 重开一条**。RESET 都救不回来时用，比 disconnect+reconnect 快

## 输出清洗
返回的 output 默认经过清洗：ANSI 控制序列、PTY 命令回显、bracketed-paste 标记、
末尾 prompt 行都已剥离，只剩命令真实 stdout/stderr。需要原始 PTY 流时传 read({ raw: true })。

## 完成检测（sentinel）
默认在用户命令后追加一条 sentinel printf，见到 __MCP_DONE_<id>_<rc>__ 即视为完成，
并在 result 里填 exitCode 字段。比传统 prompt 正则更稳，能直接判断成功失败。
sentinel 字样会从输出里自动剥掉。

启动 REPL（mysql/python/redis-cli/ssh 跳板）或向 REPL 内部输入子命令时，
必须带 interactive=true 跳过 sentinel 包装，否则 sentinel printf 会被打进 REPL 当输入。

## 智能输出检测（fallback / interactive 模式）
- 快速命令（<2秒）：检测到提示符后返回
- 慢速命令（2-5秒）：标记 slow=true
- 超时命令（>maxTimeout）：截断到最近 200 行，标记 truncated=true
- 持续输出：输出稳定后返回，标记 waiting=true

## 命令疑似挂住（waiting=true / 长时间无输出）排查
首先怀疑 stdout 全缓冲（pipe / 重定向 / 非 TTY 场景常见，命令明明在跑但缓冲到几 KB 才 flush）：
- python: 命令前加 -u，或 PYTHONUNBUFFERED=1 python ...
- 通用 unix 命令: stdbuf -oL -eL <cmd>（mac 自带的 stdbuf 名字是 gstdbuf，需 brew install coreutils）
- mac 没装 coreutils 兜底: script -q /dev/null <cmd>（macOS 自带 script，能强制行缓冲）
- tail 跟日志: tail -F 配合 --line-buffered（grep 也支持 --line-buffered）

## timeout 参数
对于耗时较长的命令（如 pip install、apt upgrade、docker build 等），可以指定 timeout 参数（单位：秒，默认 5，最大 300）。
服务端会在 timeout 时间内持续等待命令完成，避免反复轮询浪费上下文。

## 返回字段
- output: 命令输出（已清洗）
- totalLines: 原始 PTY 行数
- complete: 是否完成
- exitCode: 命令退出码（仅 sentinel 模式成功捕获时存在；undefined 表示未捕获）
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

### 通过 stdin 喂多行内容（exec 通道）
ssh({ command: "python3 -", stdin: "import json\\nprint(json.dumps({'ok':1}))" })
ssh({ command: "kubectl apply -f -", stdin: "<整段 yaml>" })
ssh({ command: "psql -d mydb", stdin: "SELECT 1;\\nSELECT 2;" })

### 仅想要干净 exec（拿 exitCode 不污染 PTY）
ssh({ command: "make test", exec: true, timeout: 120 })

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
      inputSchema: SSH_INPUT_SHAPE,
    },
    async ({ action, server: serverName, content, command, timeout, read, lines, offset, clear, signal, shortcut, args, dryRun, interactive, raw, stdin, exec, onlineOnly }): Promise<CallToolResult> => {
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
          let success: boolean;
          if (signal === "RESET") {
            success = await shellManager.resetLine();
          } else {
            success = shellManager.sendSignal(signal);
          }

          return {
            content: [{
              type: "text",
              text: success
                ? (signal === "RESET" ? "已发送复位序列（Ctrl-C + Ctrl-U + 换行）" : `已发送 ${signal}`)
                : `发送 ${signal} 失败`,
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
          const result = shellManager.read(lines, offset, clear, raw);

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

          let split;
          try {
            split = renderShortcutSplit(shortcut, effective[shortcut], args ?? {});
          } catch (e) {
            return {
              content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
              isError: true,
            };
          }

          const timeoutMs = timeout
            ? Math.min(Math.max(timeout, 5), 300) * 1000
            : undefined;

          // shortcut 配置了 stdin 或调用方显式 exec=true：走 exec 通道（绕开 PTY）
          if (split.stdin !== undefined || exec) {
            try {
              const execResult = await runExec(sshManager, split.command, split.stdin, timeoutMs);
              return {
                content: [{
                  type: "text",
                  text: shapeExecResult(
                    {
                      server: status.serverName,
                      shortcut,
                      args: args ?? {},
                    },
                    execResult
                  ),
                }],
                isError: execResult.exitCode !== 0 && !execResult.timedOut,
              };
            } catch (e) {
              return {
                content: [{ type: "text", text: `exec 失败: ${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              };
            }
          }

          // 默认路径：仍走 PTY shell（保留 cwd / env / interactive 行为）
          const shellManager = sshManager.getShellManager();
          const result = await shellManager.send(
            split.command,
            timeoutMs ? { maxTimeout: timeoutMs } : undefined,
            { interactive: interactive ?? false }
          );

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

          const timeoutMs = timeout
            ? Math.min(Math.max(timeout, 5), 300) * 1000
            : undefined;

          // 传了 stdin 或显式 exec=true：走独立 exec 通道，不污染 PTY shell
          if (stdin !== undefined || exec) {
            try {
              const execResult = await runExec(sshManager, command, stdin, timeoutMs);
              return {
                content: [{
                  type: "text",
                  text: shapeExecResult(
                    { server: status.serverName, command },
                    execResult
                  ),
                }],
                isError: execResult.exitCode !== 0 && !execResult.timedOut,
              };
            } catch (e) {
              return {
                content: [{ type: "text", text: `exec 失败: ${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              };
            }
          }

          const shellManager = sshManager.getShellManager();
          const result = await shellManager.send(
            command,
            timeoutMs ? { maxTimeout: timeoutMs } : undefined,
            { interactive: interactive ?? false }
          );

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

            // 端口探活：判断每台机器当前是否可达（≈ 反向隧道是否在线）。
            // - 直连 / 隧道暴露（127.0.0.1:220x）：直接探 host:port
            // - proxyJump：探跳板机端口（跳板通了链路才可能通）
            // - proxy(SOCKS)：无法直接探，online 留 undefined（未知，不误判离线）
            const probeServer = (s: ServerConfig): Promise<boolean | undefined> => {
              if (s.proxy) return Promise.resolve(undefined);
              if (s.proxyJump) return probeTcp(s.proxyJump.host, s.proxyJump.port ?? 22);
              return probeTcp(s.host, s.port || 22);
            };
            const onlineFlags = await Promise.all(servers.map(probeServer));

            const list = [
              {
                name: LOCAL_SERVER.name,
                online: true, // local 就是 MCP 自身所在机器，永远在线
                connected: status.serverName === LOCAL_SERVER.name,
                type: "built-in",
                notes: notesManager.readSummary(LOCAL_SERVER.name),
                shortcuts: summarizeShortcuts(configManager.getEffectiveShortcuts("local"), "names"),
              },
              ...servers.map((s, i) => ({
                name: s.name,
                online: onlineFlags[i],
                connected: status.serverName === s.name,
                type: "configured",
                notes: notesManager.readSummary(s.name),
                shortcuts: summarizeShortcuts(configManager.getEffectiveShortcuts(s.name), "names"),
              })),
            ];

            // onlineOnly：滤掉明确离线的（online===false）；未知（undefined）保留
            const visible = onlineOnly ? list.filter((e) => e.online !== false) : list;

            const hints = configManager.getGlobalHints();
            const payload: Record<string, unknown> = { servers: visible };
            if (hints) payload.hints = hints;

            return {
              content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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
              const globalHints = configManager.getGlobalHints();
              const localHints = configManager.getServerHints("local");
              const mergedHints = [
                ...(globalHints ?? []),
                ...(localHints ?? []),
              ];
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    message: "成功连接到本地 Shell",
                    notes: notes || undefined,
                    shortcuts: summarizeShortcuts(configManager.getEffectiveShortcuts("local"), "brief"),
                    hints: mergedHints.length > 0 ? mergedHints : undefined,
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

            try {
              await sshManager.connect(serverConfig);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              const offlineish = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(msg);
              return {
                content: [{
                  type: "text",
                  text: offlineish
                    ? `无法连接 '${serverName}'：${msg}\n该机器可能不在线（反向隧道未连）。用 ssh({ action: "list" }) 看 online 状态。`
                    : `连接 '${serverName}' 失败：${msg}`,
                }],
                isError: true,
              };
            }

            const notes = notesManager.read(serverName);
            const globalHints = configManager.getGlobalHints();
            const serverHints = configManager.getServerHints(serverName);
            const mergedHints = [
              ...(globalHints ?? []),
              ...(serverHints ?? []),
            ];
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  message: `成功连接到 '${serverName}'，PTY Shell 已就绪`,
                  notes: notes || undefined,
                  shortcuts: summarizeShortcuts(configManager.getEffectiveShortcuts(serverName), "brief"),
                  hints: mergedHints.length > 0 ? mergedHints : undefined,
                }, null, 2),
              }],
            };
          }

          case "reset_shell": {
            const status = sshManager.getStatus();
            if (!status.connected) {
              return {
                content: [{ type: "text", text: "未连接，无法重置 shell" }],
                isError: true,
              };
            }
            try {
              await sshManager.resetShell();
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    message: "已重置 PTY shell（SSH 连接保留）",
                    server: status.serverName,
                  }, null, 2),
                }],
              };
            } catch (e) {
              return {
                content: [{ type: "text", text: `reset_shell 失败: ${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              };
            }
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
                  text: JSON.stringify({
                    server: "local",
                    shortcuts: summarizeShortcuts(
                      configManager.getEffectiveShortcuts("local"),
                      "full",
                      (name) => configManager.getShortcutSource("local", name)
                    ),
                  }, null, 2),
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
      description: `文件操作工具。可以在本机/远程之间传文件，也可以直接把内联文本写到任意一端。

需要先通过 ssh 工具连接服务器后才能使用。SFTP 通道会在首次调用时自动创建（远端连接）。

## 操作
- upload: 上传本地文件到远程（仅远程连接）
- download: 从远程下载文件到本地（仅远程连接）
- write:    把内联文本直接写到目标文件（local / 远程都支持）
- read:     直接读出目标文件文本内容（local / 远程都支持）

## 何时用 write 而不是 ssh.command
**强烈推荐**任何"多行内容落盘"场景都用 sftp.write，不要用 ssh.command 拼 cat heredoc / echo / base64 decode：
- write 不走 PTY，没有 bracketed-paste、续行 prompt、sentinel 包装这一堆问题
- 任意换行/引号/反斜杠都能字面量保留，不用考虑转义层数
- 典型场景：临时脚本、配置补丁、SQL 文件、Dockerfile、k8s yaml

## 使用示例

### 在 local（daemon 所在机器）写脚本
sftp({ action: "write", path: "/tmp/run.sh", content: "#!/bin/bash\\nset -e\\n...", mode: 493 })   // 0o755 = 493

### 写远端配置文件，父目录自动建
sftp({ action: "write", path: "/etc/myapp/conf.d/x.toml", content: "...", mkdirs: true })

### 读 local 文件
sftp({ action: "read", path: "/var/log/app.log" })

### 文件 → 文件 传输（旧 upload/download 接口仍保留）
sftp({ action: "upload", localPath: "/tmp/big.tar.gz", remotePath: "/srv/big.tar.gz" })
sftp({ action: "download", remotePath: "/var/log/app.log", localPath: "/tmp/app.log" })

## 参数说明
- path:     write/read 时使用，根据当前连接是 local 还是远程自动判断目标
- content:  write 时必填，纯文本（utf-8）
- mode:     write 时可选，权限位（十进制数，如 0o755 写成 493；默认 0o644 = 420）
- mkdirs:   write 时可选，父目录不存在自动 mkdir -p
- maxBytes: read 时可选，最大读取字节，超过会截断并标记 truncated（默认 1MB）

## 注意
- 目录列表、文件删除、改权限等操作仍走 ssh 工具的 shell 命令
- 上传时仍禁止 id_rsa / .pem / authorized_keys 等敏感文件名（防止误传密钥）`,
      inputSchema: SFTP_INPUT_SHAPE,
    },
    async ({ action, localPath, remotePath, path, content, mode, mkdirs, maxBytes }): Promise<CallToolResult> => {
      try {
        const status = sshManager.getStatus();
        if (!status.connected) {
          return {
            content: [{ type: "text", text: "未连接服务器，请先使用 ssh({ action: 'connect', server: '服务器名' }) 连接" }],
            isError: true,
          };
        }

        const sftpManager = sshManager.getSftpManager();
        const isLocal = sshManager.isLocal();

        // upload / download：走传统 SFTP，仍只支持远端连接
        if (action === "upload" || action === "download") {
          if (isLocal) {
            return {
              content: [{ type: "text", text: "local 连接不支持 upload/download；同机文件操作请用 sftp({action:'write'/'read'}) 或 ssh.command(cp/mv)" }],
              isError: true,
            };
          }
          if (!localPath || !remotePath) {
            return {
              content: [{ type: "text", text: "upload/download 需要同时提供 localPath 和 remotePath" }],
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
          const result = action === "upload"
            ? await sftpManager.upload(client, localPath, remotePath)
            : await sftpManager.download(client, remotePath, localPath);
          return { content: [{ type: "text", text: result }] };
        }

        // write / read：local 走 fs，远端走 SFTP
        if (!path) {
          return {
            content: [{ type: "text", text: `${action} 需要提供 path 参数` }],
            isError: true,
          };
        }

        if (action === "write") {
          if (content === undefined) {
            return {
              content: [{ type: "text", text: "write 需要提供 content 参数" }],
              isError: true,
            };
          }
          const writeResult = isLocal
            ? await sftpManager.writeLocalFile(path, content, { mkdirs, mode })
            : await sftpManager.writeRemote(sshManager.getClient()!, path, content, { mkdirs, mode });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                action: "write",
                target: isLocal ? "local" : status.serverName,
                ...writeResult,
              }, null, 2),
            }],
          };
        }

        // read
        const readResult = isLocal
          ? await sftpManager.readLocalFile(path, { maxBytes })
          : await sftpManager.readRemote(sshManager.getClient()!, path, { maxBytes });
        return {
          content: [{
            type: "text",
            text: truncateIfLarge({
              action: "read",
              target: isLocal ? "local" : status.serverName,
              path: readResult.path,
              bytes: readResult.bytes,
              truncated: readResult.truncated,
              output: readResult.content,
            }),
          }],
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
}
