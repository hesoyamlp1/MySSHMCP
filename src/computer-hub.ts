import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { ComputerHubConfig, ComputerNode } from "./computer-config.js";
import {
  ComputerClientManager,
  ElicitationRecord,
  serverFor,
  UPSTREAM_IDLE_MS,
} from "./computer-client.js";

/**
 * computer-hub：把远程机器上的桌面操作能力统一成一组工具。
 *
 * 和 browser-hub 同构，三处不同都是桌面本身的性质决定的：
 *
 * 1. **桌面是单一共享面**。浏览器可以给每个会话一个隔离 context，屏幕不行——
 *    同一台机器同时只允许一个会话操作，第二个会被明确挡住（见 claim/release）。
 * 2. **两个平台的上游 API 不一样**。mac 有 10 个离散工具（按 app 寻址）外加一个 js；
 *    windows 只有 js（按窗口寻址，方法名也不同）。所以工具清单是按当前机器算出来的。
 * 3. **动作会触发系统授权问询**。上游把 "Allow ChatGPT to use X?" 作为带 id 的请求发过来，
 *    client 那层按 approve 策略答，答了什么会随结果一起报上来，不闷声放行。
 *
 * 前缀：所有对外工具都带 computer_ 前缀。上游的名字是 click / drag / type_text 这种通名，
 * 直接透传会跟别的 MCP 服务撞名，也会让模型分不清点的是网页还是桌面。
 */

const PREFIX = "computer_";

/** 桌面是共享面：一台机器同时只给一个会话用。key=机器名，value=占用者 */
const holders = new Map<string, object>();
/** 占用者最后一次动手的时间，用于「对方早就不动了」的提示 */
const holderTouched = new Map<string, number>();

function claim(node: string, owner: object): void {
  holders.set(node, owner);
  holderTouched.set(node, Date.now());
}

function release(node: string, owner: object): void {
  if (holders.get(node) === owner) {
    holders.delete(node);
    holderTouched.delete(node);
  }
}

function releaseAll(owner: object): void {
  for (const [node, o] of [...holders]) if (o === owner) release(node, owner);
}

/** 别的会话正占着这台机器就抛错说清楚；没人占或就是自己占着则（重新）占上 */
function ensureExclusive(node: string, owner: object): void {
  const cur = holders.get(node);
  if (cur && cur !== owner) {
    const mins = Math.round((Date.now() - (holderTouched.get(node) ?? 0)) / 60000);
    throw new Error(
      `${node} 的桌面正被另一个会话操作（最后动手在 ${mins} 分钟前）。\n` +
        `屏幕是共享的，两个会话同时点会互相打架，所以这里不放行。\n` +
        `要么等它结束，要么换一台：computer_node({action:"list"}) 看还有哪些机器。`
    );
  }
  claim(node, owner);
}

function textResult(obj: unknown, isError = false): CallToolResult {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: "text", text }], isError };
}

function prependNote(result: CallToolResult, note: string): CallToolResult {
  return { ...result, content: [{ type: "text", text: note }, ...(result.content ?? [])] };
}

/** 授权问询的记录变成给模型看的一段话 */
function elicitationNote(recs: ElicitationRecord[]): string | undefined {
  if (recs.length === 0) return undefined;
  const lines = recs.map((r) => {
    const head = `系统弹了授权问询：「${r.message}」`;
    const extra = [r.params, r.riskLevel ? `风险等级 ${r.riskLevel}` : undefined]
      .filter(Boolean)
      .join("，");
    const ans = r.answer === "accept" ? "已代你同意" : "已拒绝";
    return `${head}${extra ? `（${extra}）` : ""} —— ${ans}：${r.why}`;
  });
  return lines.join("\n");
}

