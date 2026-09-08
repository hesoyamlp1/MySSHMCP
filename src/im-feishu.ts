import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ImMessage } from "./im-store.js";
import { ImChat, ImConfig } from "./im-config.js";

const exec = promisify(execFile);

/**
 * 调 lark-cli 拉飞书消息。
 *
 * 为什么走 lark-cli 而不是自己打接口：它已经把 token 续期、分页、
 * 各种消息类型渲染成人能读的正文这些事做完了，自己重写一遍没意义。
 * 代价是它把时间格式化成了本机时区的分钟精度（"2026-09-08 01:06"），
 * 做水位不够精细——所以水位是「时间 + message_id」两件一起用：
 * 按时间往前多拉一分钟，重复的靠 message_id 在入库时去掉。
 */

/** lark-cli 返回的一条消息（只列我们用得到的字段） */
interface RawMessage {
  message_id: string;
  chat_id: string;
  create_time: string;      // "2026-09-08 01:06"，本机时区
  msg_type: string;
  content?: string;         // 已渲染的正文
  deleted?: boolean;
  reply_to?: string;
  thread_id?: string;
  mentions?: { id: string; key: string; name: string }[];
  sender: {
    id: string;
    id_type: string;        // open_id | app_id
    name?: string;
    sender_type: string;    // user | app
  };
}

export interface FetchResult {
  messages: ImMessage[];
  /** 这一轮拿到的最新一条的时间和 id，用来更新水位 */
  lastTime: number;
  lastMessageId: string;
}

/** 把 "2026-09-08 01:06" 按本机时区解析成毫秒。lark-cli 是按本机时区格式化的 */
export function parseLarkTime(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s.trim());
  if (!m) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    throw new Error(`看不懂的时间格式: ${s}`);
  }
  const [, y, mo, d, h, mi, sec] = m;
  return new Date(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0).getTime();
}

/** 毫秒 → lark-cli 的 --start 认的格式（ISO，带本机时区偏移） */
function toLarkStart(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

async function larkJson(profile: string, args: string[], timeoutMs = 120_000): Promise<any> {
  const { stdout } = await exec("lark-cli", ["--profile", profile, ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  if (parsed.ok === false) {
    const e = parsed.error ?? {};
    throw new Error(`lark-cli ${args[0]} 失败: ${e.message ?? JSON.stringify(e)}`);
  }
  return parsed;
}

/**
 * 拉一个会话在 since 之后的消息。
 * since 传 0 表示第一次采集，只拉最近 initialHours 小时，别把几年的历史一次灌进来。
 */
export async function fetchChatMessages(
  cfg: ImConfig,
  chat: ImChat,
  since: number,
  opts: { initialHours?: number; pageSize?: number } = {}
): Promise<FetchResult> {
  const initialHours = opts.initialHours ?? 48;
  // 时间精度只到分钟，往前多拉一分钟，宁可重复也别漏；重复的入库时按 message_id 去掉
  const start = since > 0 ? since - 60_000 : Date.now() - initialHours * 3600_000;

  const res = await larkJson(cfg.profile, [
    "im", "+chat-messages-list",
    "--as", "user",
    "--chat-id", chat.chatId,
    "--start", toLarkStart(start),
    "--page-all",
    "--page-size", String(opts.pageSize ?? 50),
    "--no-reactions",
  ]);

  const raw: RawMessage[] = res?.data?.messages ?? [];
  const messages: ImMessage[] = [];
  let lastTime = since;
  let lastMessageId = "";

  for (const m of raw) {
    if (m.deleted) continue;
    const t = parseLarkTime(m.create_time);
    const senderId = m.sender?.id ?? "";
    const mentions = (m.mentions ?? []).map((x) => x.id).filter(Boolean);
    messages.push({
      messageId: m.message_id,
      chatId: chat.chatId,
      chatName: chat.name,
      senderId,
      senderName: m.sender?.name ?? senderId,
      createTime: t,
      msgType: m.msg_type,
      content: m.content ?? "",
      mentions,
      // @我：mentions 里有我，或者正文里带我的名字（有些客户端发的 @ 不进 mentions）。
      // 机器人 @ 我不算——Mori 自己在群里 @ 我等确认，那是我那半，不是别人提的需求
      atMe: (m.sender?.sender_type === "user") &&
            (mentions.includes(cfg.meOpenId) ||
             (!!cfg.meName && (m.content ?? "").includes(`@${cfg.meName}`))),
      isMine: senderId === cfg.meOpenId,
      threadId: m.thread_id,
      parentId: m.reply_to,
      raw: JSON.stringify(m),
    });
    if (t >= lastTime) { lastTime = t; lastMessageId = m.message_id; }
  }

  return { messages, lastTime, lastMessageId };
}

/** 会话列表，用来发现新会话和刷新改过的名字 */
export async function listChats(
  cfg: ImConfig,
  types: ("group" | "p2p")[] = ["group", "p2p"]
): Promise<{ chatId: string; name: string; mode: "group" | "p2p"; targetType?: string }[]> {
  const res = await larkJson(cfg.profile, [
    "im", "+chat-list", "--as", "user",
    "--types", types.join(","),
    "--page-all",
  ]);
  const chats = res?.data?.chats ?? [];
  return chats.map((c: any) => ({
    chatId: c.chat_id,
    name: c.name ?? c.chat_id,
    mode: (c.chat_mode === "p2p" ? "p2p" : "group") as "group" | "p2p",
    // 单聊时对方是人还是机器人；机器人单聊不值得监控
    targetType: c.p2p_target_type,
  }));
}

/** 把消息里的图片或文件下到本地，返回落盘路径 */
export async function downloadResource(
  cfg: ImConfig,
  messageId: string,
  fileKey: string,
  outPath: string,
  type: "image" | "file" = "image"
): Promise<{ path: string; bytes: number }> {
  const res = await larkJson(cfg.profile, [
    "im", "+messages-resources-download",
    "--as", "user",
    "--message-id", messageId,
    "--file-key", fileKey,
    "--type", type,
    "--output", outPath,
  ], 180_000);
  return { path: res?.data?.saved_path ?? outPath, bytes: Number(res?.data?.size_bytes ?? 0) };
}

/** 正文里的图片 key：post 类型渲染成 ![Image](img_xxx)，image 类型渲染成 [Image: img_xxx] */
export function extractImageKeys(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/!\[Image\]\((img_[\w-]+)\)/g)) out.add(m[1]);
  for (const m of content.matchAll(/\[Image:\s*(img_[\w-]+)\]/g)) out.add(m[1]);
  return [...out];
}

/** 当前登录的是谁；--im-init 用它填 meOpenId */
export async function whoami(profile: string): Promise<{ openId: string; name: string }> {
  const { stdout } = await exec("lark-cli", ["--profile", profile, "auth", "status"], {
    timeout: 30_000,
  });
  const j = JSON.parse(stdout);
  const u = j?.identities?.user;
  if (!u?.openId) throw new Error(`profile ${profile} 还没有用户身份，先跑 lark-cli auth login`);
  return { openId: u.openId, name: u.userName ?? "" };
}
