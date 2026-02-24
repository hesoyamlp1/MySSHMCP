import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const NOTES_DIR = join(homedir(), ".mori", "notes");

/**
 * 服务器备注管理器
 * 在 ~/.mori/notes/{server-name}.md 中存储每台服务器的备注
 */
export class NotesManager {
    private notesDir: string;

    constructor(notesDir?: string) {
        this.notesDir = notesDir || NOTES_DIR;
    }

    /**
     * 确保备注目录存在
     */
    private ensureDir(): void {
        if (!existsSync(this.notesDir)) {
            mkdirSync(this.notesDir, { recursive: true });
        }
    }

    /**
     * 获取备注文件路径
     */
    getPath(serverName: string): string {
        return join(this.notesDir, `${serverName}.md`);
    }

    /**
     * 检查是否有备注
     */
    exists(serverName: string): boolean {
        return existsSync(this.getPath(serverName));
    }

    /**
     * 读取完整备注内容
     */
    read(serverName: string): string | null {
        const path = this.getPath(serverName);
        if (!existsSync(path)) {
            return null;
        }
        try {
            return readFileSync(path, "utf-8").trim();
        } catch {
            return null;
        }
    }

    /**
     * 读取第一行作为摘要（用于 list 展示）
     */
    readSummary(serverName: string): string | null {
        const content = this.read(serverName);
        if (!content) return null;

        // 跳过 markdown 标题符号，取第一行有内容的文本
        const lines = content.split("\n");
        for (const line of lines) {
            const trimmed = line.replace(/^#+\s*/, "").trim();
            if (trimmed) return trimmed;
        }
        return null;
    }

    /**
     * 写入/覆盖备注内容
     */
    write(serverName: string, content: string): string {
        this.ensureDir();
        const path = this.getPath(serverName);
        writeFileSync(path, content, "utf-8");
        return path;
    }
}
