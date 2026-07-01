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
      description: `多机 hub 的文件操作：转发到当前（或 node 指定）node 的 daemon 执行。

⚠️ 关键心智模型：所有路径都以「目标 node 的 daemon 所在机」为原点，**不是**以 VPS 为原点。
在 mac node 上，localPath / path 指的是**那台 mac 的盘**；VPS 只是发起方，不自动充当任何一端。
（这条最容易搞反，"传不了"基本都因为把 VPS 当成了 local。）

## 四个操作
- upload:   localPath(daemon 机) → remotePath(该 node 当前 SSH 连着的 server)。二进制安全、无大小上限、不过 Claude 上下文。
- download: remotePath(当前连着的 server) → localPath(daemon 机)。同上。
- write:    把内联文本写到 path；按当前连接自动判断落在 daemon 本机(server=local)还是它连着的远端。
- read:     读 path 文本；判断同 write。

## upload/download 前必须先"连对端"
upload/download 传的是「daemon 机 ↔ 该 node **当前连着的** SSH server」之间。所以先用 ssh connect 把该 node 连到对端，再传：
- mac↔VPS：先 ssh({node:"macbook-air", action:"connect", server:"VIRCS"})   // VIRCS = 本 VPS
  然后 download = VPS→mac、upload = mac→VPS，二进制无损（已实测 sha256 一致）。
- mac↔某内网机：先 connect 到那台内网机(0.2 / 水网智科 / …)，再 upload/download。
- ❗连着 local（daemon 本机自己）时 upload/download 会被拒——同机文件操作用 write/read 或 ssh 的 cp/mv。
  vps 节点本身也是 local 连接，同样只有 write/read，没有 upload/download。

## write/read 只搬文本
utf8 文本、read 默认 1MB 上限、内容要过 Claude 上下文。适合小脚本/配置/SQL/yaml 落盘、跨机搬**小文本**。
二进制 / 大文件：一律走 upload/download（按上面"先连对端"的方式），别用 read→write 搬（会被 utf8 往返搞坏、被 1MB 截断）。`,
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
