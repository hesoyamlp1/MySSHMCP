import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { BrowserNode } from "./browser-config.js";
import { HubClientManager } from "./hub-client.js";
import { probeTcp } from "./net-probe.js";

/** 上游 playwright daemon 握手超时：机器半死（端口在 listen 但 daemon 无响应）时别卡满 60s */
const CONNECT_TIMEOUT_MS = 8000;
/**
 * 浏览器操作的默认请求超时。playwright 自己的 timeout-navigation 就是 60s，
 * 截图和大页面 snapshot 也慢，所以留到 120s，别让 SDK 默认 60s 把正常导航砍掉。
 */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** 拉起 daemon 后等它 bind 端口：每 1.5s 探一次，最多 ~18s */
const UP_POLL_INTERVAL_MS = 1500;
const UP_POLL_TRIES = 12;
/**
 * 上游浏览器连接的空闲阈值：本会话多久没碰某台机器的浏览器，就主动断开它（发 DELETE，
 * 让那边关掉 browser context）。hub 会话本身照旧活着（2h 才回收），下次调用会自动重连——
 * 只是页面要重新导航。
 *
 * 为什么要有这一层：mac 上的浏览器是有头的，每个会话的 context 就是屏幕上的一个窗口；
 * 三分之一的 hub 会话是等到 2h 空闲回收才结束的（2026-08-19 从 journal 统计），
 * 没有这层的话它们的窗口就在屏幕上留两个小时。
 * 环境变量 BROWSER_HUB_UPSTREAM_IDLE_MIN 可改，0 = 不做。
 */
export const UPSTREAM_IDLE_MS = (() => {
  const v = process.env.BROWSER_HUB_UPSTREAM_IDLE_MIN;
  if (v === undefined || v === "") return 30 * 60 * 1000;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * 60 * 1000 : 30 * 60 * 1000;
})();
/** 断开时给上游发 DELETE 的等待上限；发不出去就直接关本地连接，别卡住关闭流程 */
const TERMINATE_TIMEOUT_MS = 3000;

interface Conn {
  client: Client;
  transport: StreamableHTTPClientTransport;
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

/** 连接层失效（上游 daemon 重启 / 隧道断了 / session 被回收） */
function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  // "Session not found"：上游 daemon 重启过、旧 session id 它已经不认识（2026-08-19 实测漏了这条，
  // 漏掉的后果是这条会话到那台机器的连接永远不丢弃、每次调用都报同一个错）
  return /not connected|connection closed|terminated|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|transport|mcp-session-id|initialize first|session not found/i.test(msg);
}

function parseEndpoint(url: string): { host: string; port: number } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === "https:" ? 443 : 80),
  };
}

/* ------------------------------------------------------------------ *
 * 工具清单的缓存
 *
 * 透传要求 hub 启动时就能报出上游那 23 个工具，但冷启动时上游可能全离线。
 * 于是三级兜底：上游实时拉到的 > 磁盘缓存（上次拉到的）> 仓库里的快照文件。
 * 磁盘缓存让工具清单自动跟着上游版本走，不用手工维护快照。
 * ------------------------------------------------------------------ */

function toolsCachePath(): string {
  return join(homedir(), ".mori", "browser", "tools-cache.json");
}

export function loadCachedTools(): Tool[] | undefined {
  try {
    const raw = readFileSync(toolsCachePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.tools) && parsed.tools.length > 0) return parsed.tools as Tool[];
  } catch {
    /* 没有缓存是正常情况 */
  }
  return undefined;
}

export function saveCachedTools(tools: Tool[], sourceNode: string): void {
  if (tools.length === 0) return;
  try {
    const p = toolsCachePath();
    mkdirSync(dirname(p), { recursive: true });
    // 不带时间戳：内容不变时文件也不变，省得每次启动都写盘
    writeFileSync(p, JSON.stringify({ sourceNode, tools }, null, 2), "utf-8");
  } catch {
    /* 写不进去不致命，下次再说 */
  }
}

