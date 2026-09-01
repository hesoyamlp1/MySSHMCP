import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BrowserClientManager, loadCachedTools, UPSTREAM_IDLE_MS } from "./browser-client.js";
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

function unmark(node: string, owner: object): void {
  const s = ACTIVE_BY_NODE.get(node);
  if (!s) return;
  s.delete(owner);
  if (s.size === 0) ACTIVE_BY_NODE.delete(node);
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
  // 各 content 块在客户端是直接拼起来显示的，说明后面留一个空行，别跟上游正文粘在一起
  return {
    ...result,
    content: [{ type: "text", text: note + "\n\n" }, ...(result.content ?? [])],
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
    "没 connect 过时直接 browser_navigate 也行：会按 URL 自动选机器（公司域名→公司的 mac，家里网段→家里的 mac）。\n" +
    "mac 上的浏览器是有头的：窗口就开在那台 mac 的屏幕上，用户可能正在看，也随时能上手操作。" +
    "卡在验证码 / 扫码 / SSO 登录 / 必须人点的地方，别自己反复试——直接告诉用户去哪台机器、要他做什么，" +
    "然后 browser_wait_for 等他弄完再继续（他这样登进去的登录态只在本会话有效）。" +
    (UPSTREAM_IDLE_MS > 0
      ? `本会话 ${Math.round(UPSTREAM_IDLE_MS / 60000)} 分钟没碰浏览器，那边的窗口会被关掉，下次调用自动重连、页面要重新导航。`
      : ""),
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

  // idle 回收断开连接 = 那边窗口已关、内存已还,concurrency 占位跟着释放;
  // 下次真要用时(CallTool 前的 !isConnected 分支)重新占位
  mgr.onIdleDrop = (name) => unmark(name, owner);

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

  /** 一台机器的浏览器窗口在哪、用户能不能接手——给模型看的一句话 */
  function windowNote(n: BrowserNode): string {
    return n.browser.headed
      ? `有头：窗口开在 ${n.name} 的屏幕上，用户看得见你在点什么、也能直接接手（验证码 / 扫码 / SSO 登录这类要人操作的地方，说一声再 browser_wait_for 等）`
      : "无头：没人看得见；卡在要人操作的地方就换一台有头的 mac";
  }

  function nodeSummary(n: BrowserNode): Record<string, unknown> {
    const b = n.browser;
    const entry: Record<string, unknown> = { node: n.name };
    if (b.logins && b.logins.length > 0) entry.logins = b.logins;
    else entry.logins = "（没配登录态清单；要登录的站可能进不去）";
    if (b.reach) entry.reach = b.reach;
    if (b.concurrency) entry.concurrency = `${activeCount(n.name)}/${b.concurrency} 个会话在用`;
    entry.窗口 = b.headed ? "有头（用户看得见、能接手）" : "无头（没人看得见）";
    if (b.note) entry.note = b.note;
    return entry;
  }

  /** concurrency 限制：满了就明确说换哪台，别让它变成上游的费解报错 */
  function checkConcurrency(name: string): void {
    const node = mgr.getNode(name);
    const limit = node?.browser.concurrency;
    if (!limit) return;
    // 本会话已经占着位子就不再算一次
    if (ACTIVE_BY_NODE.get(name)?.has(owner)) return;
    if (activeCount(name) >= limit) {
      const others = mgr
        .listNodes()
        .filter((n) => n.name !== name && activeCount(n.name) < (n.browser.concurrency ?? 99))
        .map((n) => n.name);
      throw new Error(
        `${name} 上已经有 ${activeCount(name)} 个会话在用浏览器（上限 ${limit}）。\n` +
          (others.length > 0
            ? `换一台：${others.join(" / ")}（browser_node({action:"connect", node:"..."})）`
            : `其它机器也满了或没铺。空闲的占位` +
              (UPSTREAM_IDLE_MS > 0 ? `${Math.round(UPSTREAM_IDLE_MS / 60000)} 分钟` : ``) +
              `会自动释放,稍等重试;都在实际使用就把情况告诉用户(hub.json 的 concurrency 可调)。` +
              `别 browser_node({action:"down"})——那会关掉其他会话的窗口。`)
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
          const fb = mgr.getNode(hit.fallback)!;
          return {
            node: hit.fallback,
            note:
              `已自动路由到 ${hit.fallback}（规则 ${hit.matched} 本来指向 ${hit.node}，` +
              `但它现在不在线，用了 fallback）。浏览器窗口：${windowNote(fb)}`,
          };
        }
        return {
          node: hit.node,
          note: `已自动路由到 ${hit.node}（规则 ${hit.matched}）。浏览器窗口：${windowNote(mgr.getNode(hit.node)!)}`,
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
          "browser_navigate 会按上面的规则自动选机器。标着「有头」的机器，浏览器窗口开在它的屏幕上，" +
          "用户看得见、能接手——要人操作的地方说一声再等。",
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
      const running = await mgr.probe(state.currentNode);
      const out: Record<string, unknown> = {
        当前: state.currentNode,
        ...nodeSummary(n),
        本会话已连接: mgr.isConnected(state.currentNode),
        最后一次调用: last ? new Date(last).toISOString() : "（本会话还没调用过）",
        daemon: running ? "在跑" : "不在跑",
      };
      if (running) {
        // hub.json 的 headed 只是声明；看一眼进程参数，声明和实际不一致要明说
        const actual = await mgr.detectMode(state.currentNode);
        const declared = n.browser.headed ? "headed" : "headless";
        if (actual === "unknown") {
          out.实际模式 = "探不到（那台机器上没法看进程参数）";
        } else if (actual === declared) {
          out.实际模式 = actual === "headed" ? "有头（进程参数里没有 --headless）" : "无头（进程参数里有 --headless）";
        } else {
          out.实际模式 =
            `⚠️ hub.json 声明${declared === "headed" ? "有头" : "无头"}，实际${actual === "headed" ? "有头" : "无头"}` +
            `——那台机器的 daemon 多半是手动起的（PW_HEADLESS=1 或旧脚本）。` +
            `要按声明来：browser_node({action:"down", node:"${state.currentNode}"}) 再 connect，让 pw-up.sh 重起。`;
        }
      }
      return textResult(out);
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
        浏览器窗口: windowNote(n),
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

      // 先自动试一次：company.json 只是持久 profile 的快照，过期时 profile 里往往还登着，
      // 重导一下就好，不用惊动人。全都失效了才需要人登一次 SSO。
      const { rc, detail } = await mgr.refreshState(name);

      if (rc === 0) {
        return textResult({
          机器: name,
          结果: "登录态已经自动刷新好了，不用麻烦用户",
          做了什么: "在那台机器上跑 refresh-state.sh：从还登着的持久 profile 重导 company.json，并按域白名单裁掉非公司的 cookie",
          下一步: `browser_node({action:"down", node:"${name}"}) 再 connect，新登录态即生效`,
          输出: detail,
        });
      }

      const 人工步骤 = [
        `1. 用户在 ${name} 上开盖（headful 浏览器要有图形会话，合盖看不到窗口）`,
        `2. 先看这台有哪些 profile、哪个碰过公司的站：bash ~/.mori/browser/list-profiles.sh`,
        `3. 起浏览器：bash ~/.mori/browser/relogin.sh start <后缀>`,
        `   后缀必须带——脚本默认写死 33da8b6，那是 macbook-air 上管家那份，别的机器没有这个目录，直接跑会报「没有这个 profile」`,
        `4. 在弹出的浏览器里登一次 SSO`,
        `5. 登完跑：bash ~/.mori/browser/relogin.sh finish <后缀>`,
        `   它导出 company.json（权限 600）、按域白名单裁一刀、关掉那个独占的持久 profile`,
        `6. 回来跑 browser_node({action:"down", node:"${name}"}) 再 connect，新登录态即生效`,
      ];

      if (rc === 2) {
        return textResult({
          机器: name,
          结果: "自动重导没成功：这台机器所有持久 profile 都没有有效的公司登录态了，只能人工登一次",
          先试更省事的:
            n.browser.headed
              ? "这台机器的浏览器是有头的：只是这一次要登录的话，直接让用户在屏幕上那个窗口里登一次，然后 browser_wait_for 等他登完继续。" +
                "这样登进去的 cookie 只在本会话的内存 profile 里、不落盘；要让以后每个会话都带上，才走下面的步骤。"
              : "（这台机器是无头的，只能走下面的步骤）",
          步骤: 人工步骤,
          注意: [
            "relogin 期间那个持久 profile 被独占，这台机器上的 tc-* skill 读它会报「被占用」，finish 之后恢复",
            "storageState 只带 cookie，不带 localStorage——靠 localStorage 存 token 的站这样注入不全",
            "那个 json 是明文 SSO cookie：权限 600、不入 git、不跨机传（要哪台有登录态就在哪台上登）",
          ],
          当前声明的登录态: n.browser.logins ?? "（未配置）",
          自动重导的输出: detail,
        });
      }

      return textResult({
        机器: name,
        结果: `自动重导跑不起来（退出码 ${rc}）`,
        可能的原因: "那台机器上没装 refresh-state.sh，或者没有 sqlite3 / playwright 缓存目录",
        怎么装: "把仓库 scripts/refresh-state.sh 和 scripts/filter-company-state.cjs 复制到那台机器的 ~/.mori/browser/ 下",
        退回人工: 人工步骤,
        输出: detail,
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

      // idle 回收释放过占位的会话,重建连接前先重新占位(满了明确报错,不悄悄超卖)
      if (!mgr.isConnected(node)) {
        checkConcurrency(node);
        markActive(node, owner);
      }

      const idleDropped = mgr.takeIdleDroppedNote(node);
      const result = await mgr.callTool(node, toolName, args, {
        timeoutMs: timeoutForCall(args),
      });

      // 说明只在首次为本会话选定这台机器时加一次，之后不再往每次结果里塞噪音
      let out = result;
      if (note && !state.announced.has(node)) {
        state.announced.add(node);
        out = prependNote(out, note);
      }
      if (idleDropped) {
        out = prependNote(
          out,
          `（本会话 ${Math.round(UPSTREAM_IDLE_MS / 60000)} 分钟没碰 ${node} 的浏览器，那边的窗口已经关掉、刚重新连上：之前的页面不在了，要重新导航）`
        );
      }
      return out;
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
