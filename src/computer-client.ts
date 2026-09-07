import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ComputerNode } from "./computer-config.js";
import { HubClientManager } from "./hub-client.js";
import { probeTcp } from "./net-probe.js";

/**
 * 到一台机器上 codex app-server 的连接。
 *
 * 跟 browser-client 的区别：那边上游是标准 MCP over HTTP，直接用 SDK 的 Client；
 * 这边上游是 OpenAI 的 app-server 协议（websocket 上跑 JSON-RPC，一帧一条 JSON），
 * 不是 MCP，所以自己实现最小客户端。协议流程（实测确认，见 docs/computer-hub.md）：
 *
 *   initialize → initialized(通知) → thread/start(ephemeral，只开我们要的那几个 server)
 *   → mcpServerStatus/list（拿工具清单、确认 server 连上了）
 *   → mcpServer/tool/call（每次动作）
 *
 * 其间上游会主动发**带 id 的请求** mcpServer/elicitation/request（"Allow ChatGPT to use X?"），
 * 必须回一条 {id, result:{action}}，不回它就一直等着。
 */

/** 建连 + initialize 的超时：机器半死（端口在 listen 但进程无响应）时别卡满 */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * thread/start 和 mcpServerStatus/list 的超时。这两步会真的把 computer-use 的进程拉起来，
 * 慢的机器上要十几秒（air 的 ChatGPT.app 26.715 实测比 mini-2 的 26.901 慢一个量级），
 * 所以比握手宽松得多。
 */
const STARTUP_TIMEOUT_MS = 45_000;
/** 单次工具调用的默认超时。mac 上读状态 0.3s，windows 上 3s，冷启动 app 可能十几秒 */
const DEFAULT_CALL_TIMEOUT_MS = 90_000;
/** 拉起 app-server 后等它 bind 端口 */
const UP_POLL_INTERVAL_MS = 1500;
const UP_POLL_TRIES = 12;

/**
 * 上游连接的空闲阈值：本会话多久没碰某台机器，就断开它。
 * 断开会让上游结束这个 ephemeral thread，连带收掉它起的 computer-use 子进程。
 * 桌面操作不像浏览器有窗口留在屏幕上，所以阈值可以比 browser-hub 的 30 分钟长一点，
 * 但也别不回收——每个活着的 thread 在那台机器上都吊着一组进程。
 */
export const UPSTREAM_IDLE_MS = (() => {
  const v = process.env.COMPUTER_HUB_UPSTREAM_IDLE_MIN;
  if (v === undefined || v === "") return 30 * 60 * 1000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 60 * 1000 : 30 * 60 * 1000;
})();

/** app-server 里我们要开的 MCP server 名（按平台不同） */
const MAC_DISCRETE_SERVER = "computer-use";
const MAC_JS_SERVER = "cua_repl";
const WIN_JS_SERVER = "node_repl";

export interface ElicitationRecord {
  /** 上游问的话，原文 */
  message: string;
  /** 上游标的风险等级，可能没有 */
  riskLevel?: string;
  /** 结构化的参数展示，如 [{display_name:"App", value:"Calculator"}] */
  params?: string;
  /** 我们怎么答的 */
  answer: "accept" | "decline";
  /** 为什么这么答 */
  why: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  ws: WebSocket;
  thread: string;
  /** 上游各 server 的工具清单，key 是 server 名 */
  tools: Map<string, Record<string, Tool>>;
  counter: number;
  pending: Map<number, Pending>;
  /** 本次连接里答过的授权请求，调用方读走后清空 */
  elicitations: ElicitationRecord[];
  /**
   * 正在飞的那次调用要操作的 app（没有就是 undefined）。
   * 授权问询到达时靠它判断「这是不是我们自己这次调用引出来的」。
   */
  inflightApp?: string;
  closed: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    if (typeof t.unref === "function") t.unref();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function parseEndpoint(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || 80 };
}

/** 连接层失效（app-server 重启 / 隧道断了） */
function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not connected|connection closed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|websocket|closed before/i.test(
    msg
  );
}

