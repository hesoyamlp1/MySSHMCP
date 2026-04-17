#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
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

/**
 * 启动 HTTP MCP 服务器（stateless 模式）
 * - 监听 POST/GET/DELETE /mcp
 * - 每个请求构造全新的 McpServer + SSHManager，避免跨请求污染
 *   注意：这意味着 HTTP 模式下 "一次调用 = 一次性连接"，无法像 stdio 那样维持 PTY 会话
 *   如果需要跨调用的 PTY 会话，需使用 stateful 模式（后续 phase）
 *
 * ⚠️ Phase 1 简化：本版本 HTTP 模式暂按 stateful 实现，整个进程共享单一 SSHManager
 *    这对"一台 mac 服务一个 VPS Claude Code"的单用户场景最简单；生产级多用户需要 stateful+sessionId。
 */
async function startHttpServer(opts: HttpOptions): Promise<void> {
  const { server, sshManager } = buildServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless：不生成 sessionId，整个进程一个 transport
  });

  await server.connect(transport);

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
      // CORS（本地回环绑定通常不需要，但保留基础支持）
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
        });
        res.end();
        return;
      }

      // 健康检查
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, name: "ssh-mcp-server" }));
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

      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    await transport.close();
    await sshManager.disconnect();
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
