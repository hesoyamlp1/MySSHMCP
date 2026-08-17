import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserClientManager, loadCachedTools } from "./browser-client.js";
import { BrowserHubConfig, BrowserNode, routeFor } from "./browser-config.js";
import { SNAPSHOT_TOOLS } from "./browser-tools-snapshot.js";

/**
 * browser-hub：对 Claude 露出上游 playwright 那一整套原生 browser_* 工具（原样透传），
 * 外加一个 browser_node 用来选机器。
 *
 * 为什么用底层 Server 而不是 McpServer：McpServer.registerTool 只吃 zod schema
 * （SDK 1.25 的 AnySchema = ZodTypeAny | $ZodType），而透传的价值就在于把上游的
 * JSON Schema 一个字不改地报给 Claude。代理场景自己实现 tools/list + tools/call 最直接。
 */

/** 同一台机器上活跃的会话（跨会话共享，用来做 concurrency 限制） */
const ACTIVE_BY_NODE = new Map<string, Set<object>>();

function activeCount(node: string): number {
  return ACTIVE_BY_NODE.get(node)?.size ?? 0;
}

function markActive(node: string, owner: object): void {
  let s = ACTIVE_BY_NODE.get(node);
  if (!s) {
    s = new Set();
    ACTIVE_BY_NODE.set(node, s);
  }
  s.add(owner);
}

function unmarkAll(owner: object): void {
  for (const [node, s] of ACTIVE_BY_NODE) {
    s.delete(owner);
    if (s.size === 0) ACTIVE_BY_NODE.delete(node);
  }
}

function textResult(obj: unknown, isError = false): CallToolResult {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }], isError };
}

/** 在上游返回的结果最前面插一行说明（只在为本会话首次选定机器时用） */
function prependNote(result: CallToolResult, note: string): CallToolResult {
  return {
    ...result,
    content: [{ type: "text", text: note }, ...(result.content ?? [])],
  };
}

const BROWSER_NODE_TOOL: Tool = {
  name: "browser_node",
  description:
    "选择/查看在哪台机器上开浏览器。浏览器全部跑在远程机器（三台 mac）上，VPS 本机不跑。\n" +
    "- action:\"list\"：列出所有机器 + 在线状态 + 各自有哪些站的登录态 + 能到哪些网络 + 路由规则\n" +
    '- action:"connect", node:"macbook-air"：选定机器（daemon 没起会自动拉起），之后本会话所有 browser_* 都在它上面跑\n' +
    '- action:"status"：当前用的是哪台\n' +
    '- action:"down"：停掉那台机器上的 daemon 释放内存\n' +
    '- action:"relogin"：打印怎么刷新那台机器的登录态（要人在 mac 上登一次 SSO）\n' +
    "没 connect 过时直接 browser_navigate 也行：会按 URL 自动选机器（公司域名→公司的 mac，家里网段→家里的 mac）。",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "connect", "status", "down", "relogin"],
        description: "要做什么；默认 list",
      },
      node: {
        type: "string",
        description: "目标机器名（connect/down/relogin 用；只有一台机器时可省）",
      },
    },
    additionalProperties: false,
  },
};

/** 上游那些工具里，参数带秒数、需要放大请求超时的 */
function timeoutForCall(args: Record<string, unknown>): number | undefined {
  const t = args.time;
  if (typeof t === "number" && t > 60) return (t + 60) * 1000;
  return undefined;
}

