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

interface Conn {
  client: Client;
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
  return /not connected|connection closed|terminated|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|transport|mcp-session-id|initialize first/i.test(msg);
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

  constructor(nodes: BrowserNode[], hub: HubClientManager, version: string) {
    this.nodes = new Map(nodes.map((n) => [n.name, n]));
    this.hub = hub;
    this.version = version;
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
    if (!node.sshUrl && !node.sshLocal) {
      throw new Error(
        `${name} 的 daemon 没起，而这个节点没有 ssh 端点（hub.json 里的 url），拉不起来。`
      );
    }

    // 经该机器自己的 ssh daemon 执行；server:"local" 表示在那台机器本机上跑。
    // ⚠️ up 脚本必须用 tmux/setsid 起 daemon：ssh daemon 被 launchctl kickstart -k 重启时
    // 会杀掉自己进程组里的后台进程，nohup 也挡不住（2026-08-17 另一条线实测）。
    let out = "";
    try {
      const r = await this.hub.callTool(
        name,
        "ssh",
        { server: "local", command: up, timeout: 60 },
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
      name,
      "ssh",
      { server: "local", command: cmd, timeout: 30 },
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
    const conn: Conn = { client };
    this.conns.set(name, conn);
    return conn;
  }

  private async getConn(name: string): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing) return existing;
    return this.open(name);
  }

  private drop(name: string): void {
    const c = this.conns.get(name);
    if (c) {
      c.client.close().catch(() => {});
      this.conns.delete(name);
    }
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
    for (const name of [...this.conns.keys()]) this.drop(name);
  }
}