export class ComputerClientManager {
  private conns = new Map<string, Conn>();
  private lastUse = new Map<string, number>();
  private idleTimer?: NodeJS.Timeout;
  /** idle 回收把某台机器断掉时记一笔，下次调用时告诉模型「上次那个 thread 没了」 */
  private idleDropped = new Set<string>();
  /** 每台机器 config.toml 里配了哪些 mcp_servers（要显式关掉，见 configuredServers） */
  private serverNames = new Map<string, string[]>();
  /** 每台 mac 上 computer-use 插件的实际布局（见 MacDriver） */
  private macDrivers = new Map<string, MacDriver>();
  /** idle 回收发生时通知上层（用来同步释放独占记账） */
  onIdleDrop?: (node: string) => void;

  constructor(
    private nodes: ComputerNode[],
    private hub: HubClientManager,
    private version: string
  ) {
    if (UPSTREAM_IDLE_MS > 0) {
      this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
      if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
    }
  }

  listNodes(): ComputerNode[] {
    return this.nodes;
  }

  getNode(name: string): ComputerNode | undefined {
    return this.nodes.find((n) => n.name === name);
  }

  isConnected(name: string): boolean {
    const c = this.conns.get(name);
    return !!c && !c.closed;
  }

  takeIdleDroppedNote(name: string): boolean {
    if (!this.idleDropped.has(name)) return false;
    this.idleDropped.delete(name);
    return true;
  }

  /** 端口探活：app-server 只 bind loopback，这里探的是隧道落在 VPS 的那一头 */
  async probe(name: string): Promise<boolean> {
    const n = this.getNode(name);
    if (!n) return false;
    const { host, port } = parseEndpoint(n.computer.url);
    return probeTcp(host, port, 2000);
  }

