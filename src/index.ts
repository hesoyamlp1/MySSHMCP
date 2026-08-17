#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SSHManager } from "./ssh-manager.js";
import { runCLI } from "./cli.js";
import { buildDirectServer } from "./server-factory.js";
import { loadHubConfig } from "./hub-config.js";
import { HubClientManager } from "./hub-client.js";
import { buildHubServer } from "./hub.js";

const PKG_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// CLI 命令列表
const CLI_COMMANDS = ["list", "add", "remove", "rm", "test", "config", "help", "--help", "-h", "--version", "-v"];

interface HttpOptions {
  port: number;
  host: string;
  token: string | null;
  /** 空闲会话回收阈值（分钟）；undefined = 用各模式的默认值，0 = 不回收 */
  idleMin?: number;
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

  const idleStr = getArg("--idle-min") ?? process.env.MCP_HTTP_IDLE_MIN;
  let idleMin: number | undefined;
  if (idleStr !== undefined) {
    idleMin = Number(idleStr);
    if (!Number.isFinite(idleMin) || idleMin < 0) throw new Error(`无效的 --idle-min: ${idleStr}`);
  }

  return { port, host, token, idleMin };
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
  return buildDirectServer(PKG_VERSION);
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
  /** 释放这个会话独占的资源（直连模式：SSHManager；hub 模式：到各 node 的下游连接） */
  close: () => Promise<void>;
  lastActivity: number; // 用于 idle 回收：非优雅断开时 onclose 不触发，靠这个扫掉僵尸 session
}

/**
 * 一个 HTTP 会话背后要挂的东西：一份独立的 McpServer + 释放它的办法。
 * 直连模式和 hub 模式各给一个工厂，HTTP 会话管理这一层是共用的。
 */
interface HttpServeSpec {
  /** health 里显示、日志里带的名字 */
  name: string;
  /** 默认空闲回收阈值（毫秒），0 = 不回收；--idle-min 可覆盖 */
  defaultIdleMs: number;
  makeServer: () => { server: McpServer; close: () => Promise<void> };
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { method?: unknown };
  return b.method === "initialize";
}

/**
 * 启动 HTTP MCP 服务器（stateful 模式，SDK canonical pattern）
 * - 每个 initialize 请求新建一个 Session（独立 McpServer + transport + 该模式的独占资源）
 * - 后续请求通过 Mcp-Session-Id header 路由到对应 session
 * - DELETE /mcp 带 session-id 清理 session
 * - 会话状态随 session 保持：直连模式是 SSHManager（一个 Claude Code 连一个 mac daemon）；
 *   hub 模式是「当前 node + 到各 node 的下游连接」（一个 Claude Code 会话 = 一份 HubClientManager）
 */
