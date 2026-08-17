#!/usr/bin/env node
/**
 * 生成 src/browser-tools-snapshot.ts —— 上游 playwright MCP 工具清单的快照。
 *
 * 这份快照是 browser-hub 工具清单三级兜底的最后一级：
 *   在线上游实时拉 > ~/.mori/browser/tools-cache.json（上次拉到的）> 这个快照
 * 只有全新环境、所有机器都离线时才会用到它。
 *
 * 怎么跑：先让任一台机器的 playwright daemon 起来、隧道通到 VPS，然后
 *   node scripts/gen-tools-snapshot.mjs [http://127.0.0.1:27781/mcp]
 *
 * 升级 @playwright/mcp 之后重跑一次即可（正常运行不依赖它，跑不跑都不影响已部署的 hub）。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const endpoint = process.argv[2] || "http://127.0.0.1:27781/mcp";
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "browser-tools-snapshot.ts");

/** 打一发 JSON-RPC；playwright MCP 的 HTTP 回的是 SSE（data: 开头），要挑出来 */
async function rpc(body, sid) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sid) headers["mcp-session-id"] = sid;
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  const outSid = res.headers.get("mcp-session-id") || sid;
  const text = await res.text();
  if (!text) return { json: null, sid: outSid };
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = dataLine ? dataLine.slice(6) : text;
  return { json: JSON.parse(payload), sid: outSid };
}

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "browser-hub-snapshot-gen", version: "1" },
  },
});
if (!init.sid) throw new Error(`没拿到 mcp-session-id，${endpoint} 不像一个 MCP 端点`);

const upstream = init.json?.result?.serverInfo ?? {};
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, init.sid);

const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, init.sid);
const tools = list.json?.result?.tools;
if (!Array.isArray(tools) || tools.length === 0) {
  throw new Error(`tools/list 没拿到工具：${JSON.stringify(list.json).slice(0, 300)}`);
}

// 按名字排序，让快照的 diff 稳定（上游返回顺序不保证）
tools.sort((a, b) => a.name.localeCompare(b.name));

const today = new Date().toISOString().slice(0, 10);
const header = `import { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * 上游 playwright MCP 的工具清单快照。
 *
 * 来源：${upstream.name ?? "playwright-mcp"} ${upstream.version ?? "(版本未知)"}，${today} 从 ${endpoint} 拉取。
 * 用途：browser-hub 工具清单三级兜底的最后一级——在线上游 > 磁盘缓存 > 这份快照。
 *       只有全新环境 + 所有机器都离线时才用得到，正常运行永远用上游实时拉到的那份。
 *
 * 别手改这个文件。升级 @playwright/mcp 后重新生成：
 *   node scripts/gen-tools-snapshot.mjs [endpoint]
 */
export const SNAPSHOT_TOOLS: Tool[] = `;

const ts = header + JSON.stringify(tools, null, 2) + " as unknown as Tool[];\n";
writeFileSync(outPath, ts, "utf-8");

console.log(
  `写入 ${outPath}\n` +
    `  上游：${upstream.name ?? "?"} ${upstream.version ?? "?"}\n` +
    `  工具数：${tools.length}\n` +
    `  文件大小：${(ts.length / 1024).toFixed(1)} KB\n` +
    `  工具名：${tools.map((t) => t.name).join(", ")}`
);
