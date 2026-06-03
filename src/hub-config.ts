import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * hub 模式的一个下游节点。两种形态：
 * - 远程节点：一台跑着 --http 直连 daemon 的 mac，经反向隧道暴露在 VPS 某端口（给 url[+token]）
 * - 本地节点：hub 所在机器（VPS）自己，in-process 直连，不用额外起 daemon（给 local:true）
 */
export interface HubNode {
  name: string;        // 节点名，如 mac1 / macbook / vps
  url?: string;        // http://127.0.0.1:27777/mcp（远程节点必填）
  token?: string;      // 该 daemon 的 Bearer token（与 MCP_HTTP_TOKEN 一致）
  local?: boolean;     // true=本机 in-process 直连（VPS 自己），此时不需要 url
}

export interface HubConfig {
  nodes: HubNode[];
}

function defaultHubPath(): string {
  return join(homedir(), ".mori", "ssh", "hub.json");
}

/**
 * 加载 hub 配置。优先级：显式 path > 环境变量 SSH_MCP_HUB_CONFIG > ~/.mori/ssh/hub.json
 */
export function loadHubConfig(path?: string): HubConfig {
  const p = path || process.env.SSH_MCP_HUB_CONFIG || defaultHubPath();
  if (!existsSync(p)) {
    throw new Error(
      `hub 配置不存在: ${p}\n需要形如 { "nodes": [ { "name": "mac1", "url": "http://127.0.0.1:27777/mcp", "token": "xxx" } ] }`
    );
  }
  let cfg: HubConfig;
  try {
    cfg = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    throw new Error(`hub 配置 JSON 解析失败: ${p}\n${e instanceof Error ? e.message : String(e)}`);
  }
  if (!cfg.nodes || !Array.isArray(cfg.nodes) || cfg.nodes.length === 0) {
    throw new Error(`hub 配置里没有 nodes（至少要有一个节点）: ${p}`);
  }
  for (const n of cfg.nodes) {
    if (!n.name) {
      throw new Error(`hub 节点缺少 name: ${JSON.stringify(n)}`);
    }
    if (!n.local && !n.url) {
      throw new Error(`hub 节点 '${n.name}' 既不是 local 也没给 url`);
    }
  }
  return cfg;
}