async function serveHttp(opts: HttpOptions, spec: HttpServeSpec): Promise<void> {
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();
  const idleMs = opts.idleMin !== undefined ? opts.idleMin * 60 * 1000 : spec.defaultIdleMs;

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
          name: spec.name,
          version: PKG_VERSION,
          activeSessions: sessions.size,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          idleReapMin: idleMs > 0 ? idleMs / 60000 : 0,
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
        const { server, close } = spec.makeServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            const sess: Session = { transport, server, close, lastActivity: Date.now() };
            sessions.set(sid, sess);
            console.error(`[mcp-ssh-pty:${spec.name}] session opened: ${sid} (active=${sessions.size})`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            close().catch(() => {});
            console.error(`[mcp-ssh-pty:${spec.name}] session closed: ${sid} (active=${sessions.size})`);
          }
        };
        await server.connect(transport);
        session = { transport, server, close, lastActivity: Date.now() };
      } else {
        // 规范：带了 session id 但服务端不认识 → 404，客户端应重新 initialize
        // （守护进程重启、或空闲会话被回收之后就是这种情况）
        res.writeHead(sessionId ? 404 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: sessionId ? "session_not_found" : "bad_request",
          message: sessionId
            ? "unknown Mcp-Session-Id (daemon restarted or session reaped); re-initialize"
            : "missing Mcp-Session-Id; initialize first",
        }));
        return;
      }

      session!.lastActivity = Date.now();
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
    const reapNote = idleMs > 0 ? `, idle reap ${idleMs / 60000}min` : ", no idle reap";
    console.error(`[mcp-ssh-pty:${spec.name}] HTTP listening on http://${opts.host}:${opts.port}/mcp${authNote}${reapNote}`);
  });

  // 回收 idle session：客户端非优雅断开（Claude 重启 / 反向隧道断）时 transport.onclose
  // 不触发，session 会连同它的 SSHManager 泄漏。定期扫描，关掉久无活动的。
  // 阈值按模式定：直连 daemon 默认 30 分钟；hub 默认 24 小时（Claude 会话经常空半小时以上，
  // 回收了它下次 ssh 就得重新 initialize；hub 会话本身很小，下游 daemon 有自己的回收）。
  const SESSION_SWEEP_MS = 5 * 60 * 1000;  // 每 5 分钟扫一次
  const sweepTimer = idleMs > 0
    ? setInterval(() => {
        const now = Date.now();
        for (const [sid, sess] of sessions) {
          if (now - sess.lastActivity > idleMs) {
            console.error(`[mcp-ssh-pty:${spec.name}] reaping idle session ${sid} (idle ${Math.round((now - sess.lastActivity) / 1000)}s, active=${sessions.size})`);
            sess.transport.close().catch(() => {}); // 触发 onclose → sessions.delete + close()
          }
        }
      }, SESSION_SWEEP_MS)
    : undefined;
  sweepTimer?.unref(); // 别因为这个 timer 拖住进程退出

  const cleanup = async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    await new Promise<void>((r) => httpServer.close(() => r()));
    for (const sess of sessions.values()) {
      await sess.transport.close().catch(() => {});
      await sess.close().catch(() => {});
    }
    sessions.clear();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

/** 直连模式的 HTTP daemon（跑在每台 mac 上） */
async function startHttpServer(opts: HttpOptions): Promise<void> {
  await serveHttp(opts, {
    name: "ssh-mcp-server",
    defaultIdleMs: 30 * 60 * 1000,
    makeServer: () => {
      const { server, sshManager } = buildServer();
      return { server, close: () => sshManager.disconnect() };
    },
  });
}

/**
 * 启动 hub 模式：对 Claude 只露一个 ssh/sftp，内部按 node 路由到各 mac daemon。
 * - 默认 stdio：一个 Claude 会话起一个 hub 进程（每个约 100M）。
 * - 加 --http：一个常驻 hub 守护进程服务所有 Claude 会话；每个 MCP 会话各自一份
 *   HubClientManager（当前 node + 下游连接），互不串台。VPS 上多个会话共用时省下 N-1 个进程。
 */
async function startHubServer(argv: string[]): Promise<void> {
  const getArg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };

  const cfg = loadHubConfig(getArg("--hub-config"));
  const nodeNames = cfg.nodes.map((n) => n.name).join(", ");

  const httpOpts = parseHttpOptions(argv);
  if (httpOpts) {
    console.error(`[mcp-ssh-pty:ssh-hub] hub mode (http): ${cfg.nodes.length} node(s): ${nodeNames}`);
    await serveHttp(httpOpts, {
      name: "ssh-hub",
      defaultIdleMs: 24 * 60 * 60 * 1000,
      makeServer: () => {
        const mgr = new HubClientManager(cfg.nodes, PKG_VERSION);
        return { server: buildHubServer(mgr, PKG_VERSION), close: () => mgr.closeAll() };
      },
    });
    return;
  }

  const mgr = new HubClientManager(cfg.nodes, PKG_VERSION);
  const server = buildHubServer(mgr, PKG_VERSION);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp-ssh-pty] hub mode: ${cfg.nodes.length} node(s): ${nodeNames}`);

  const cleanup = async () => {
    await mgr.closeAll().catch(() => {});
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

  const argv = process.argv.slice(2);

  if (argv.includes("--hub")) {
    await startHubServer(argv);
    return;
  }

  const httpOpts = parseHttpOptions(argv);
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
