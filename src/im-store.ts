import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * im-hub 的本地库：原封不动地存消息，判断留给读的人。
 *
 * 为什么不在写入时判断"这算不算给我提的需求"：采集要能长期无人值守地跑，
 * 掺进模型调用就有成本、有失败模式、有判错；而判断需要上下文（这个群平时在聊什么、
 * 这个人和我什么关系），采集时没有。判错了可以重判，原始消息在那不会变。
 */

export interface ImMessage {
  messageId: string;
  chatId: string;
  chatName: string;
  senderId: string;
  senderName: string;
  /** 毫秒时间戳 */
  createTime: number;
  msgType: string;
  /** 已渲染成人能读的正文 */
  content: string;
  /** @ 了谁（open_id），JSON 数组 */
  mentions: string[];
  atMe: boolean;
  isMine: boolean;
  threadId?: string;
  parentId?: string;
  /** lark-cli 返回的原始 JSON，留着以防解析漏了字段 */
  raw?: string;
}

export interface Watermark {
  chatId: string;
  lastTime: number;
  lastMessageId: string;
  lastSyncAt: number;
  error?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id  TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  chat_name   TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  create_time INTEGER NOT NULL,
  msg_type    TEXT NOT NULL,
  content     TEXT NOT NULL,
  mentions    TEXT NOT NULL DEFAULT '[]',
  at_me       INTEGER NOT NULL DEFAULT 0,
  is_mine     INTEGER NOT NULL DEFAULT 0,
  thread_id   TEXT,
  parent_id   TEXT,
  raw         TEXT
);
-- 三个最常用的读法：按会话翻、按时间翻、只看 @我 的
CREATE INDEX IF NOT EXISTS idx_msg_chat_time ON messages(chat_id, create_time DESC);
CREATE INDEX IF NOT EXISTS idx_msg_time      ON messages(create_time DESC);
CREATE INDEX IF NOT EXISTS idx_msg_atme      ON messages(at_me, create_time DESC) WHERE at_me = 1;

CREATE TABLE IF NOT EXISTS watermarks (
  chat_id         TEXT PRIMARY KEY,
  last_time       INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT NOT NULL DEFAULT '',
  last_sync_at    INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);

