import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import { ImConfig, loadImConfig, saveImConfig, findChat, monitoredChats } from "./im-config.js";
import { ImStore, ImMessage } from "./im-store.js";
import { syncOnce } from "./im-sync.js";
import { downloadResource, extractImageKeys } from "./im-feishu.js";

/**
 * im-hub：读飞书消息的 MCP 服务。
 *
 * 工具面刻意只有四个。判断"哪条是给我提的需求"不在这里做——
 * 那需要上下文（这个群平时聊什么、这个人和我什么关系），
 * 由读的人当场判，判错了可以重判，原始消息不会变。
 *
 * 一条消息有三个互不相干的状态，别混在一起：
 *   收没收到 —— 采集器的事
 *   我看没看过 —— seen 游标，这里管
 *   用户知不知道 —— 我说了他才知道，跟飞书那边的已读无关
 * 飞书自己的已读状态一概不碰，那是用户的私事。
 */

const SEEN = "inbox";  // 游标名

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay) return hm;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 一条消息渲染成一行，图片折成 [图N]，正文太长就截断 */
function fmtMessage(m: ImMessage, opts: { chat?: boolean; maxLen?: number } = {}): string {
  const max = opts.maxLen ?? 180;
  let body = m.content.replace(/\s*\n\s*/g, " ").trim();
  const keys = extractImageKeys(m.content);
  if (keys.length) {
    body = body.replace(/!\[Image\]\(img_[\w-]+\)/g, "").replace(/\[Image:\s*img_[\w-]+\]/g, "").trim();
    body = (body || "(只有图)") + ` [${keys.length} 张图]`;
  }
  if (body.length > max) body = body.slice(0, max) + "…";
  const who = m.isMine ? "我" : m.senderName;
  const at = m.atMe && !m.isMine ? " ★@我" : "";
  return `${fmtTime(m.createTime)} ${opts.chat ? `[${m.chatName}] ` : ""}${who}${at}: ${body}`;
}

interface Ctx {
  cfg: ImConfig;
  store: ImStore;
}

function openCtx(): Ctx {
  const cfg = loadImConfig();
  return { cfg, store: new ImStore(cfg.dbPath) };
}

/** 每次调用开一次库、用完就关：MCP 是低频调用，省得长持有句柄和 WAL 锁 */
async function withCtx<T>(fn: (c: Ctx) => Promise<T> | T): Promise<T> {
  const c = openCtx();
  try {
    return await fn(c);
  } finally {
    c.store.close();
  }
}

