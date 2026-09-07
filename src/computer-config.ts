import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * computer-hub 的配置寄生在 ssh-hub 的 hub.json 里，跟 browser-hub 同一个套路：
 * 节点带 computer 段的就是一台能做桌面操作的机器。节点定义（名字、ssh daemon 的
 * url/token）只写一份，三个 hub 共用。
 */

/** 一台机器上的 codex app-server 规格 */
export interface ComputerSpec {
  /**
   * 上游 app-server 的 websocket 端点，经反向隧道落在 VPS 的某个端口
   * （mac-mini-2 = 27786，以后每台机器一个不同端口）。
   * app-server 自己只 bind loopback，官方启动日志里就写着要用 SSH 端口转发。
   */
  url: string;
  /**
   * 这台机器上桌面操作走哪条路。两条路的 API 完全不同，是上游插件决定的，不是我们的选择：
   * - mac：thread 里开 computer-use（10 个离散工具）+ unified-computer-use（cua_repl 的 js）。
   * - windows：unified 插件把 CUA_REPL_ENABLED_SURFACES 写死成 browser，桌面那半只能走
   *   node_repl 的 js + `@oai/sky`（窗口级寻址，方法名和 mac 的 cua.* 不一样）。
   */
  platform: "mac" | "windows";
  /** 拉起 app-server 的命令（daemon 挂了时用）；不配就是常驻、不需要拉 */
  up?: string;
  /** 停掉 app-server 的命令 */
  down?: string;
  /**
   * 在哪个 ssh node 上执行 up/down，默认就是本节点自己。
   * 没有自己 ssh daemon 的机器填提供通路的那个 node。
   */
  via?: string;
  /** 目标 ssh node 下的 server 名，默认 "local"（= 那台机器本机） */
  server?: string;
  /**
   * 授权请求（"Allow ChatGPT to use X?"）怎么答。桌面操作的每个动作都可能触发它。
   * - "low"（默认）：上游标了 riskLevel=low 的自动同意，其它一律拒绝并把原文回给模型。
   * - "never"：一律拒绝，把请求原文回给模型，让它转述给用户。
   * - "always"：一律同意。只在明确知道这台机器只跑受控 app 时才用。
   * 不管选哪个，同意过什么都会写进工具结果的说明里，不闷声放行。
   */
  approve?: "low" | "never" | "always";
  /** 这台机器的屏幕上有没有人在看（有头一定为真——桌面操作本来就是操作真实屏幕） */
  note?: string;
}

/** 一个 computer 节点 = 一台机器的 app-server + 怎么在那台机器上执行命令 */
export interface ComputerNode {
  name: string;
  computer: ComputerSpec;
  /** 该机器 ssh daemon 的端点（跑 up/down 命令要用它）；hub 本机节点没有 url */
  sshUrl?: string;
  sshToken?: string;
  sshLocal?: boolean;
}

export interface ComputerHubConfig {
  nodes: ComputerNode[];
}

/** hub.json 里节点的原始形状（只取 computer-hub 关心的字段） */
interface RawNode {
  name?: string;
  url?: string;
  token?: string;
  local?: boolean;
  computer?: ComputerSpec;
}

interface RawConfig {
  nodes?: RawNode[];
  /**
   * 只提供桌面操作、不提供 ssh daemon 的机器放这里（不能塞进 nodes——ssh-hub 要求
   * nodes 的每一项有 local 或 url）。这类机器靠 computer.via 借别人的通路执行 up/down。
   */
  computerNodes?: RawNode[];
}

function defaultHubPath(): string {
  return join(homedir(), ".mori", "ssh", "hub.json");
}

/**
 * 加载 computer-hub 配置。路径优先级跟 ssh-hub 一致：
 * 显式 path > SSH_MCP_HUB_CONFIG > ~/.mori/ssh/hub.json
 *
 * 只有带 computer 段的节点会被收进来——哪台铺好了就有哪台。
 */
export function loadComputerConfig(path?: string): ComputerHubConfig {
  const p = path || process.env.SSH_MCP_HUB_CONFIG || defaultHubPath();
  if (!existsSync(p)) {
    throw new Error(
      `hub 配置不存在: ${p}\n` +
        `computer-hub 读的是 ssh-hub 那份 hub.json，需要至少一个节点带 computer 段，形如\n` +
        `{ "nodes": [ { "name": "mac-mini-2", "url": "...", "token": "...", ` +
        `"computer": { "url": "ws://127.0.0.1:27786", "platform": "mac" } } ] }`
    );
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    throw new Error(`hub 配置 JSON 解析失败: ${p}\n${e instanceof Error ? e.message : String(e)}`);
  }

  const nodes: ComputerNode[] = [];
  const take = (n: RawNode, from: string): void => {
    if (!n.computer) return; // 没铺桌面操作的机器直接跳过，不是错误
    if (!n.name) throw new Error(`${from} 里有条目缺少 name: ${JSON.stringify(n)}`);
    if (!n.computer.url) {
      throw new Error(`节点 '${n.name}' 的 computer 段缺少 url（上游 app-server 的 ws 端点）`);
    }
    if (!n.computer.url.startsWith("ws://") && !n.computer.url.startsWith("wss://")) {
      throw new Error(
        `节点 '${n.name}' 的 computer.url 要是 websocket 地址（ws:// 开头），现在是 '${n.computer.url}'`
      );
    }
    if (n.computer.platform !== "mac" && n.computer.platform !== "windows") {
      throw new Error(
        `节点 '${n.name}' 的 computer.platform 只能是 "mac" 或 "windows"（两边上游 API 不同），` +
          `现在是 '${String(n.computer.platform)}'`
      );
    }
    const ap = n.computer.approve;
    if (ap !== undefined && ap !== "low" && ap !== "never" && ap !== "always") {
      throw new Error(`节点 '${n.name}' 的 computer.approve 只能是 "low" / "never" / "always"`);
    }
    if (nodes.some((x) => x.name === n.name)) {
      throw new Error(`节点 '${n.name}' 在 nodes 和 computerNodes 里都有，去掉一处`);
    }
    nodes.push({
      name: n.name,
      computer: n.computer,
      sshUrl: n.url,
      sshToken: n.token,
      sshLocal: n.local,
    });
  };

  for (const n of raw.nodes ?? []) take(n, "nodes");
  for (const n of raw.computerNodes ?? []) take(n, "computerNodes");

  for (const n of nodes) {
    if (!n.computer.up) continue; // 不配 up 的机器（app-server 常驻）不需要执行通路
    const via = n.computer.via;
    if (!via && !n.sshUrl && !n.sshLocal) {
      throw new Error(
        `节点 '${n.name}' 配了 up 命令，但它既没有自己的 ssh 端点（url），也没写 computer.via。\n` +
          `没有自己 ssh daemon 的机器要指明借谁的通路，例如 "via": "vps", "server": "${n.name}"。`
      );
    }
  }

  if (nodes.length === 0) {
    throw new Error(
      `${p} 里没有任何节点带 computer 段。\n` +
        `computer-hub 至少要有一台机器铺好 codex app-server（见 docs/computer-hub.md）。`
    );
  }

  return { nodes };
}
