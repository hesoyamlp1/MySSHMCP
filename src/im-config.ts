import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * im-hub 的配置：监控哪些会话、多久采一次、消息留多久。
 *
 * 和另外三个 hub 不同，这份不寄生在 hub.json 里——那份讲的是"有哪些机器"，
 * 这里讲的是"听哪些人说话"，两件事没关系。放 ~/.mori/im/config.json。
 */

/** 一个被监控的会话 */
export interface ImChat {
  /** 飞书的 oc_xxx */
  chatId: string;
  /** 会话名，只为人看；飞书那边改名了这里不会自动跟着变，采集时会刷新 */
  name: string;
  /** group=群聊 p2p=单聊 */
  mode: "group" | "p2p";
  /** false=暂时不采，配置留着 */
  monitored: boolean;
  /** 备注，比如"纯机器人通知群，不收" */
  note?: string;
}

export interface ImConfig {
  /** lark-cli 的 profile 名，决定用哪个飞书应用和谁的身份 */
  profile: string;
  /** 我是谁：判断"这条是不是 @ 我"和"这条是不是我自己发的"要用 */
  meOpenId: string;
  meName: string;
  /** 采集间隔（分钟），只是记在这里给定时任务参考，进程自己不定时 */
  intervalMinutes: number;
  /** 消息留多久（天），0=不清理 */
  retentionDays: number;
  /** 库文件路径 */
  dbPath: string;
  /** 单聊：新出现的真人单聊自动纳入监控 */
  autoAddP2P: boolean;
  chats: ImChat[];
}

function defaultDir(): string {
  return join(homedir(), ".mori", "im");
}

export function defaultConfigPath(): string {
  return join(defaultDir(), "config.json");
}

const DEFAULTS: Omit<ImConfig, "chats"> = {
  profile: "mori",
  meOpenId: "",
  meName: "",
  intervalMinutes: 10,
  retentionDays: 90,
  dbPath: join(defaultDir(), "feishu.db"),
  autoAddP2P: true,
};

export function loadImConfig(path?: string): ImConfig {
  const p = path || process.env.IM_HUB_CONFIG || defaultConfigPath();
  if (!existsSync(p)) {
    throw new Error(
      `im-hub 配置不存在: ${p}\n` +
        `跑一次 \`mcp-ssh-pty --im-init\` 生成它：会用当前 lark-cli 的身份把你所在的会话拉下来，\n` +
        `近期有真人说话的默认开启监控，纯机器人通知群默认关闭。`
    );
  }
  let raw: Partial<ImConfig>;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    throw new Error(`im-hub 配置解析失败: ${p}\n${e instanceof Error ? e.message : String(e)}`);
  }
  const cfg: ImConfig = { ...DEFAULTS, ...raw, chats: raw.chats ?? [] };
  if (!cfg.meOpenId) {
    throw new Error(`im-hub 配置里缺 meOpenId（判断 @我 要用）: ${p}`);
  }
  return cfg;
}

export function saveImConfig(cfg: ImConfig, path?: string): string {
  const p = path || process.env.IM_HUB_CONFIG || defaultConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return p;
}

/** 当前在监控的会话 */
export function monitoredChats(cfg: ImConfig): ImChat[] {
  return cfg.chats.filter((c) => c.monitored);
}

/** 按名字或 id 找一个会话；名字允许部分匹配，多个命中时报错让调用方说清楚 */
export function findChat(cfg: ImConfig, key: string): ImChat {
  const byId = cfg.chats.find((c) => c.chatId === key);
  if (byId) return byId;
  const exact = cfg.chats.filter((c) => c.name === key);
  if (exact.length === 1) return exact[0];
  const fuzzy = cfg.chats.filter((c) => c.name.includes(key));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length === 0) {
    throw new Error(
      `没有叫 '${key}' 的会话。现有：${cfg.chats.filter((c) => c.monitored).map((c) => c.name).join("、")}`
    );
  }
  throw new Error(`'${key}' 对上了好几个：${fuzzy.map((c) => c.name).join("、")}，说全一点`);
}