export function buildImHubServer(): McpServer {
  const server = new McpServer(
    { name: "im-hub", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── 1. 最常用的那个：有什么新的 ────────────────────────────────
  server.tool(
    "im_inbox",
    "看飞书里有什么新消息。不带参数只给各会话的条数概览（很省），带 chat 才展开那个会话的正文，带 at_me 直接给 @ 你的那几条。默认排除你自己发的和机器人发的。看完带 mark_seen 把游标推到最新，否则下次还是同一批。",
    {
      chat: z.string().optional().describe("只看这个会话（名字或 chat_id），给出正文"),
      at_me: z.boolean().optional().describe("只要 @ 我的，直接给正文不给概览"),
      since: z.string().optional().describe("从什么时候起，如 '2026-09-08 10:00' 或 '3h' / '2d'；不给就从上次 mark_seen 的位置"),
      include_bots: z.boolean().optional().describe("把机器人发的也算进来，默认不算"),
      limit: z.number().optional().describe("最多给几条正文，默认 40"),
      mark_seen: z.boolean().optional().describe("把游标推到最新，表示这批我看过了"),
    },
    async ({ chat, at_me, since, include_bots, limit, mark_seen }) => {
      return withCtx(({ cfg, store }) => {
        const from = parseSince(since) ?? store.getCursor(SEEN) ?? Date.now() - 24 * 3600_000;
        const base = {
          since: from,
          excludeMine: true,
          excludeBots: !include_bots,
          limit: limit ?? 40,
        };

        let out: string[];
        let newest = from;

        if (chat) {
          const c = findChat(cfg, chat);
          const ms = store.query({ ...base, chatIds: [c.chatId], order: "asc" });
          newest = ms.length ? ms[ms.length - 1].createTime : from;
          out = [`${c.name}，${fmtTime(from)} 之后 ${ms.length} 条：`, ...ms.map((m) => "  " + fmtMessage(m))];
          if (!ms.length) out = [`${c.name}：${fmtTime(from)} 之后没有新消息`];
        } else if (at_me) {
          const ms = store.query({ ...base, atMeOnly: true, order: "asc" });
          newest = ms.length ? ms[ms.length - 1].createTime : from;
          out = ms.length
            ? [`${fmtTime(from)} 之后有 ${ms.length} 条 @ 你：`, ...ms.map((m) => "  " + fmtMessage(m, { chat: true }))]
            : [`${fmtTime(from)} 之后没人 @ 你`];
        } else {
          const rows = store.countByChat(from, { excludeMine: true });
          const total = rows.reduce((s, r) => s + r.total, 0);
          const atMe = rows.reduce((s, r) => s + r.atMe, 0);
          newest = rows.reduce((s, r) => Math.max(s, r.lastTime), from);
          if (!rows.length) {
            out = [`${fmtTime(from)} 之后没有新消息`];
          } else {
            out = [
              `${fmtTime(from)} 之后共 ${total} 条${atMe ? `，其中 ${atMe} 条 @ 你` : ""}：`,
              ...rows.map((r) =>
                `  ${r.chatName.padEnd(20)} ${String(r.total).padStart(3)} 条` +
                (r.atMe ? `  ★${r.atMe} 条 @你` : "") +
                `  最新 ${fmtTime(r.lastTime)}`
              ),
              "",
              "要看正文：im_inbox 带 chat='会话名'，或带 at_me=true 只看 @ 你的",
            ];
          }
        }

        if (mark_seen && newest > from) {
          store.setCursor(SEEN, newest);
          out.push(`（游标已推到 ${fmtTime(newest)}）`);
        }
        return { content: [{ type: "text" as const, text: out.join("\n") }] };
      });
    }
  );

  // ── 2. 翻旧的 ─────────────────────────────────────────────────
  server.tool(
    "im_search",
    "在已经收下来的飞书消息里搜。按关键词、按谁说的、按哪个会话、按时间段都行，本地库里搜不打飞书接口。",
    {
      query: z.string().optional().describe("正文里包含的关键词"),
      sender: z.string().optional().describe("谁说的，名字的一部分即可"),
      chat: z.string().optional().describe("限定会话"),
      since: z.string().optional().describe("从什么时候起，如 '7d' / '2026-09-01'"),
      until: z.string().optional().describe("到什么时候为止"),
      at_me: z.boolean().optional().describe("只要 @ 我的"),
      include_mine: z.boolean().optional().describe("把我自己发的也算进来，默认不算"),
      limit: z.number().optional().describe("最多几条，默认 30"),
    },
    async (a) => {
      return withCtx(({ cfg, store }) => {
        const chatIds = a.chat ? [findChat(cfg, a.chat).chatId] : undefined;
        const ms = store.query({
          chatIds,
          text: a.query,
          sender: a.sender,
          since: parseSince(a.since),
          until: parseSince(a.until),
          atMeOnly: a.at_me,
          excludeMine: !a.include_mine,
          limit: a.limit ?? 30,
          order: "desc",
        });
        const text = ms.length
          ? `${ms.length} 条：\n` + ms.map((m) => "  " + fmtMessage(m, { chat: true, maxLen: 220 })).join("\n")
          : "没搜到。库里只有采集之后的消息，更早的要去飞书原生搜。";
        return { content: [{ type: "text" as const, text }] };
      });
    }
  );

  // ── 3. 看消息里的图 ────────────────────────────────────────────
  server.tool(
    "im_file",
    "把某条消息里的图片下到本地，返回路径，之后用 Read 看。很多需求是「一张截图 + 一句话」，光看文字判断不了。",
    {
      message_id: z.string().describe("消息 id（om_ 开头），im_inbox / im_search 的结果里没直接给，用 keyword 找或看 raw"),
      image_key: z.string().optional().describe("图片 key（img_ 开头）；不给就下这条消息里的第一张"),
      all: z.boolean().optional().describe("这条消息里的图全下"),
    },
    async ({ message_id, image_key, all }) => {
      const c = openCtx();
      try {
        const rows = c.store.query({ limit: 1000, order: "desc" });
        const m = rows.find((x) => x.messageId === message_id);
        let keys = image_key ? [image_key] : m ? extractImageKeys(m.content) : [];
        if (!keys.length) {
          return { content: [{ type: "text" as const, text: `消息 ${message_id} 里没找到图片。` }] };
        }
        if (!all) keys = keys.slice(0, 1);
        const dir = join(homedir(), ".mori", "im", "files");
        const done: string[] = [];
        for (const k of keys) {
          const out = join(dir, `${k}.jpg`);
          const r = await downloadResource(c.cfg, message_id, k, out);
          done.push(`${r.path}（${(r.bytes / 1024).toFixed(0)} KB）`);
        }
        return {
          content: [{
            type: "text" as const,
            text: `下好了，用 Read 看：\n` + done.map((d) => "  " + d).join("\n"),
          }],
        };
      } finally {
        c.store.close();
      }
    }
  );

  // ── 4. 状态和管理 ──────────────────────────────────────────────
  server.tool(
    "im_status",
    "采集在不在正常跑：每个会话上次同步到什么时候、有没有连续失败、库里有多少条。也能开关某个会话的监控，或者手动采一轮。",
    {
      sync: z.boolean().optional().describe("立刻采一轮（平时靠定时任务，这个是手动补一次）"),
      watch: z.string().optional().describe("把这个会话加入监控"),
      unwatch: z.string().optional().describe("把这个会话移出监控"),
      all_chats: z.boolean().optional().describe("连没在监控的会话一起列出来"),
    },
    async ({ sync, watch, unwatch, all_chats }) => {
      const c = openCtx();
      try {
        const lines: string[] = [];

        if (watch || unwatch) {
          const target = findChat(c.cfg, (watch ?? unwatch)!);
          target.monitored = !!watch;
          saveImConfig(c.cfg);
          lines.push(`${target.name} 已${watch ? "加入" : "移出"}监控`);
        }

        if (sync) {
          const r = await syncOnce(c.cfg, c.store);
          lines.push(`采集 ${(r.ms / 1000).toFixed(1)}s：新增 ${r.totalInserted} 条，@我 ${r.totalAtMe} 条${r.errors ? `，失败 ${r.errors} 个会话` : ""}`);
          for (const x of r.chats.filter((x) => x.error || x.inserted)) {
            lines.push(x.error ? `  ✗ ${x.name}: ${x.error}` : `  ${x.name}: +${x.inserted}`);
          }
          if (r.newChats.length) lines.push(`  新会话: ${r.newChats.join("、")}`);
        }

        const s = c.store.stats();
        const wms = new Map(c.store.allWatermarks().map((w) => [w.chatId, w]));
        const now = Date.now();
        lines.push(
          "",
          `库：${s.messages} 条 / ${s.chats} 个会话 / ${(s.sizeBytes / 1048576).toFixed(1)} MB` +
          (s.oldest ? `，最早 ${fmtTime(s.oldest)}` : ""),
          `配置：每 ${c.cfg.intervalMinutes} 分钟采一轮，留 ${c.cfg.retentionDays} 天`,
          ""
        );

        const list = all_chats ? c.cfg.chats : monitoredChats(c.cfg);
        lines.push(`会话（${monitoredChats(c.cfg).length} 个在监控${all_chats ? `，共 ${c.cfg.chats.length} 个` : ""}）：`);
        for (const ch of list) {
          const w = wms.get(ch.chatId);
          const age = w?.lastSyncAt ? `${Math.round((now - w.lastSyncAt) / 60000)} 分钟前` : "还没采过";
          const flag = ch.monitored ? " " : "×";
          lines.push(`  ${flag} ${ch.name.padEnd(22)} 上次同步 ${age}${w?.error ? `  ✗ ${w.error.slice(0, 60)}` : ""}`);
        }

        const cur = c.store.getCursor(SEEN);
        lines.push("", cur ? `我看到 ${fmtTime(cur)} 为止（这是我的位置，跟你在飞书里已读没读无关）` : "还没标记过看到哪");

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } finally {
        c.store.close();
      }
    }
  );

  return server;
}

/** '3h' / '2d' / '2026-09-08' / '2026-09-08 10:00' → 毫秒 */
function parseSince(s?: string): number | undefined {
  if (!s) return undefined;
  const rel = /^(\d+)([hdm])$/.exec(s.trim());
  if (rel) {
    const n = +rel[1];
    const mult = rel[2] === "h" ? 3600_000 : rel[2] === "d" ? 86400_000 : 60_000;
    return Date.now() - n * mult;
  }
  const t = Date.parse(s.replace(" ", "T"));
  if (!Number.isNaN(t)) return t;
  throw new Error(`看不懂的时间: ${s}（试试 '3h'、'2d' 或 '2026-09-08 10:00'）`);
}