/**
 * 管理 hub → 各机器上游 playwright daemon 的连接。
 *
 * 每个 Claude 会话各自 new 一份（跟 HubClientManager 一样的语义）：
 * 一份 manager = 一组到上游的独立 MCP session = 一批独立的 browser context。
 * 上游用 --isolated 跑，所以多个会话连同一台机器的同一个 daemon 也互不干扰。
 */
export class BrowserClientManager {
  private nodes: Map<string, BrowserNode>;
  private conns: Map<string, Conn> = new Map();
  /** 借 ssh-hub 在目标机器上执行 up/down 命令；browser-hub 自己不实现任何 ssh 能力 */
  private hub: HubClientManager;
  private version: string;
  /** 本会话在每台机器上最后一次调用的时间，给 status / 空闲判断用 */
  private lastUse: Map<string, number> = new Map();
  /** 因空闲被主动断开、还没告诉过调用方的机器（下次调用时提示一句"页面要重新导航"） */
  private idleDropped: Set<string> = new Set();
  private idleTimer?: NodeJS.Timeout;

  constructor(nodes: BrowserNode[], hub: HubClientManager, version: string) {
    this.nodes = new Map(nodes.map((n) => [n.name, n]));
    this.hub = hub;
    this.version = version;
    if (UPSTREAM_IDLE_MS > 0) {
      const tick = Math.min(60_000, Math.max(5_000, Math.floor(UPSTREAM_IDLE_MS / 4)));
      this.idleTimer = setInterval(() => this.sweepIdle(), tick);
      if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
    }
  }

  /** 空闲扫描：本会话太久没碰的上游连接主动断开（那边关 context、窗口消失） */
  private sweepIdle(): void {
    const now = Date.now();
    for (const name of [...this.conns.keys()]) {
      const last = this.lastUse.get(name) ?? now;
      if (now - last > UPSTREAM_IDLE_MS) {
        console.error(
          `[mcp-ssh-pty:browser-hub] upstream idle ${Math.round((now - last) / 60000)}min, dropping ${name}`
        );
        this.drop(name);
        this.idleDropped.add(name);
      }
    }
  }

  /**
   * 取走"这台机器的上游连接刚因空闲被断开过"这个标记（只报一次）。
   * 调用方拿到 true 时在结果前面加一句说明，免得模型对着"No open tabs"发懵。
   */
  takeIdleDroppedNote(name: string): boolean {
    return this.idleDropped.delete(name);
  }

  listNodes(): BrowserNode[] {
    return [...this.nodes.values()];
  }

  getNode(name: string): BrowserNode | undefined {
    return this.nodes.get(name);
  }

  lastUsedAt(name: string): number | undefined {
    return this.lastUse.get(name);
  }

  /** 本会话是否已经跟这台机器建立了上游连接（= 有一个活着的 browser context） */
  isConnected(name: string): boolean {
    return this.conns.has(name);
  }

  /**
   * 看那台机器上实际跑的 daemon 是有头还是无头（进程参数里有没有 --headless）。
   * 经 ssh 跑一条 ps，只在 status 里用（list 每次探三台太重）。windows 上没有 ps，返回 unknown。
   * 用途：hub.json 里的 headed 只是声明，daemon 可能是 PW_HEADLESS=1 起的、或脚本没更新，
   * 声明和实际不一致时 status 要能说出来。
   */
  async detectMode(name: string): Promise<"headed" | "headless" | "unknown"> {
    const node = this.nodes.get(name);
    if (!node) return "unknown";
    if (!node.browser.via && !node.sshUrl && !node.sshLocal) return "unknown";
    try {
      const r = await this.hub.callTool(
        node.browser.via ?? name,
        "ssh",
        {
          server: node.browser.server ?? "local",
          // 排除 tmux：tmux server 的 argv 会一直保留第一次 `tmux new -d -s pwmcp playwright-mcp …` 那串
          // （包括早年的 --headless），不排掉就把它当成 daemon 了（2026-08-19 实测踩到）
          command: "ps -axo args= | grep '[p]laywright-mcp --port' | grep -v '^tmux' | head -1",
          timeout: 10,
        },
        { timeoutMs: 20_000 }
      );
      const c = r.content?.[0];
      const out = c && c.type === "text" ? c.text : "";
      if (!/playwright-mcp/.test(out)) return "unknown";
      return /--headless/.test(out) ? "headless" : "headed";
    } catch {
      return "unknown";
    }
  }

