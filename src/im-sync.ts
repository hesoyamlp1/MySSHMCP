import { ImConfig, ImChat, monitoredChats, saveImConfig, loadImConfig } from "./im-config.js";
import { ImStore } from "./im-store.js";
import { fetchChatMessages, listChats, whoami } from "./im-feishu.js";

/**
 * 采集一轮：对每个监控中的会话，拉水位之后的新消息，入库，更新水位。
 *
 * 这一步一次模型调用都不做。判断"这算不算给我提的需求"需要上下文
 * （这个群平时聊什么、这个人和我什么关系），采集时没有；留给读的人判。
 */

export interface SyncChatResult {
  chatId: string;
  name: string;
  fetched: number;   // 拉到多少条（含重复）
  inserted: number;  // 真正新增
  atMe: number;      // 其中 @ 我的
  error?: string;
  ms: number;
}

export interface SyncResult {
  startedAt: number;
  ms: number;
  chats: SyncChatResult[];
  totalInserted: number;
  totalAtMe: number;
  newChats: string[];   // 这轮新发现并纳入监控的会话
  pruned: number;
  errors: number;
}

export async function syncOnce(
  cfg: ImConfig,
  store: ImStore,
  opts: { discover?: boolean; initialHours?: number; only?: string[] } = {}
): Promise<SyncResult> {
  const t0 = Date.now();
  const newChats: string[] = [];

  // 先发现新会话：别人新拉你进群、新来的私聊，不发现就永远收不到
  if (opts.discover !== false) {
    try {
      const remote = await listChats(cfg);
      const known = new Set(cfg.chats.map((c) => c.chatId));
      let changed = false;
      for (const r of remote) {
        const exist = cfg.chats.find((c) => c.chatId === r.chatId);
        if (exist) {
          if (exist.name !== r.name) { exist.name = r.name; changed = true; }  // 群改名了
          continue;
        }
        if (known.has(r.chatId)) continue;
        // 新会话：群默认不自动监控（可能是被拉进的通知群），
        // 真人单聊按配置自动纳入——那是需求最常来的地方
        const isBotP2P = r.mode === "p2p" && r.targetType && r.targetType !== "user";
        const auto = r.mode === "p2p" && cfg.autoAddP2P && !isBotP2P;
        cfg.chats.push({
          chatId: r.chatId,
          name: r.name,
          mode: r.mode,
          monitored: auto,
          note: auto ? "新出现的单聊，自动纳入" : (isBotP2P ? "机器人单聊" : "新出现的群，默认不采；要收自己打开"),
        });
        changed = true;
        if (auto) newChats.push(r.name);
      }
      if (changed) saveImConfig(cfg);
    } catch (e) {
      // 发现失败不该拖垮整轮采集
      newChats.push(`(发现会话失败: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  let targets = monitoredChats(cfg);
  if (opts.only?.length) {
    const want = new Set(opts.only);
    targets = targets.filter((c) => want.has(c.chatId) || want.has(c.name));
  }

  const results: SyncChatResult[] = [];
  for (const chat of targets) {
    const ct = Date.now();
    const wm = store.getWatermark(chat.chatId);
    try {
      const r = await fetchChatMessages(cfg, chat, wm?.lastTime ?? 0, {
        initialHours: opts.initialHours,
      });
      const inserted = store.insertMessages(r.messages);
      const atMe = r.messages.filter((m) => m.atMe && !m.isMine).length;
      store.setWatermark({
        chatId: chat.chatId,
        lastTime: Math.max(r.lastTime, wm?.lastTime ?? 0),
        lastMessageId: r.lastMessageId || (wm?.lastMessageId ?? ""),
        lastSyncAt: Date.now(),
        error: undefined,
      });
      results.push({
        chatId: chat.chatId, name: chat.name,
        fetched: r.messages.length, inserted, atMe, ms: Date.now() - ct,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 单个会话失败不影响别的；错误记进水位，im_status 能看出连续失败
      store.setWatermark({
        chatId: chat.chatId,
        lastTime: wm?.lastTime ?? 0,
        lastMessageId: wm?.lastMessageId ?? "",
        lastSyncAt: Date.now(),
        error: msg.slice(0, 300),
      });
      results.push({
        chatId: chat.chatId, name: chat.name,
        fetched: 0, inserted: 0, atMe: 0, error: msg.slice(0, 300), ms: Date.now() - ct,
      });
    }
  }

  const pruned = store.prune(cfg.retentionDays);

  return {
    startedAt: t0,
    ms: Date.now() - t0,
    chats: results,
    totalInserted: results.reduce((s, r) => s + r.inserted, 0),
    totalAtMe: results.reduce((s, r) => s + r.atMe, 0),
    newChats,
    pruned,
    errors: results.filter((r) => r.error).length,
  };
}

/**
 * 第一次用：把会话拉下来生成配置。
 * 近期有真人说话的默认开启监控，纯机器人通知群默认关闭——
 * 那些群里没有人跟你说话，收进来只会把真正的需求淹掉。
 */
export async function initConfig(profile: string, opts: { probeHours?: number } = {}): Promise<{
  path: string; total: number; monitored: number; me: string;
}> {
  const me = await whoami(profile);
  const base: ImConfig = {
    profile,
    meOpenId: me.openId,
    meName: me.name,
    intervalMinutes: 10,
    retentionDays: 90,
    dbPath: "",
    autoAddP2P: true,
    chats: [],
  };
  // dbPath 走默认值
  const { defaultConfigPath } = await import("./im-config.js");
  const { join, dirname } = await import("node:path");
  base.dbPath = join(dirname(defaultConfigPath()), "feishu.db");

  const remote = await listChats(base);
  const hours = opts.probeHours ?? 168;   // 探最近 7 天，判断哪些会话有真人在说话
  const since = Date.now() - hours * 3600_000;

  for (const r of remote) {
    const chat: ImChat = { chatId: r.chatId, name: r.name, mode: r.mode, monitored: false };
    if (r.mode === "p2p" && r.targetType && r.targetType !== "user") {
      chat.note = "机器人单聊";
      base.chats.push(chat);
      continue;
    }
    try {
      const probe = await fetchChatMessages(base, chat, since, { pageSize: 50 });
      const humans = probe.messages.filter((m) => !m.isMine && m.senderId.startsWith("ou_")).length;
      chat.monitored = humans > 0;
      chat.note = humans > 0 ? `近 ${Math.round(hours / 24)} 天有 ${humans} 条真人发言` : "近期没有真人说话";
    } catch (e) {
      chat.note = `探测失败: ${e instanceof Error ? e.message.slice(0, 80) : ""}`;
    }
    base.chats.push(chat);
  }

  const path = saveImConfig(base);
  return {
    path,
    total: base.chats.length,
    monitored: base.chats.filter((c) => c.monitored).length,
    me: `${me.name} (${me.openId})`,
  };
}

/** 给 CLI 用：跑一轮并打印人能读的报告 */
export async function runSyncCLI(argv: string[]): Promise<number> {
  const quiet = argv.includes("--quiet");
  const cfg = loadImConfig();
  const store = new ImStore(cfg.dbPath);
  try {
    const r = await syncOnce(cfg, store);
    if (!quiet || r.errors > 0) {
      const lines = [`采集完成 ${(r.ms / 1000).toFixed(1)}s：新增 ${r.totalInserted} 条，其中 @我 ${r.totalAtMe} 条`];
      for (const c of r.chats) {
        if (c.error) lines.push(`  ✗ ${c.name}: ${c.error}`);
        else if (c.inserted) lines.push(`  ${c.name}: +${c.inserted}${c.atMe ? `（@我 ${c.atMe}）` : ""}`);
      }
      if (r.newChats.length) lines.push(`  新会话: ${r.newChats.join("、")}`);
      if (r.pruned) lines.push(`  清理过期: ${r.pruned} 条`);
      console.log(lines.join("\n"));
    }
    return r.errors > 0 ? 1 : 0;
  } finally {
    store.close();
  }
}
