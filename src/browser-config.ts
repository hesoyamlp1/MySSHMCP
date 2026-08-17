import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * browser-hub 的配置寄生在 ssh-hub 的 hub.json 里：
 * 节点带 browser 段的就是一个浏览器节点，顶层 browserRoutes 是按 URL 选机器的规则。
 * 这样节点定义（名字、ssh daemon 的 url/token）只写一份，两个 hub 共用。
 */

/** 一台机器上的 playwright daemon 规格 */
export interface BrowserSpec {
  /** 上游 playwright MCP 端点，经反向隧道落在 VPS 的某个端口（每台机器一个不同端口） */
  url: string;
  /** 拉起 daemon 的命令，经该机器自己的 ssh daemon 执行 */
  up?: string;
  /** 停掉 daemon 的命令 */
  down?: string;
  /** 同一台机器上允许的并发会话数；内存约束下的人工经验值，不是实测容量 */
  concurrency?: number;
  /** 这台机器的 storageState 里有哪些站的登录态——给模型选机器时看的，不参与匹配 */
  logins?: string[];
  /** 这台机器能到哪些网络（公司内网 / 家里内网 / 公网） */
  reach?: string[];
  note?: string;
}

/** 一个浏览器节点 = 一台机器的 playwright daemon + 怎么在那台机器上执行命令 */
export interface BrowserNode {
  name: string;
  browser: BrowserSpec;
  /** 该机器 ssh daemon 的端点（跑 up/down 命令要用它）；hub 本机节点没有 url */
  sshUrl?: string;
  sshToken?: string;
  sshLocal?: boolean;
}

/** 按 URL 选机器的一条规则；match 里任一模式命中即选中 node */
export interface BrowserRoute {
  match: string[];
  node: string;
  /** node 离线时改用它 */
  fallback?: string;
}

export interface BrowserHubConfig {
  nodes: BrowserNode[];
  routes: BrowserRoute[];
}

/** hub.json 里节点的原始形状（只取 browser-hub 关心的字段） */
interface RawNode {
  name?: string;
  url?: string;
  token?: string;
  local?: boolean;
  browser?: BrowserSpec;
}

interface RawConfig {
  nodes?: RawNode[];
  browserRoutes?: BrowserRoute[];
}

function defaultHubPath(): string {
  return join(homedir(), ".mori", "ssh", "hub.json");
}

/**
 * 加载 browser-hub 配置。路径优先级跟 ssh-hub 一致：
 * 显式 path > SSH_MCP_HUB_CONFIG > ~/.mori/ssh/hub.json
 *
 * 只有带 browser 段的节点会被收进来——三台 mac 里哪台铺好了就有哪台，
 * 不用为了 browser-hub 单独维护一份机器清单。
 */
export function loadBrowserConfig(path?: string): BrowserHubConfig {
  const p = path || process.env.SSH_MCP_HUB_CONFIG || defaultHubPath();
  if (!existsSync(p)) {
    throw new Error(
      `hub 配置不存在: ${p}\n` +
        `browser-hub 读的是 ssh-hub 那份 hub.json，需要至少一个节点带 browser 段，形如\n` +
        `{ "nodes": [ { "name": "macbook-air", "url": "...", "token": "...", ` +
        `"browser": { "url": "http://127.0.0.1:27781/mcp", "up": "bash ~/.mori/pw-up.sh" } } ] }`
    );
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    throw new Error(`hub 配置 JSON 解析失败: ${p}\n${e instanceof Error ? e.message : String(e)}`);
  }

  const nodes: BrowserNode[] = [];
  for (const n of raw.nodes ?? []) {
    if (!n.browser) continue; // 没铺浏览器的机器直接跳过，不是错误
    if (!n.name) throw new Error(`hub 节点缺少 name: ${JSON.stringify(n)}`);
    if (!n.browser.url) {
      throw new Error(`节点 '${n.name}' 的 browser 段缺少 url（上游 playwright MCP 端点）`);
    }
    nodes.push({
      name: n.name,
      browser: n.browser,
      sshUrl: n.url,
      sshToken: n.token,
      sshLocal: n.local,
    });
  }

  if (nodes.length === 0) {
    throw new Error(
      `${p} 里没有任何节点带 browser 段。\n` +
        `browser-hub 至少要有一台机器铺好 playwright daemon（见 docs/browser-hub.md 第十节）。`
    );
  }

  const routes = raw.browserRoutes ?? [];
  // 路由指向不存在的节点属于配置写错，启动时就说清楚，别等到 navigate 时才报
  const known = new Set(nodes.map((n) => n.name));
  for (const r of routes) {
    if (!known.has(r.node)) {
      throw new Error(`browserRoutes 里的 node '${r.node}' 不是一个带 browser 段的节点`);
    }
    if (r.fallback && !known.has(r.fallback)) {
      throw new Error(`browserRoutes 里的 fallback '${r.fallback}' 不是一个带 browser 段的节点`);
    }
  }

  return { nodes, routes };
}

/**
 * 一个 host 模式是否命中 hostname。支持的写法只有通配符 `*`：
 * - `*.17u.cn` 命中 wiki.17u.cn，也命中裸域 17u.cn（写规则的人几乎总是这个意思）
 * - `192.168.31.*` 命中 192.168.31.50
 * - `*` 命中一切（兜底那条）
 */
export function hostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat === "*") return true;

  const toRegExp = (s: string): RegExp =>
    new RegExp("^" + s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

  if (toRegExp(pat).test(host)) return true;
  // `*.example.com` 额外允许裸域
  if (pat.startsWith("*.") && host === pat.slice(2)) return true;
  return false;
}

/**
 * 按 URL 找该去哪台机器。返回 undefined 表示没有任何规则命中
 * （调用方应当报"没有路由规则命中，显式指定 node"，而不是随便挑一台）。
 */
export function routeFor(
  url: string,
  routes: BrowserRoute[]
): { node: string; fallback?: string; matched: string } | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined; // about:blank / data: 这类没有 host，交给当前节点处理
  }
  if (!hostname) return undefined;

  for (const r of routes) {
    for (const m of r.match) {
      if (hostMatches(m, hostname)) {
        return { node: r.node, fallback: r.fallback, matched: m };
      }
    }
  }
  return undefined;
}
