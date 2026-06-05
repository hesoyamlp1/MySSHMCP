import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HubNode } from "./hub-config.js";
import { buildDirectServer } from "./server-factory.js";

interface Conn {
  client: Client;
  /** 额外清理（local 节点要顺带关掉 in-process server） */
  closeExtra?: () => Promise<void>;
}

/** 远程节点 MCP 握手超时：mac 半死（端口在 listen 但 daemon 无响应）时别卡满 60s */
const CONNECT_TIMEOUT_MS = 6000;
/** 没带命令 timeout 的普通调用沿用 SDK 默认 60s */
const DEFAULT_CALL_TIMEOUT_MS = 60000;

/** 给一个 promise 套超时；超时 reject，不取消底层操作（底层会被随后的 drop 清掉） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    if (typeof t.unref === "function") t.unref(); // 别因为这个 timer 拖住进程退出
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * 转发的命令可能跑很久（pip / apt / build），daemon 端有自己的 timeout 参数。
 * client 请求超时必须 ≥ 命令 timeout，否则会被 SDK 默认 60s 砍掉、还可能触发重试重复执行。
 */
function callTimeoutFor(args: Record<string, unknown>): number {
  const t = typeof args.timeout === "number" ? args.timeout : undefined;
  if (t && t > 0) return (t + 30) * 1000; // 命令最长等待 + 30s 缓冲
  return DEFAULT_CALL_TIMEOUT_MS;
}

/**
 * 是否「连接层」失效（可安全重连重发）。
 * 命令执行中的超时 / 业务错误不算——那种重发可能让有副作用的命令跑两遍。
 */
function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /not connected|connection closed|terminated|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|transport/i.test(msg);
}

/**
 * 管理 hub → 各下游节点的 MCP 连接。
 * - 远程节点：StreamableHTTP client 连到 mac daemon（带 Bearer）
 * - 本地节点：InMemoryTransport 直接连一份 in-process 直连 server（VPS 自己）
 * - 按 node 名懒连接并缓存；调用失败丢弃缓存、重连一次
 * - 每个下游连接 = 一份独立 SSHManager，多台机器的连接/PTY 可同时活着，hub 只路由
 */
export class HubClientManager {
  private nodes: Map<string, HubNode>;
  private conns: Map<string, Conn> = new Map();
  private version: string;

  constructor(nodes: HubNode[], version: string) {
    this.nodes = new Map(nodes.map((n) => [n.name, n]));
    this.version = version;
  }

  listNodes(): HubNode[] {
    return [...this.nodes.values()];
  }

  getNode(name: string): HubNode | undefined {
    return this.nodes.get(name);
  }

  private async open(node: HubNode): Promise<Conn> {
    const client = new Client({ name: "ssh-hub", version: "0" }, { capabilities: {} });

    if (node.local) {
      // in-process：把一份直连 server 用内存管道接给 client
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const { server } = buildDirectServer(this.version);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const conn: Conn = { client, closeExtra: () => server.close() };
      this.conns.set(node.name, conn);
      return conn;
    }

    const transport = new StreamableHTTPClientTransport(new URL(node.url!), {
      requestInit: node.token
        ? { headers: { Authorization: `Bearer ${node.token}` } }
        : undefined,
    });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 node '${node.name}'`);
    } catch (e) {
      await client.close().catch(() => {}); // 半连接别泄漏
      throw e;
    }
    const conn: Conn = { client };
    this.conns.set(node.name, conn);
    return conn;
  }

  private async getConn(name: string): Promise<Conn> {
    const existing = this.conns.get(name);
    if (existing) return existing;
    const node = this.nodes.get(name);
    if (!node) throw new Error(`未知 node: ${name}`);
    return this.open(node);
  }

  private drop(name: string): void {
    const c = this.conns.get(name);
    if (c) {
      c.client.close().catch(() => {});
      c.closeExtra?.().catch(() => {});
      this.conns.delete(name);
    }
  }

  /**
   * 调用某 node 上的工具（ssh / sftp）。
   * - timeoutMs：client 请求超时；不传则按转发命令的 timeout 参数放大（长命令不被默认 60s 误杀）
   * - 建连阶段失败 → drop 重连一次（命令还没发出，安全）
   * - 命令已发出后失败：只有「连接断了」才重连重发；超时 / 业务错误直接抛，避免命令重复执行
   */
  async callTool(
    name: string,
    toolName: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<CallToolResult> {
    const timeout = opts?.timeoutMs ?? callTimeoutFor(args);

    let conn: Conn;
    try {
      conn = await this.getConn(name);
    } catch {
      // 缓存可能是 stale 的：丢弃后重连一次（仍失败就抛）
      this.drop(name);
      conn = await this.getConn(name);
    }

    try {
      return (await conn.client.callTool({ name: toolName, arguments: args }, undefined, { timeout })) as CallToolResult;
    } catch (callErr) {
      if (!isConnectionError(callErr)) throw callErr;
      // 连接在请求途中断了：重连重发一次
      this.drop(name);
      const conn2 = await this.getConn(name);
      return (await conn2.client.callTool({ name: toolName, arguments: args }, undefined, { timeout })) as CallToolResult;
    }
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.conns.keys()]) this.drop(name);
  }
}