const NODE_TOOL: Tool = {
  name: "computer_node",
  description:
    "选哪台机器做桌面操作，或看各台机器的状态。桌面是共享面，一台机器同时只给一个会话用。\n" +
    'list: 有哪些机器、在不在线、什么平台、屏幕前是不是有人。\n' +
    'connect: 选一台（之后的 computer_* 调用都走它）。\n' +
    'status: 当前这台的连接情况、上游 readyz、本会话占用情况。\n' +
    'up: 那台机器的 app-server 没起来时拉一把。\n' +
    'release: 主动交还占用，让别的会话能用（会话结束时会自动释放）。',
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "connect", "status", "up", "release"],
        description: "默认 list",
      },
      node: { type: "string", description: "机器名（connect / up / release 用）" },
    },
  },
};

/** 上游工具名 → 对外工具名 */
function outName(upstream: string): string {
  return PREFIX + upstream;
}

/** 对外工具名 → 上游工具名 */
function upName(out: string): string {
  return out.startsWith(PREFIX) ? out.slice(PREFIX.length) : out;
}

/**
 * 没选机器时对外报的工具清单：只有 computer_node。
 * 为什么不像 browser-hub 那样先报一份完整清单：两个平台的工具面不同（mac 11 个、windows 1 个），
 * 报一份"通用清单"会让模型在 windows 上调到不存在的工具。选完机器后清单会跟着变。
 */
function baseTools(): Tool[] {
  return [NODE_TOOL];
}

