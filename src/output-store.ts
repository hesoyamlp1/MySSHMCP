import { writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const OUTPUT_DIR = join(homedir(), ".mori", "output");
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

  const tail = content.slice(-TAIL_CHARS);

  return {
    saved: true,
    filePath,
    id,
    tail,
    totalChars: content.length,
  };
}