  /** 探上游 playwright daemon 的端口通不通 */
  async probe(name: string): Promise<boolean | undefined> {
    const node = this.nodes.get(name);
    if (!node) return undefined;
    try {
      const { host, port } = parseEndpoint(node.browser.url);
      return await probeTcp(host, port);
    } catch {
      return undefined;
    }
  }

  /**
   * 确保那台机器上的 daemon 起着。已经通就直接返回；
   * 不通就借该机器的 ssh daemon 跑 up 命令，再轮询到端口起来。
   */
  async ensureUp(name: string): Promise<{ alreadyUp: boolean; detail: string }> {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`未知 node: ${name}`);

    if (await this.probe(name)) return { alreadyUp: true, detail: "daemon 已在运行" };

    const up = node.browser.up;
    if (!up) {
      throw new Error(
        `${name} 的 playwright daemon 没起，而它的 browser 段没配 up 命令。\n` +
          `手工去那台机器上起，或者在 hub.json 给它加 "up": "bash ~/.mori/pw-up.sh"。`
      );
    }
    // 在哪执行：默认是这台机器自己的 ssh daemon（三台 mac 都自己跑着一个）。
    // 没有自己 ssh daemon 的机器靠 via 借通路——家里那台 windows 是 via:"vps" +
    // server:"windows-4070ti"（它挂在 vps 节点下面）。
    const via = node.browser.via ?? name;
    const server = node.browser.server ?? "local";
    if (!node.browser.via && !node.sshUrl && !node.sshLocal) {
      throw new Error(
        `${name} 的 daemon 没起，而这个节点既没有自己的 ssh 端点，也没写 browser.via，拉不起来。`
      );
    }

    // ⚠️ up 脚本必须让 daemon 脱离当前 session：mac 上用 tmux/setsid（ssh daemon 被
    // launchctl kickstart -k 重启时会杀掉自己进程组里的后台进程，nohup 挡不住），
    // windows 上用 WMI 的 Win32_Process.Create（OpenSSH 的 Job Object 会连
    // Start-Process 起的隐藏进程一起终止）。两处都是 2026-08-17 实测踩出来的。
    let out = "";
    try {
      const r = await this.hub.callTool(
        via,
        "ssh",
        { server, command: up, timeout: 60 },
        { timeoutMs: 90_000 }
      );
      const c = r.content?.[0];
      if (c && c.type === "text") out = c.text.slice(0, 600);
      if (r.isError) throw new Error(out || "up 命令返回错误");
    } catch (e) {
      throw new Error(
        `在 ${name} 上执行 up 命令失败：${e instanceof Error ? e.message : String(e)}\n` +
          `命令：${up}`
      );
    }

