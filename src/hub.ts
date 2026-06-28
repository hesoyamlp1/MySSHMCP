import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HubClientManager } from "./hub-client.js";
import { probeTcp } from "./net-probe.js";
import { SSH_INPUT_SHAPE, SFTP_INPUT_SHAPE } from "./tool-schemas.js";

function textResult(obj: unknown, isError = false): CallToolResult {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }], isError };
}

/** 从下游 CallToolResult 里取第一段 text（用于解析下游 list 的 JSON） */
function firstText(result: CallToolResult): string | undefined {
  const c = result.content?.[0];
  if (c && c.type === "text") return c.text;
  return undefined;
}

/**
 * 构造 hub 模式的 MCP server：对 Claude 只露一个 ssh / sftp，
 * 内部按 node 路由到各 mac daemon。
 */
export function buildHubServer(mgr: HubClientManager, version: string): McpServer {
  const server = new McpServer({ name: "ssh-hub", version });

  const nodes = mgr.listNodes();
  // 只有一个 node 时默认选中它，单机使用无需每次带 node
  const state: { currentNode?: string } = {
    currentNode: nodes.length === 1 ? nodes[0].name : undefined,
  };

  const nodeParam = z
    .string()
    .optional()
    .describe("目标机器（hub node 名，如 mac1/mac2）。不传则沿用当前 node；connect 时带上即把当前 node 切到它");

  /** 探一个 node 是否在线：local 永远在线；远程探 HTTP 端口能否连上 */
  async function probeNode(name: string): Promise<boolean | undefined> {
    const node = mgr.getNode(name);
    if (!node) return undefined;
    if (node.local) return true;
    if (!node.url) return undefined;
    try {
      const u = new URL(node.url);
      const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
      return await probeTcp(u.hostname, port);
    } catch {
      return undefined;
    }
  }

  /** hub 级 list：列出所有 node + online + 各 node 自己的 server 名 */
  async function hubList(): Promise<CallToolResult> {
    const entries = await Promise.all(
      mgr.listNodes().map(async (n) => {
        const online = await probeNode(n.name);
        const entry: Record<string, unknown> = {
          node: n.name,
          online,
          current: n.name === state.currentNode,
        };
        if (n.note) entry.note = n.note; // hub.json 里的简短标注，离线也显示
        if (online) {
          // best-effort：拉该 node 自己的 server 列表（local + 它的内网机）。
          // 短超时：端口在 listen 但 daemon 半死时，list 整体也别被一个 node 拖住。
          try {
            const r = await mgr.callTool(n.name, "ssh", { action: "list" }, { timeoutMs: 5000 });
            const txt = firstText(r);
            if (txt) {
              const parsed = JSON.parse(txt);
              if (Array.isArray(parsed.servers)) {
                entry.servers = parsed.servers.map((s: { name?: string }) => s.name);
              }
            }
          } catch {
            /* 拉不到子列表不致命 */
          }
        }
        return entry;
      })
    );
    return textResult({ nodes: entries, currentNode: state.currentNode });
  }

  server.registerTool(
    "ssh",
    {
      description: `多机 hub：一个 MCP 统一管理多台 mac（每台仍是它自己的 HTTP daemon 在干活）。

寻址两层：
- node 参数选「哪台 mac」；现有的 server 参数选「该 mac 内部哪台」（local=mac 本机 / 它的内网机）。

常用：
- ssh({action:"list"})                           列出所有 node + online 在线状态 + 各 node 的 server 名
- ssh({node:"mac2", action:"connect", server:"local"})  连 mac2 本机；之后不带 node 的调用都走 mac2
- ssh({command:"..."})                           在当前 node 的当前连接上执行
- ssh({node:"mac1", action:"connect", server:"0.2"})    连 mac1 背后的内网机（mac1 一跳）

其余 action / command / shortcut / read / signal / timeout / stdin / mode 等语义与单机 ssh 工具完全一致，原样转发到目标 node 的 daemon。多台 mac 的连接互相独立、可同时活着；切 node 不影响其它 node 上正在跑的东西（长任务照例丢 tmux）。

命令默认走 exec 通道（无头、一发一收、直接拿 exitCode、输出无需清洗、绝不会卡死 session）。只有交互式 REPL / TUI / tail -f + Ctrl-C / 需保留 cwd 的多步操作才用 mode:"pty"。

🚫 仅 mode:"pty" 的铁律：pty 模式下 command 绝不内联 heredoc（<<EOF）、绝不留未闭合的引号/反斜杠/行尾管道——会让 shell 卡在 heredoc>/quote> 续行符上、sentinel 被当正文吞掉→整条 session 报废。多行内容：① 写文件 → sftp({action:"write"})；② 喂 stdin（python3 - / kubectl apply -f - / psql / jq）→ stdin 参数（默认就是 exec 通道）；③ 非要内联 → 单行 printf。万一已卡在 heredoc>/quote> → 先 signal:"RESET"，救不回来再 action:"reset_shell"。`,
      inputSchema: { node: nodeParam, ...SSH_INPUT_SHAPE },
    },
    async (rawArgs): Promise<CallToolResult> => {
      try {
        const { node, ...rest } = rawArgs as { node?: string } & Record<string, unknown>;
        if (typeof node === "string" && node) state.currentNode = node;

        const action = rest.action as string | undefined;

        // 未显式指定 node 的 list → hub 级聚合列表
        if (action === "list" && !node) {
          return await hubList();
        }

        const target = state.currentNode;
        if (!target) {
          return textResult(
            "还没选机器。先 ssh({action:'list'}) 看有哪些 node，再带 node 参数，例如 ssh({node:'mac1', action:'connect', server:'local'})。",
            true
          );
        }
        if (!mgr.getNode(target)) {
          return textResult(`未知 node: ${target}（ssh({action:'list'}) 看可用 node）`, true);
        }

        try {
          return await mgr.callTool(target, "ssh", rest);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return textResult(
            `node '${target}' 调用失败：${msg}\n该 mac 的 daemon 可能不在线（反向隧道 / HTTP daemon 未连）。ssh({action:"list"}) 看 online。`,
            true
          );
        }
      } catch (e) {
        return textResult(`hub 错误：${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.registerTool(
    "sftp",
    {
      description: `多机 hub 的文件操作：转发到当前（或 node 指定）的 mac daemon 的 sftp。
语义与单机 sftp 完全一致（upload/download/write/read）；文件在该 mac 与它的目标之间直接传，不经 VPS 中转。`,
      inputSchema: {
        node: z
          .string()
          .optional()
          .describe("目标 mac node 名；不传用当前 node。传了会把当前 node 切到它（影响之后不带 node 的 ssh/sftp）"),
        ...SFTP_INPUT_SHAPE,
      },
    },
    async (rawArgs): Promise<CallToolResult> => {
      try {
        const { node, ...rest } = rawArgs as { node?: string } & Record<string, unknown>;
        if (typeof node === "string" && node) state.currentNode = node;
        const target = state.currentNode;
        if (!target) {
          return textResult("还没选机器，先用 ssh({node:'mac1', action:'connect', ...}) 连一个 node。", true);
        }
        try {
          return await mgr.callTool(target, "sftp", rest);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return textResult(`node '${target}' sftp 失败：${msg}`, true);
        }
      } catch (e) {
        return textResult(`hub 错误：${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  return server;
}
