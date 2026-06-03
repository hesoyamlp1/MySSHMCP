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
    await client.connect(transport);
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
   * 调用某 node 上的工具（ssh / sftp）。失败重连一次。
   */
  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const conn = await this.getConn(name);
      return (await conn.client.callTool({ name: toolName, arguments: args })) as CallToolResult;
    } catch (firstErr) {
      // 缓存连接可能已失效：丢弃后重连一次
      this.drop(name);
      try {
        const conn = await this.getConn(name);
        return (await conn.client.callTool({ name: toolName, arguments: args })) as CallToolResult;
      } catch {
        throw firstErr; // 抛原始错误，更能反映根因
      }
    }
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.conns.keys()]) this.drop(name);
  }
}