    for (let i = 0; i < UP_POLL_TRIES; i++) {
      if (await this.probe(name)) {
        return { alreadyUp: false, detail: `已拉起 daemon${out ? `：${out}` : ""}` };
      }
      await new Promise((r) => setTimeout(r, UP_POLL_INTERVAL_MS));
    }
    throw new Error(
      `在 ${name} 上跑完 up 命令，但 ${node.browser.url} 一直没通（等了 ${
        (UP_POLL_TRIES * UP_POLL_INTERVAL_MS) / 1000
      }s）。\n` +
        `up 命令的输出：${out || "(空)"}\n` +
        `多半是那台机器的反向隧道没把 8930 转过来，去那台机器看 tmux 里 daemon 的日志。`
    );
  }

  /** 停掉那台机器上的 daemon（省内存）；本会话到它的连接一并丢弃 */
  async down(name: string): Promise<string> {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`未知 node: ${name}`);
    this.drop(name);
    const cmd = node.browser.down;
    if (!cmd) {
      return `${name} 的 browser 段没配 down 命令，只断开了本会话的连接，daemon 还在那台机器上跑着。`;
    }
    const r = await this.hub.callTool(
      node.browser.via ?? name,
      "ssh",
      { server: node.browser.server ?? "local", command: cmd, timeout: 30 },
      { timeoutMs: 60_000 }
    );
    const c = r.content?.[0];
    return c && c.type === "text" ? c.text.slice(0, 600) : `已在 ${name} 上执行 down`;
  }

  private async open(name: string): Promise<Conn> {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`未知 node: ${name}`);

    const client = new Client({ name: "browser-hub", version: this.version }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(node.browser.url));
    try {
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `连接 ${name} 的 playwright daemon`
      );
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    const conn: Conn = { client, transport };
    this.conns.set(name, conn);
    this.lastUse.set(name, Date.now());
    return conn;
  }

  private async getConn(name: string): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing) return existing;
    return this.open(name);
  }

  /**
   * 丢弃到某台机器的上游连接。先给上游发 DELETE（SDK 的 terminateSession），让 playwright daemon
   * 立刻关掉这个会话的 browser context——有头模式下就是屏幕上的窗口马上消失。
   * 只 close() 不发 DELETE 的话，那边要靠心跳判死（0.0.79 实测 4~10 秒），0.0.75 则永远不关。
   * DELETE 发不出去（隧道断了、daemon 死了）就算了，别让关闭流程卡住。
   */
  private drop(name: string): void {
    const c = this.conns.get(name);
    if (!c) return;
    this.conns.delete(name);
    withTimeout(c.transport.terminateSession(), TERMINATE_TIMEOUT_MS, `通知 ${name} 结束会话`)
      .catch(() => {})
      .finally(() => {
        c.client.close().catch(() => {});
      });
  }

  /** 拉上游的工具清单，同时写进磁盘缓存供下次冷启动用 */
  async listTools(name: string): Promise<Tool[]> {
    const conn = await this.getConn(name);
    const r = await withTimeout(conn.client.listTools(), 15_000, `拉 ${name} 的工具清单`);
    const tools = (r.tools ?? []) as Tool[];
    if (tools.length > 0) saveCachedTools(tools, name);
    return tools;
  }

  /**
   * 在某台机器上调用一个 playwright 工具。
   *
   * 跟 ssh 那边不同：**连接断了不自动重发**。浏览器操作有副作用（点击、提交表单），
   * 重发可能让同一个动作发生两次；而且上游 daemon 重启后 browser context 已经没了，
   * 重发也不会回到原来的页面。所以这里丢弃连接、把话说清楚，让调用方自己决定重试。
   */
  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<CallToolResult> {
    const conn = await this.getConn(name);
    this.lastUse.set(name, Date.now());
    try {
      return (await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: opts?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS }
      )) as CallToolResult;
    } catch (e) {
      if (isConnectionError(e)) {
        this.drop(name);
        throw new Error(
          `跟 ${name} 上的浏览器断开了（${e instanceof Error ? e.message : String(e)}）。\n` +
            `没有自动重试——浏览器操作重发可能重复执行。那台机器的 daemon 多半重启了、` +
            `原来的页面已经不在，重新 browser_node({action:"connect"}) 再从导航开始。`
        );
      }
      throw e;
    }
  }

  async closeAll(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const name of [...this.conns.keys()]) this.drop(name);
  }
}