-- 上次问到哪了：im_inbox 不带 since 时从这里接着往下给
CREATE TABLE IF NOT EXISTS cursors (
  name      TEXT PRIMARY KEY,
  at_time   INTEGER NOT NULL,
  update_at INTEGER NOT NULL
);
`;

export class ImStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 批量写消息。message_id 撞了就跳过——飞书的分页边界会重复给同一条，
   * 而且重跑采集必须是安全的。返回真正新增的条数。
   */
  insertMessages(msgs: ImMessage[]): number {
    if (msgs.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (message_id, chat_id, chat_name, sender_id, sender_name, create_time,
         msg_type, content, mentions, at_me, is_mine, thread_id, parent_id, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const m of msgs) {
        const r = stmt.run(
          m.messageId, m.chatId, m.chatName, m.senderId, m.senderName, m.createTime,
          m.msgType, m.content, JSON.stringify(m.mentions),
          m.atMe ? 1 : 0, m.isMine ? 1 : 0,
          m.threadId ?? null, m.parentId ?? null, m.raw ?? null
        );
        n += Number(r.changes);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  getWatermark(chatId: string): Watermark | undefined {
    const r = this.db.prepare("SELECT * FROM watermarks WHERE chat_id = ?").get(chatId) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      chatId: r.chat_id as string,
      lastTime: Number(r.last_time),
      lastMessageId: r.last_message_id as string,
      lastSyncAt: Number(r.last_sync_at),
      error: (r.error as string) || undefined,
    };
  }

  setWatermark(w: Watermark): void {
    this.db
      .prepare(`
        INSERT INTO watermarks (chat_id, last_time, last_message_id, last_sync_at, error)
        VALUES (?,?,?,?,?)
        ON CONFLICT(chat_id) DO UPDATE SET
          last_time = excluded.last_time,
          last_message_id = excluded.last_message_id,
          last_sync_at = excluded.last_sync_at,
          error = excluded.error
      `)
      .run(w.chatId, w.lastTime, w.lastMessageId, w.lastSyncAt, w.error ?? null);
  }

  allWatermarks(): Watermark[] {
    const rows = this.db.prepare("SELECT * FROM watermarks").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      chatId: r.chat_id as string,
      lastTime: Number(r.last_time),
      lastMessageId: r.last_message_id as string,
      lastSyncAt: Number(r.last_sync_at),
      error: (r.error as string) || undefined,
    }));
  }

  getCursor(name: string): number | undefined {
    const r = this.db.prepare("SELECT at_time FROM cursors WHERE name = ?").get(name) as
      | { at_time: number }
      | undefined;
    return r ? Number(r.at_time) : undefined;
  }

  setCursor(name: string, atTime: number): void {
    this.db
      .prepare(`
        INSERT INTO cursors (name, at_time, update_at) VALUES (?,?,?)
        ON CONFLICT(name) DO UPDATE SET at_time = excluded.at_time, update_at = excluded.update_at
      `)
      .run(name, atTime, Date.now());
  }

  /** 查消息。全部条件都是可选的，组合起来用 */
  query(opts: {
    chatIds?: string[];
    since?: number;
    until?: number;
    atMeOnly?: boolean;
    excludeMine?: boolean;
    excludeBots?: boolean;
    sender?: string;
    text?: string;
    limit?: number;
    order?: "asc" | "desc";
  }): ImMessage[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.chatIds?.length) {
      where.push(`chat_id IN (${opts.chatIds.map(() => "?").join(",")})`);
      args.push(...opts.chatIds);
    }
    if (opts.since !== undefined) { where.push("create_time > ?"); args.push(opts.since); }
    if (opts.until !== undefined) { where.push("create_time <= ?"); args.push(opts.until); }
    if (opts.atMeOnly) where.push("at_me = 1");
    if (opts.excludeMine) where.push("is_mine = 0");
    // 机器人发的：飞书给的 sender_id 以 cli_ 开头，或者 ou_ 但 sender_type 是 bot
    // （采集时已经把 bot 的 sender_name 保留原样，这里按 id 前缀判）
    if (opts.excludeBots) where.push("sender_id NOT LIKE 'cli_%'");
    if (opts.sender) { where.push("sender_name LIKE ?"); args.push(`%${opts.sender}%`); }
    if (opts.text) { where.push("content LIKE ?"); args.push(`%${opts.text}%`); }

    const sql =
      "SELECT * FROM messages" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY create_time ${opts.order === "asc" ? "ASC" : "DESC"}` +
      (opts.limit ? ` LIMIT ${Math.max(1, Math.min(2000, opts.limit))}` : " LIMIT 200");

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  /** 按会话统计一段时间的消息量，im_inbox 的概览用 */
  countByChat(since: number, opts?: { excludeMine?: boolean }): { chatId: string; chatName: string; total: number; atMe: number; lastTime: number }[] {
    const extra = opts?.excludeMine ? " AND is_mine = 0" : "";
    const rows = this.db
      .prepare(`
        SELECT chat_id, chat_name, COUNT(*) AS total,
               SUM(at_me) AS at_me, MAX(create_time) AS last_time
        FROM messages WHERE create_time > ?${extra}
        GROUP BY chat_id ORDER BY last_time DESC
      `)
      .all(since) as Record<string, unknown>[];
    return rows.map((r) => ({
      chatId: r.chat_id as string,
      chatName: r.chat_name as string,
      total: Number(r.total),
      atMe: Number(r.at_me ?? 0),
      lastTime: Number(r.last_time),
    }));
  }

  stats(): { messages: number; chats: number; oldest?: number; newest?: number; sizeBytes: number } {
    const g = (sql: string) => Number((this.db.prepare(sql).get() as Record<string, unknown>)?.v ?? 0);
    return {
      messages: g("SELECT COUNT(*) AS v FROM messages"),
      chats: g("SELECT COUNT(DISTINCT chat_id) AS v FROM messages"),
      oldest: g("SELECT MIN(create_time) AS v FROM messages") || undefined,
      newest: g("SELECT MAX(create_time) AS v FROM messages") || undefined,
      sizeBytes: g("SELECT page_count * page_size AS v FROM pragma_page_count(), pragma_page_size()"),
    };
  }

  /** 删掉超过留存期的消息，返回删了多少条 */
  prune(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 86400_000;
    const r = this.db.prepare("DELETE FROM messages WHERE create_time < ?").run(cutoff);
    return Number(r.changes);
  }
}

function rowToMessage(r: Record<string, unknown>): ImMessage {
  return {
    messageId: r.message_id as string,
    chatId: r.chat_id as string,
    chatName: r.chat_name as string,
    senderId: r.sender_id as string,
    senderName: r.sender_name as string,
    createTime: Number(r.create_time),
    msgType: r.msg_type as string,
    content: r.content as string,
    mentions: JSON.parse((r.mentions as string) || "[]"),
    atMe: Number(r.at_me) === 1,
    isMine: Number(r.is_mine) === 1,
    threadId: (r.thread_id as string) || undefined,
    parentId: (r.parent_id as string) || undefined,
    raw: (r.raw as string) || undefined,
  };
}