  /**
   * 官方 app-server 自带 /readyz。端口通了但进程半死时，这一层能分辨出来。
   * 探不通不算错（老版本可能没有这个端点），只在 status 里报告。
   */
  async ready(name: string): Promise<boolean | undefined> {
    const n = this.getNode(name);
    if (!n) return undefined;
    const u = new URL(n.computer.url);
    const url = `http://${u.hostname}:${u.port}/readyz`;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return undefined;
    }
  }

  /** 借那台机器自己的 ssh daemon 执行命令 —— computer-hub 自己不实现任何 ssh 能力 */
  private async runOnHost(n: ComputerNode, command: string, timeout = 30): Promise<string> {
    const node = n.computer.via ?? n.name;
    const server = n.computer.server ?? "local";
    const r = await this.hub.callTool(
      node,
      "ssh",
      { server, command, timeout },
      { timeoutMs: (timeout + 15) * 1000 }
    );
    const out = (r.content ?? [])
      .map((b: any) => (b?.type === "text" ? b.text : ""))
      .join("\n")
      .trim();
    if (r.isError) throw new Error(out || `在 ${n.name} 上执行命令失败：${command}`);
    return out;
  }

  /**
   * 那台机器的 ~/.codex/config.toml 里配了哪些 mcp_servers。
   *
   * 为什么需要：thread/start 传的 config 是**合并**语义，不是替换。不显式关掉的话，
   * 用户 config.toml 里的 server（ssh、trail、playwright…）会跟着我们的 thread 一起被拉起来——
   * 既费那台机器的资源，又等于替用户启动了他自己的工具。实测过：只开 computer-use 时，
   * node_repl 照样连上、playwright 起失败。
   *
   * 取不到就退回空列表（只关我们知道名字的那几个）：少关几个不影响功能，不该因此连不上。
   */
  private async configuredServers(n: ComputerNode): Promise<string[]> {
    const cached = this.serverNames.get(n.name);
    if (cached) return cached;
    const cmd =
      n.computer.platform === "windows"
        ? `findstr /r /c:"^\\[mcp_servers\\." "%USERPROFILE%\\.codex\\config.toml"`
        : `grep -oE '^\\[mcp_servers\\.[^]]+\\]' "$HOME/.codex/config.toml" || true`;
    let names: string[] = [];
    try {
      const out = await this.runOnHost(n, cmd, 15);
      names = [
        ...new Set(
          out
            .split("\n")
            .map((l) => l.trim().match(/^\[mcp_servers\.([^\].]+)/)?.[1])
            .filter((x): x is string => !!x)
            .map((x) => x.replace(/^"|"$/g, ""))
        ),
      ];
    } catch {
      names = [];
    }
    this.serverNames.set(n.name, names);
    return names;
  }

  /**
   * 探一台 mac 上 computer-use 插件的实际布局。
   *
   * 三台 mac 的 ChatGPT.app 版本不一样，插件布局跟着变，写死路径只能覆盖其中一种：
   * - 新版（26.901）：computer-use/bin/computer-use-client-launcher，另有 unified-computer-use 插件（js 工具）
   * - 旧版（26.715）：computer-use/Codex Computer Use.app/…/SkyComputerUseClient，**没有** unified 插件
   * 所以建连前问一次那台机器，按实际情况拼 thread 配置。结果缓存，一个会话只问一次。
   */
  private async detectMacDriver(n: ComputerNode): Promise<MacDriver> {
    const cached = this.macDrivers.get(n.name);
    if (cached) return cached;
    const script = [
      'P=/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins',
      'NEW="$P/computer-use/bin/computer-use-client-launcher"',
      'OLD="$P/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"',
      'if [ -x "$NEW" ]; then echo "DRIVER=$NEW"; elif [ -x "$OLD" ]; then echo "DRIVER=$OLD"; else echo "DRIVER="; fi',
      'echo "CWD=$P/computer-use"',
      '[ -d "$P/unified-computer-use" ] && echo "UNIFIED=yes" || echo "UNIFIED=no"',
    ].join('; ');
    const out = await this.runOnHost(n, script, 15);
    const get = (k: string): string =>
      out.split("\n").map((l) => l.trim()).find((l) => l.startsWith(k + "="))?.slice(k.length + 1) ?? "";
    const command = get("DRIVER");
    if (!command) {
      throw new Error(
        `${n.name} 上找不到 computer-use 插件的可执行文件。ChatGPT.app 没装、或者版本换了布局。\n` +
          `探测输出：${out.slice(0, 300)}`
      );
    }
    const driver: MacDriver = { command, cwd: get("CWD"), hasUnified: get("UNIFIED") === "yes" };
    this.macDrivers.set(n.name, driver);
    return driver;
  }

  /** 拉起某台机器的 app-server，然后等它 bind 端口 */
  async up(name: string): Promise<string> {
    const n = this.getNode(name);
    if (!n) throw new Error(`没有这台机器: ${name}`);
    if (!n.computer.up) {
      throw new Error(
        `${name} 没配 up 命令（它的 app-server 应该是常驻的）。` +
          `如果它现在不在线，去那台机器上看 launchd / 任务计划是不是挂了。`
      );
    }
    const out = await this.runOnHost(n, n.computer.up);
    for (let i = 0; i < UP_POLL_TRIES; i++) {
      await new Promise((r) => setTimeout(r, UP_POLL_INTERVAL_MS));
      if (await this.probe(name)) return out;
    }
    throw new Error(
      `在 ${name} 上执行了 up 命令，但 ${UP_POLL_TRIES * UP_POLL_INTERVAL_MS / 1000} 秒后 ` +
        `${n.computer.url} 还是不通。命令的输出：\n${out}`
    );
  }

  async down(name: string): Promise<string> {
    const n = this.getNode(name);
    if (!n) throw new Error(`没有这台机器: ${name}`);
    if (!n.computer.down) throw new Error(`${name} 没配 down 命令`);
    await this.close(name);
    return this.runOnHost(n, n.computer.down);
  }

  /* ---------------- websocket 上的 JSON-RPC ---------------- */

  private send(c: Conn, msg: unknown): void {
    c.ws.send(JSON.stringify(msg));
  }

  private rpc(c: Conn, method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (c.closed) return reject(new Error("connection closed"));
      const id = ++c.counter;
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`上游 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      c.pending.set(id, { resolve, reject, timer });
      try {
        this.send(c, { id, method, params });
      } catch (e) {
        clearTimeout(timer);
        c.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * 上游主动发来的请求。目前只有一种：mcpServer/elicitation/request，
   * 也就是 macOS / Windows 那个「Allow ChatGPT to use X?」的授权问询。
   *
   * 按节点配置的 approve 策略回答，并把问了什么、怎么答的记下来，
   * 随下一个工具结果一起回给模型——不闷声放行。
   */
  private handleServerRequest(name: string, c: Conn, msg: any): void {
    if (msg.method !== "mcpServer/elicitation/request") {
      // 不认识的请求一律拒绝：不回会把上游挂住，乱回等于替用户答应未知的事
      this.send(c, { id: msg.id, result: { action: "decline" } });
      c.elicitations.push({
        message: `上游发来未知请求 ${msg.method}`,
        answer: "decline",
        why: "hub 不认识这个请求，按拒绝处理，请把这条告诉用户",
      });
      return;
    }

    const p = msg.params ?? {};
    const meta = p._meta ?? {};
    const risk: string | undefined = meta.riskLevel;
    const params = Array.isArray(meta.tool_params_display)
      ? meta.tool_params_display
          .map((x: any) => `${x.display_name ?? x.name}=${x.value}`)
          .join(", ")
      : undefined;
    const policy = this.getNode(name)?.computer.approve ?? "low";

    const message = typeof p.message === "string" ? p.message : "";
    /**
     * 「让 X 访问某个 app」这一类问询。两套上游的元数据不一样：
     * unified（cua_repl）带 riskLevel=low 和结构化的 tool_params_display；
     * discrete（computer-use）**什么都不带**，只有一句 "Allow ChatGPT to use Calculator?"。
     * 所以不能只看 riskLevel，否则离散工具一调就被自己拒掉。
     */
    const isAppAccess = /allow .+ to use/i.test(message);

    let answer: "accept" | "decline";
    let why: string;
    if (policy === "always") {
      answer = "accept";
      why = `这台机器配的是 approve:"always"`;
    } else if (policy === "never") {
      answer = "decline";
      why = `这台机器配的是 approve:"never"，要放行得先改 hub.json`;
    } else if (risk === "low") {
      answer = "accept";
      why = `上游标了 riskLevel=low，按 approve:"low" 策略同意（仅本次连接有效，没设永久授权）`;
    } else if (isAppAccess && c.inflightApp) {
      // 只在「我们自己发出去的这次调用正等着」时放行，而且放行的就是这次调用要操作的那个 app。
      // 调用方（模型）已经明确说了要操作它，再回头问一遍等于挡住自己。
      answer = "accept";
      why =
        `这是本次调用（目标 ${c.inflightApp}）触发的应用访问授权，按 approve:"low" 策略同意；` +
        `仅本次连接有效，没设永久授权`;
    } else {
      answer = "decline";
      why =
        `上游标的 riskLevel=${risk ?? "(没标)"}，也不像本次调用触发的应用访问授权，` +
        `不在 approve:"low" 的放行范围内。确实要做的话，把这条原样告诉用户，由他决定。`;
    }

    this.send(c, { id: msg.id, result: { action: answer, content: {} } });
    c.elicitations.push({
      message: typeof p.message === "string" ? p.message : JSON.stringify(p).slice(0, 200),
      riskLevel: risk,
      params,
      answer,
      why,
    });
  }

  /** 建连 + 握手 + 开 thread。同一个会话对同一台机器只做一次 */
  private async connect(name: string): Promise<Conn> {
    const n = this.getNode(name);
    if (!n) throw new Error(`没有这台机器: ${name}`);

    const ws = new WebSocket(n.computer.url);
    const c: Conn = {
      ws,
      thread: "",
      tools: new Map(),
      counter: 1000,
      pending: new Map(),
      elicitations: [],
      inflightApp: undefined,
      closed: false,
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const p = c.pending.get(msg.id);
        if (p) {
          c.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
        return;
      }
      if (msg.id !== undefined && msg.method) {
        this.handleServerRequest(name, c, msg);
        return;
      }
      // 其余是通知（thread/started、mcpServer/startupStatus/updated 之类），不需要处理
    };

    const fail = (reason: string) => {
      c.closed = true;
      for (const [, p] of c.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      c.pending.clear();
    };
    ws.onclose = () => fail("connection closed（上游 app-server 断了）");
    ws.onerror = () => fail("websocket error（上游 app-server 连不上）");

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        const t = setTimeout(() => reject(new Error("建连超时")), CONNECT_TIMEOUT_MS);
        if (typeof t.unref === "function") t.unref();
      }),
      CONNECT_TIMEOUT_MS,
      `连 ${name} 的 app-server`
    );

    const init = await this.rpc(
      c,
      "initialize",
      {
        clientInfo: { name: "computer-hub", version: this.version },
        capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
      },
      CONNECT_TIMEOUT_MS
    );
    if (!init.result) throw new Error(`initialize 失败: ${JSON.stringify(init).slice(0, 300)}`);
    const codexHome: string = init.result.codexHome;
    this.send(c, { method: "initialized" });

    const driver = n.computer.platform === "mac" ? await this.detectMacDriver(n) : undefined;
    const { servers, plugins } = threadConfig(n, codexHome, await this.configuredServers(n), driver);
    const th = await this.rpc(
      c,
      "thread/start",
      { cwd: codexHome, ephemeral: true, config: { mcp_servers: servers, plugins } },
      STARTUP_TIMEOUT_MS
    );
    if (!th.result?.thread?.id) {
      throw new Error(`thread/start 失败: ${JSON.stringify(th).slice(0, 300)}`);
    }
    c.thread = th.result.thread.id;

    const inv = await this.rpc(c, "mcpServerStatus/list", { threadId: c.thread }, STARTUP_TIMEOUT_MS);
    const data: any[] = inv.result?.data ?? [];
    const wanted = wantedServers(n, driver);
    for (const s of data) {
      if (!wanted.includes(s.name)) continue;
      const tools = s.tools ?? {};
      // 老版本 app-server（air 的 0.145）根本不返回 runtimeStatus 字段，
      // 只能按"报没报出工具"判断它活没活。新版本（0.153）才有 runtimeStatus。
      const ok =
        s.runtimeStatus === undefined ? Object.keys(tools).length > 0 : s.runtimeStatus === "connected";
      if (!ok) {
        throw new Error(
          `${name} 上的 '${s.name}' 没连上（runtimeStatus=${s.runtimeStatus ?? "(这个版本不报)"}，` +
            `工具数 ${Object.keys(tools).length}）。` +
            `${s.name === MAC_DISCRETE_SERVER || s.name === WIN_JS_SERVER
              ? "多半是那台机器的辅助功能 / 录屏权限没给，或者 ChatGPT.app 版本变了。"
              : ""}`
        );
      }
      c.tools.set(s.name, tools);
    }
    if (c.tools.size === 0) {
      throw new Error(
        `${name} 上没找到任何要用的 server（要 ${wanted.join(" / ")}）。` +
          `上游报的是：${data.map((s) => `${s.name}=${s.runtimeStatus}`).join(", ") || "(空)"}`
      );
    }

    this.conns.set(name, c);
    return c;
  }

  private async ensure(name: string): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing && !existing.closed) return existing;
    if (existing) this.conns.delete(name);
    return this.connect(name);
  }

  /** 上游工具清单（按 server 名分组），供 hub 组装对外的工具面 */
  async toolsOf(name: string): Promise<Map<string, Record<string, Tool>>> {
    const c = await this.ensure(name);
    this.lastUse.set(name, Date.now());
    return c.tools;
  }

  /**
   * 调一次上游工具。server 由 hub 按平台决定（mac 的离散工具走 computer-use，
   * js 走 cua_repl；windows 的 js 走 node_repl）。
   */
  async callTool(
    name: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<{ result: CallToolResult; elicitations: ElicitationRecord[] }> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    let c = await this.ensure(name);
    this.lastUse.set(name, Date.now());

    // 这次调用针对哪个 app：mac 的离散工具直接有 app 参数；js 调用没有，
    // 用工具名兜底，授权记录里能看出是哪次调用引出来的。
    const target =
      typeof args.app === "string" ? args.app : tool === "js" ? "js 调用里指定的 app" : tool;

    const doCall = async (conn: Conn) => {
      conn.inflightApp = target;
      try {
        return await this.rpc(
          conn,
          "mcpServer/tool/call",
          { threadId: conn.thread, server, tool, arguments: args },
          timeoutMs
        );
      } finally {
        conn.inflightApp = undefined;
      }
    };

    let resp: any;
    try {
      resp = await doCall(c);
    } catch (e) {
      if (!isConnectionError(e)) throw e;
      // 连接层断了（app-server 重启 / 隧道抖）：重建一次再试。
      // 只重试一次，且不管工具是不是只读——桌面动作重放会真的按第二次，
      // 所以这里只在**连接根本没建立起来**的情况下重来，call 已经发出去的不重放。
      this.conns.delete(name);
      c = await this.ensure(name);
      resp = await doCall(c);
    }

    const elicitations = c.elicitations.splice(0);
    if (resp.error) {
      return {
        result: {
          content: [{ type: "text", text: `上游报错: ${JSON.stringify(resp.error).slice(0, 500)}` }],
          isError: true,
        },
        elicitations,
      };
    }
    const result = (resp.result ?? { content: [] }) as CallToolResult;
    return { result, elicitations };
  }

  private async closeConn(name: string, c: Conn): Promise<void> {
    c.closed = true;
    try {
      c.ws.close();
    } catch {
      /* 关不掉就算了 */
    }
    for (const [, p] of c.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("connection closed"));
    }
    c.pending.clear();
    void name;
  }

  async close(name: string): Promise<void> {
    const c = this.conns.get(name);
    if (!c) return;
    this.conns.delete(name);
    this.lastUse.delete(name);
    await this.closeConn(name, c);
  }

  async closeAll(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    const names = [...this.conns.keys()];
    await Promise.all(names.map((n) => this.close(n)));
  }

  private reapIdle(): void {
    if (UPSTREAM_IDLE_MS <= 0) return;
    const now = Date.now();
    for (const [name, c] of [...this.conns]) {
      const last = this.lastUse.get(name) ?? 0;
      if (now - last < UPSTREAM_IDLE_MS) continue;
      this.conns.delete(name);
      this.lastUse.delete(name);
      this.idleDropped.add(name);
      void this.closeConn(name, c);
      this.onIdleDrop?.(name);
    }
  }
}

/** 一台 mac 上 computer-use 插件的实际布局（版本不同布局不同，见 detectMacDriver） */
export interface MacDriver {
  /** 插件里那个可执行文件的绝对路径 */
  command: string;
  /** 插件目录（上游要求 cwd 是它） */
  cwd: string;
  /** 有没有 unified-computer-use 插件（有才有 js 工具；旧版 ChatGPT.app 没有） */
  hasUnified: boolean;
}

/** 这台机器上要开哪些上游 server */
export function wantedServers(n: ComputerNode, driver?: MacDriver): string[] {
  if (n.computer.platform !== "mac") return [WIN_JS_SERVER];
  return driver?.hasUnified === false
    ? [MAC_DISCRETE_SERVER]
    : [MAC_DISCRETE_SERVER, MAC_JS_SERVER];
}

/** 某个对外工具该发给上游哪个 server */
export function serverFor(n: ComputerNode, toolName: string): string {
  if (n.computer.platform === "windows") return WIN_JS_SERVER;
  return toolName === "js" ? MAC_JS_SERVER : MAC_DISCRETE_SERVER;
}

/**
 * thread/start 的配置：**只开我们要的那几个 server，其余全关**。
 *
 * 为什么要显式全关：app-server 会把用户 config.toml 里配的 mcp_servers 和 codex 的
 * 其它插件（browser、record-and-replay、computer-history…）一起拉起来。那些既费资源，
 * 又可能连到用户自己的东西上。实测不关的话 playwright 那条会 failed、node_repl 会白起一个。
 */
function threadConfig(
  n: ComputerNode,
  codexHome: string,
  configured: string[],
  driver?: MacDriver
): { servers: Record<string, unknown>; plugins: Record<string, unknown> } {
  const OFF = { enabled: false };
  const plugins: Record<string, unknown> = {};
  for (const p of [
    "browser",
    "computer-history",
    "record-and-replay",
    "codex-app-tools",
    "visualize",
    "computer-use",
    "unified-computer-use",
  ]) {
    plugins[`${p}@openai-bundled`] = OFF;
  }
  // 先把那台机器 config.toml 里配的 mcp_servers 全关掉，再开我们要的那个（顺序不能反）
  const servers: Record<string, unknown> = {};
  for (const s of configured) servers[s] = OFF;

  if (n.computer.platform === "mac") {
    if (!driver) throw new Error("mac 节点缺少插件布局探测结果（detectMacDriver 没跑）");
    servers[MAC_DISCRETE_SERVER] = {
      enabled: true,
      command: driver.command,
      args: ["mcp"],
      cwd: driver.cwd,
      env: { CODEX_HOME: codexHome },
    };
    servers[WIN_JS_SERVER] = OFF; // mac 上 config.toml 里也有 node_repl，用不到就关掉
    // 旧版 ChatGPT.app 没有这个插件，开了会报"插件不存在"，所以按实际有没有来
    if (driver.hasUnified) plugins["unified-computer-use@openai-bundled"] = { enabled: true };
  } else {
    // windows：桌面那半只能走 node_repl + computer-use 插件的 @oai/sky，
    // 它的 unified 插件把 CUA_REPL_ENABLED_SURFACES 写死成 browser，开了也没有桌面 API。
    servers[WIN_JS_SERVER] = { enabled: true };
    plugins["computer-use@openai-bundled"] = { enabled: true };
  }

  return { servers, plugins };
}
