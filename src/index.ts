#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { SSHManager } from "./ssh-manager.js";
import { ConfigManager } from "./config.js";
import { NotesManager } from "./notes-manager.js";
import { registerTools } from "./tools.js";
import { runCLI } from "./cli.js";

// CLI 命令列表
const CLI_COMMANDS = ["list", "add", "remove", "rm", "test", "config", "help", "--help", "-h", "--version", "-V"];

interface HttpOptions {
  port: number;
  host: string;
  token: string | null;
}

/**
 * 解析 argv，返回 HTTP 配置；未传 --http 则返回 null（走 stdio）
 */
function parseHttpOptions(argv: string[]): HttpOptions | null {
  if (!argv.includes("--http")) return null;

  const getArg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };

  const portStr = getArg("--port") ?? process.env.MCP_HTTP_PORT ?? "7777";
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`无效的 --port: ${portStr}`);
  }

  const host = getArg("--host") ?? process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const token = getArg("--token") ?? process.env.MCP_HTTP_TOKEN ?? null;

  return { port, host, token };
}

/**
 * 检查是否是 CLI 模式
 */
function isCLIMode(): boolean {
  const args = process.argv.slice(2);
  if (args.length === 0) return false;
  return CLI_COMMANDS.includes(args[0]);
}

/**
 * 构造一个 McpServer 实例并注册工具
 * HTTP 模式下每个连接可能共用一个 server，但 stateless 语义下工具是纯函数式调度，
 * 为避免跨请求的 SSHManager 状态互相污染，HTTP 调用方应自行约束"一个会话只用一个客户端"。
 */
function buildServer(): { server: McpServer; sshManager: SSHManager } {
  const server = new McpServer({
    name: "ssh-mcp-server",
    version: "1.0.0",
  });

  const sshManager = new SSHManager();
  const configManager = new ConfigManager();
  const notesManager = new NotesManager();

  registerTools(server, sshManager, configManager, notesManager);
  return { server, sshManager };
}

/**
 * 启动 stdio MCP 服务器（默认模式，一个进程对应一个 client）
 */
async function startStdioServer(): Promise<void> {
  const { server, sshManager } = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = async () => {
    await sshManager.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  sshManager: SSHManager;
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { method?: unknown };
  return b.method === "initialize";
}

/**
 * 启动 HTTP MCP 服务器（stateful 模式，SDK canonical pattern）
 * - 每个 initialize 请求新建一个 Session（独立 McpServer + SSHManager + transport）
 * - 后续请求通过 Mcp-Session-Id header 路由到对应 session
 * - DELETE /mcp 带 session-id 清理 session
 * - SSHManager 状态随 session 保持（一个 VPS Claude Code 连一个 mac daemon，即一个 session）
 */
async function startHttpServer(opts: HttpOptions): Promise<void> {
  const sessions = new Map<string, Session>();

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const authOk = (req: IncomingMessage): boolean => {
    if (!opts.token) return true;
    const h = req.headers["authorization"];
    if (!h || Array.isArray(h)) return false;
    if (!h.startsWith("Bearer ")) return false;
    return h.slice(7) === opts.token;
  };

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
          "Access-Control-Expose-Headers": "Mcp-Session-Id",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          name: "ssh-mcp-server",
          activeSessions: sessions.size,
        }));
        return;
      }

      if (!req.url || !req.url.startsWith("/mcp")) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      if (!authOk(req)) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let parsedBody: unknown = undefined;
      if (req.method === "POST") {
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_json" }));
            return;
          }
        }
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      let session: Session | undefined;

      if (sessionId && sessions.has(sessionId)) {
        session = sessions.get(sessionId);
      } else if (req.method === "POST" && isInitializeRequest(parsedBody)) {
        const { server, sshManager } = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            const sess: Session = { transport, server, sshManager };
            sessions.set(sid, sess);
            console.error(`[mcp-ssh-pty] session opened: ${sid} (active=${sessions.size})`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            sshManager.disconnect().catch(() => {});
            console.error(`[mcp-ssh-pty] session closed: ${sid} (active=${sessions.size})`);
          }
        };
        await server.connect(transport);
        session = { transport, server, sshManager };
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "bad_request",
          message: "missing or invalid Mcp-Session-Id; initialize first",
        }));
        return;
      }

      await session!.transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(`[mcp-ssh-pty] request error: ${msg}\n${stack ?? ""}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error", message: msg }));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });

  httpServer.listen(opts.port, opts.host, () => {
    const authNote = opts.token ? " (bearer auth enabled)" : " (no auth — bind to loopback recommended)";
    console.error(`[mcp-ssh-pty] HTTP listening on http://${opts.host}:${opts.port}/mcp${authNote}`);
  });

  const cleanup = async () => {
    httpServer.close();
    for (const sess of sessions.values()) {
      await sess.transport.close().catch(() => {});
      await sess.sshManager.disconnect().catch(() => {});
    }
    sessions.clear();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

/**
 * 主函数
 */
async function main(): Promise<void> {
  if (isCLIMode()) {
    await runCLI();
    return;
  }

  const httpOpts = parseHttpOptions(process.argv.slice(2));
  if (httpOpts) {
    await startHttpServer(httpOpts);
  } else {
    await startStdioServer();
  }
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
