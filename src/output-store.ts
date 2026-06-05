import { writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OUTPUT_DIR = join(homedir(), ".mori", "ssh", "output");
const THRESHOLD_CHARS = 8000;
const TAIL_CHARS = 2000;

export interface SaveResult {
  saved: boolean;
  filePath?: string;
  id?: string;
  tail?: string;
  totalChars?: number;
}

function ensureOutputDir(): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function generateId(): string {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `ssh-${ts}-${rand}`;
}

const MAX_OUTPUT_FILES = 50;

/**
 * 回收 output 目录：按 mtime 保留最近 MAX_OUTPUT_FILES 个，其余删掉。
 * saveIfLarge 每次写完调一次，避免溢出文件单调堆积吃满磁盘。
 */
function pruneOldOutputs(): void {
  try {
    const files = readdirSync(OUTPUT_DIR)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => {
        const p = join(OUTPUT_DIR, f);
        return { p, m: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.m - a.m); // 新 → 旧
    for (const f of files.slice(MAX_OUTPUT_FILES)) {
      try { unlinkSync(f.p); } catch { /* ignore */ }
    }
  } catch { /* 目录不存在等，忽略 */ }
}

/**
 * 检查输出是否过大，如果是则保存到本地文件并返回尾部摘要
 */
export function saveIfLarge(content: string): SaveResult {
  if (!content || content.length <= THRESHOLD_CHARS) {
    return { saved: false };
  }

  ensureOutputDir();

  const id = generateId();
  const filePath = join(OUTPUT_DIR, `${id}.txt`);

  writeFileSync(filePath, content, "utf-8");
  pruneOldOutputs(); // 写完顺手回收旧文件，别让 output 目录无限增长

  const tail = content.slice(-TAIL_CHARS);

  return {
    saved: true,
    filePath,
    id,
    tail,
    totalChars: content.length,
  };
}