export function buildBrowserHubServer(
  cfg: BrowserHubConfig,
  mgr: BrowserClientManager,
  version: string
): { server: Server; close: () => Promise<void> } {
  const server = new Server(
    { name: "browser-hub", version },
    { capabilities: { tools: {} } }
  );

  /** 本会话的身份标识，用于 concurrency 记账 */
  const owner = {};

  const state: {
    currentNode?: string;
    announced: Set<string>;
  } = { announced: new Set() };

  // 工具清单：进程内拉到一次就固定下来（同一份 playwright 版本，清单不会变）
  let resolvedTools: Tool[] | undefined;

  function withBrowserNode(upstream: Tool[]): Tool[] {
    return [BROWSER_NODE_TOOL, ...upstream.filter((t) => t.name !== "browser_node")];
  }

  /**
   * 工具清单三级兜底：在线上游实时拉 > 磁盘缓存（上次拉到的）> 仓库内置快照。
   * tools/list 不拉起任何 daemon——只问已经在跑的那些，避免列工具产生副作用。
   */
  async function resolveTools(): Promise<Tool[]> {
    if (resolvedTools) return resolvedTools;

    for (const n of mgr.listNodes()) {
      if (!(await mgr.probe(n.name))) continue;
      try {
        const t = await mgr.listTools(n.name);
        if (t.length > 0) {
          resolvedTools = withBrowserNode(t);
          return resolvedTools;
        }
      } catch {
        /* 换下一台 */
      }
    }

    const disk = loadCachedTools();
    if (disk) return withBrowserNode(disk);
    return withBrowserNode(SNAPSHOT_TOOLS);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await resolveTools(),
  }));

  /** 只有一台机器时默认选它，省得每次都要 connect */
  function soleNode(): string | undefined {
    const all = mgr.listNodes();
    return all.length === 1 ? all[0].name : undefined;
  }

  function nodeSummary(n: BrowserNode): Record<string, unknown> {
    const b = n.browser;
    const entry: Record<string, unknown> = { node: n.name };
    if (b.logins && b.logins.length > 0) entry.logins = b.logins;
    else entry.logins = "（没配登录态清单；要登录的站可能进不去）";
    if (b.reach) entry.reach = b.reach;
    if (b.concurrency) entry.concurrency = `${activeCount(n.name)}/${b.concurrency} 个会话在用`;
    if (b.note) entry.note = b.note;
    return entry;
  }

  /** concurrency 限制：满了就明确说换哪台，别让它变成上游的费解报错 */
  function checkConcurrency(name: string): void {
    const node = mgr.getNode(name);
    const limit = node?.browser.concurrency;
    if (!limit) return;
    // 本会话已经占着位子就不再算一次
    if (mgr.isConnected(name)) return;
    if (activeCount(name) >= limit) {
      const others = mgr
        .listNodes()
        .filter((n) => n.name !== name && activeCount(n.name) < (n.browser.concurrency ?? 99))
        .map((n) => n.name);
      throw new Error(
        `${name} 上已经有 ${activeCount(name)} 个会话在用浏览器（上限 ${limit}）。\n` +
          (others.length > 0
            ? `换一台：${others.join(" / ")}（browser_node({action:"connect", node:"..."})）`
            : `其它机器也满了或没铺，等一会儿，或者去某台跑 browser_node({action:"down"}) 释放。`)
      );
    }
  }

  /** 选定并准备好一台机器：拉起 daemon、建连接、记账 */
  async function useNode(name: string): Promise<{ detail: string }> {
    if (!mgr.getNode(name)) {
      throw new Error(
        `未知机器 '${name}'。现有：${mgr.listNodes().map((n) => n.name).join(", ")}`
      );
    }
    checkConcurrency(name);
    const { alreadyUp, detail } = await mgr.ensureUp(name);
    // 建立上游连接（同时刷新工具缓存）；失败要如实抛，别让后面的调用报更含糊的错
    await mgr.listTools(name);
    state.currentNode = name;
    markActive(name, owner);
    return { detail: alreadyUp ? detail : detail };
  }

  /**
   * 一次透传调用该去哪台机器。
   * - 已经选定过就用它（不因为 URL 属于别的机器就自动改——那会丢掉当前页面）
   * - 没选定过：navigate 带 url 时按路由表选；其它工具让调用方先 connect
   */
  async function pickNodeFor(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ node: string; note?: string }> {
    if (state.currentNode) return { node: state.currentNode };

    const sole = soleNode();
    if (sole) return { node: sole };

    const url = typeof args.url === "string" ? args.url : undefined;
    if (url) {
      const hit = routeFor(url, cfg.routes);
      if (hit) {
        const online = await mgr.probe(hit.node);
        if (!online && hit.fallback) {
          return {
            node: hit.fallback,
            note:
              `已自动路由到 ${hit.fallback}（规则 ${hit.matched} 本来指向 ${hit.node}，` +
              `但它现在不在线，用了 fallback）`,
          };
        }
        return {
          node: hit.node,
          note: `已自动路由到 ${hit.node}（规则 ${hit.matched}）`,
        };
      }
    }

    throw new Error(
      `还没选机器，而且${url ? `这个 URL 没有路由规则命中` : `这个工具没带 url、没法自动选`}。\n` +
        `先 browser_node({action:"list"}) 看有哪些机器（各自有什么登录态、能到哪些网络），` +
        `再 browser_node({action:"connect", node:"..."})。`
    );
  }

  async function handleBrowserNode(args: Record<string, unknown>): Promise<CallToolResult> {
    const action = (typeof args.action === "string" ? args.action : "list") as string;
    const wanted = typeof args.node === "string" ? args.node : undefined;

    if (action === "list") {
      const entries = await Promise.all(
        mgr.listNodes().map(async (n) => {
          const online = await mgr.probe(n.name);
          return {
            ...nodeSummary(n),
            daemon: online ? "在跑" : "没起（connect 时会自动拉起）",
            current: n.name === state.currentNode,
          };
        })
      );
      return textResult({
        机器: entries,
        当前: state.currentNode ?? "（还没选）",
        路由规则: cfg.routes.map((r) => ({
          匹配: r.match.join(" | "),
          去: r.node + (r.fallback ? `（备 ${r.fallback}）` : ""),
        })),
        说明:
          "浏览器全部跑在远程机器上，VPS 本机不跑（内存）。没 connect 过时 " +
          "browser_navigate 会按上面的规则自动选机器。",
      });
    }

    if (action === "status") {
      if (!state.currentNode) {
        return textResult({
          当前: "（还没选机器）",
          提示: '直接 browser_navigate 会按 URL 自动选；或 browser_node({action:"connect", node:"..."})',
        });
      }
      const n = mgr.getNode(state.currentNode)!;
      const last = mgr.lastUsedAt(state.currentNode);
      return textResult({
        当前: state.currentNode,
        ...nodeSummary(n),
        本会话已连接: mgr.isConnected(state.currentNode),
        最后一次调用: last ? new Date(last).toISOString() : "（本会话还没调用过）",
        daemon: (await mgr.probe(state.currentNode)) ? "在跑" : "不在跑",
      });
    }

    if (action === "connect") {
      const name = wanted ?? soleNode();
      if (!name) {
        throw new Error(
          `connect 要指定 node。现有：${mgr.listNodes().map((n) => n.name).join(", ")}` +
            `（先 browser_node({action:"list"}) 看各自的登录态和可达网络）`
        );
      }
      const { detail } = await useNode(name);
      const n = mgr.getNode(name)!;
      return textResult({
        已选定: name,
        daemon: detail,
        ...nodeSummary(n),
        下一步: "照常用 browser_navigate / browser_snapshot 等原生工具，它们都会在这台机器上执行",
      });
    }

    if (action === "down") {
      const name = wanted ?? state.currentNode ?? soleNode();
      if (!name) throw new Error("down 要指定 node（或者先 connect 一台）");
      const out = await mgr.down(name);
      unmarkAll(owner);
      if (state.currentNode === name) state.currentNode = undefined;
      return textResult({ 已停: name, 输出: out });
    }

    if (action === "relogin") {
      const name = wanted ?? state.currentNode ?? soleNode();
      if (!name) throw new Error("relogin 要指定 node");
      const n = mgr.getNode(name);
      if (!n) throw new Error(`未知机器 '${name}'`);
      return textResult({
        机器: name,
        为什么要人工:
          "登录态是一份 storageState（cookie）文件，isolated 浏览器从它注入。刷新它要真的登一次 SSO。",
        步骤: [
          `1. 用户在 ${name} 上开盖（headful 浏览器要有图形会话）`,
          `2. 在那台机器上跑：bash ~/.mori/browser/relogin.sh`,
          `   它起一个独占的持久 profile（--user-data-dir ~/.mori/browser/profile/company）、headful`,
          `3. 在弹出的浏览器里登一次 SSO`,
          `4. 脚本导出 storageState 到 ~/.mori/browser/state/company.json（权限 600）并关掉持久 daemon`,
          `5. 回来跑 browser_node({action:"down", node:"${name}"}) 再 connect，新登录态即生效`,
        ],
        注意: [
          "storageState 只带 cookie，不带 localStorage——靠 localStorage 存 token 的站这样注入不全",
          "那个 json 是明文 SSO cookie：权限 600、不入 git、不跨机传",
        ],
        当前声明的登录态: n.browser.logins ?? "（未配置）",
      });
    }

    throw new Error(`未知 action: ${action}`);
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      if (toolName === "browser_node") return await handleBrowserNode(args);

      const { node, note } = await pickNodeFor(toolName, args);

      // 自动路由选中的机器也要走完整的准备流程（拉起 daemon + 记账 + 设为当前）
      if (state.currentNode !== node) {
        await useNode(node);
      }

      const result = await mgr.callTool(node, toolName, args, {
        timeoutMs: timeoutForCall(args),
      });

      // 说明只在首次为本会话选定这台机器时加一次，之后不再往每次结果里塞噪音
      if (note && !state.announced.has(node)) {
        state.announced.add(node);
        return prependNote(result, note);
      }
      return result;
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true);
    }
  });

  return {
    server,
    close: async () => {
      unmarkAll(owner);
      await mgr.closeAll();
    },
  };
}