export function buildComputerHubServer(
  cfg: ComputerHubConfig,
  mgr: ComputerClientManager,
  version: string
): { server: Server; close: () => Promise<void> } {
  const server = new Server(
    { name: "computer-hub", version },
    // listChanged 必须声明：工具清单是按当前选中的机器算的（mac 11 个 / windows 1 个），
    // connect 之后清单会变。不发 notifications/tools/list_changed 的话，客户端一直用
    // 初次拉到的那份——也就是只有 computer_node，接上了机器却没有工具可用。
    { capabilities: { tools: { listChanged: true } } }
  );

  /** 本会话的身份标识，用于独占记账 */
  const owner = {};

  // idle 回收断开了上游 = 那边 thread 已经收掉，占用也跟着还回去
  mgr.onIdleDrop = (name) => release(name, owner);

  const state: { currentNode?: string; announced: Set<string> } = { announced: new Set() };

  /** 只有一台机器时默认选它，省得每次都要 connect */
  function soleNode(): string | undefined {
    const all = mgr.listNodes();
    return all.length === 1 ? all[0].name : undefined;
  }

  function nodeSummary(n: ComputerNode): Record<string, unknown> {
    return {
      机器: n.name,
      平台: n.computer.platform,
      工具面:
        n.computer.platform === "mac"
          ? "10 个离散工具（按 app 名寻址）；新版 ChatGPT.app 另有 computer_js（cua.* 接口），旧版没有——以 connect 之后的实际工具清单为准"
          : "只有 computer_js（sky.* 接口，按窗口寻址）",
      授权策略: n.computer.approve ?? "low",
      占用: holders.get(n.name) ? (holders.get(n.name) === owner ? "本会话" : "别的会话") : "空闲",
      说明: n.computer.note,
    };
  }

  /** 选定一台机器：确认在线（必要时拉起）、占住、建连 */
  async function useNode(name: string): Promise<string> {
    const n = mgr.getNode(name);
    if (!n) {
      throw new Error(
        `没有 '${name}' 这台机器。现有：${mgr.listNodes().map((x) => x.name).join(", ")}`
      );
    }
    ensureExclusive(name, owner);

    let online = await mgr.probe(name);
    let note = "";
    if (!online && n.computer.up) {
      note = `（${name} 的 app-server 没在跑，已拉起）\n`;
      await mgr.up(name);
      online = true;
    }
    if (!online) {
      release(name, owner);
      throw new Error(
        `${name} 的 app-server 连不上（${n.computer.url}）。\n` +
          `隧道或那台机器上的服务挂了。它没配 up 命令，要人去那台机器上看一眼。`
      );
    }
    await mgr.toolsOf(name); // 触发握手 + thread/start，失败在这里就报出来
    state.currentNode = name;
    // 清单变了（从"只有 computer_node"变成这台机器的实际工具面），告诉客户端重新拉
    void server.sendToolListChanged().catch(() => {});
    return note;
  }

  /** 当前机器该对外报哪些工具 */
  async function toolsForCurrent(): Promise<Tool[]> {
    const name = state.currentNode ?? soleNode();
    if (!name) return baseTools();
    const n = mgr.getNode(name);
    if (!n) return baseTools();
    if (!mgr.isConnected(name)) {
      // 没连上就别为了列工具去拉起远端服务（列清单不该有副作用），按平台给静态清单
      return [...baseTools(), ...staticTools(n)];
    }
    try {
      const byServer = await mgr.toolsOf(name);
      const out: Tool[] = [...baseTools()];
      for (const [, tools] of byServer) {
        for (const [tname, t] of Object.entries(tools)) {
          if (tname === "js_reset" || tname === "js_add_node_module_dir" || tname === "turn_ended") continue;
          out.push({ ...t, name: outName(tname) });
        }
      }
      // 上游清单还没回来（那台机器的 codex_apps 起得慢，见 client 里的说明）：
      // 先给静态清单，名字是对的，模型照样能干活；真清单回来后这里自然就换成它。
      return out.length > baseTools().length ? out : [...baseTools(), ...staticTools(n)];
    } catch {
      return [...baseTools(), ...staticTools(n)];
    }
  }

  /** 上游连不上时给的静态清单：只求名字对，描述简略 */
  function staticTools(n: ComputerNode): Tool[] {
    const js: Tool = {
      name: outName("js"),
      description:
        n.computer.platform === "mac"
          ? "在那台 mac 上跑 JavaScript 操作桌面（cua.getApp / app.click / app.getAXState …）。第一次调用会回一份完整接口文档。"
          : "在那台 windows 上跑 JavaScript 操作桌面（先 globalThis.sky = (await import('@oai/sky')).sky，再 sky.list_windows / sky.click …）。",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 JavaScript（支持顶层 await）" },
          timeout_ms: { type: "integer", description: "执行超时，默认 30000" },
        },
        required: ["code"],
      },
    };
    if (n.computer.platform === "windows") return [js];
    const app = { type: "string", description: "app 名、完整路径或 bundle id" } as const;
    const mk = (name: string, description: string, props: Record<string, unknown>, required: string[]): Tool => ({
      name: outName(name),
      description,
      inputSchema: { type: "object", properties: { app, ...props }, required: ["app", ...required] },
    });
    return [
      mk("get_app_state", "读一个 app 的可访问性树和窗口截图。每个回合动手之前先调它。", {}, []),
      mk("list_apps", "列出这台机器上在跑的、以及最近 14 天用过的 app。", {}, []),
      mk("click", "点一个元素（element_index）或坐标（x/y）。", {
        element_index: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        mouse_button: { type: "string", enum: ["left", "right", "middle"] },
        click_count: { type: "integer" },
      }, []),
      mk("type_text", "按键盘输入一段文字。", { text: { type: "string" } }, ["text"]),
      mk("press_key", "按一个键或组合键（xdotool 语法，如 Return / super+c）。", { key: { type: "string" } }, ["key"]),
      mk("set_value", "给可设值的元素直接赋值。", { element_index: { type: "string" }, value: { type: "string" } }, ["element_index", "value"]),
      mk("scroll", "滚动某个元素。", { element_index: { type: "string" }, direction: { type: "string" }, pages: { type: "number" } }, ["element_index", "direction"]),
      mk("drag", "从一个坐标拖到另一个坐标。", { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } }, ["from_x", "from_y", "to_x", "to_y"]),
      mk("select_text", "在可编辑元素里选中一段文字，或把光标放到它前后。", { element_index: { type: "string" }, text: { type: "string" } }, ["element_index", "text"]),
      mk("perform_secondary_action", "触发元素暴露的次级动作（展开、显示菜单之类）。", { element_index: { type: "string" }, action: { type: "string" } }, ["element_index", "action"]),
      js,
    ];
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await toolsForCurrent(),
  }));

  async function handleNodeTool(args: Record<string, unknown>): Promise<CallToolResult> {
    const action = (args.action as string) ?? "list";
    const name = args.node as string | undefined;

    if (action === "list") {
      const rows = await Promise.all(
        mgr.listNodes().map(async (n) => ({
          ...nodeSummary(n),
          在线: (await mgr.probe(n.name)) ? "是" : "否",
        }))
      );
      return textResult({
        机器: rows,
        当前: state.currentNode ?? "（还没选）",
        提示: '选一台：computer_node({action:"connect", node:"..."})。桌面是共享面，一台机器同时只给一个会话用。',
      });
    }

    if (action === "connect") {
      if (!name) throw new Error('connect 要带 node，例如 computer_node({action:"connect", node:"mac-mini-2"})');
      const note = await useNode(name);
      const n = mgr.getNode(name)!;
      return textResult({
        已连接: name,
        ...nodeSummary(n),
        提示:
          note +
          (n.computer.platform === "mac"
            ? "先 computer_get_app_state 读状态，再按最新一次返回的 element_index 动手（编号每次都会重排）。"
            : "先 computer_js 里 globalThis.sky = (await import('@oai/sky')).sky，再 sky.list_windows() 找窗口。"),
      });
    }

    if (action === "status") {
      const cur = state.currentNode;
      if (!cur) return textResult({ 当前: "（还没选机器）" });
      const n = mgr.getNode(cur)!;
      return textResult({
        ...nodeSummary(n),
        已建连: mgr.isConnected(cur),
        端口通: await mgr.probe(cur),
        readyz: (await mgr.ready(cur)) ?? "（探不到，老版本可能没这个端点）",
        空闲回收: UPSTREAM_IDLE_MS > 0 ? `${Math.round(UPSTREAM_IDLE_MS / 60000)} 分钟不用就断开` : "关",
      });
    }

    if (action === "up") {
      const target = name ?? state.currentNode;
      if (!target) throw new Error("up 要带 node");
      const out = await mgr.up(target);
      return textResult({ 已拉起: target, 输出: out.slice(0, 800) });
    }

    if (action === "release") {
      const target = name ?? state.currentNode;
      if (!target) throw new Error("release 要带 node");
      await mgr.close(target);
      release(target, owner);
      if (state.currentNode === target) state.currentNode = undefined;
      void server.sendToolListChanged().catch(() => {});
      return textResult({ 已释放: target, 说明: "上游 thread 已收掉，别的会话可以用这台机器了" });
    }

    throw new Error(`未知 action: ${action}`);
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      if (toolName === "computer_node") return await handleNodeTool(args);

      let node = state.currentNode ?? soleNode();
      if (!node) {
        throw new Error(
          '还没选机器。先 computer_node({action:"list"}) 看有哪些，再 computer_node({action:"connect", node:"..."})。'
        );
      }

      let note = "";
      if (state.currentNode !== node) note = await useNode(node);
      // 每次动手前都确认独占还在自己手里（别的会话可能在 idle 回收后接手了）
      ensureExclusive(node, owner);
      holderTouched.set(node, Date.now());

      const n = mgr.getNode(node)!;
      const idleDropped = mgr.takeIdleDroppedNote(node);
      const upstream = upName(toolName);
      const { result, elicitations } = await mgr.callTool(
        node,
        serverFor(n, upstream),
        upstream,
        args,
        { timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms + 15_000 : undefined }
      );

      let out = result;
      const notes: string[] = [];
      if (note && !state.announced.has(node)) {
        state.announced.add(node);
        notes.push(note.trim());
      }
      if (idleDropped) {
        notes.push(
          `（本会话 ${Math.round(UPSTREAM_IDLE_MS / 60000)} 分钟没碰 ${node}，那边的会话已经收掉、刚重新建上：` +
            `之前 js 里存的变量没了，元素编号也要重新读。）`
        );
      }
      const en = elicitationNote(elicitations);
      if (en) notes.push(en);
      if (notes.length) out = prependNote(out, notes.join("\n"));
      return out;
    } catch (e) {
      return textResult(e instanceof Error ? e.message : String(e), true);
    }
  });

  return {
    server,
    close: async () => {
      releaseAll(owner);
      await mgr.closeAll();
    },
  };
}
