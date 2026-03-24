import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

const CONFIG_PATH = join(homedir(), ".mori", "ssh", "sanitizer.json");

export type IpMode = "all" | "ssh-only" | "none";
export type PasswordMode = "all" | "password-only" | "none";

export interface SanitizerConfig {
    ipMode: IpMode;
    passwordMode: PasswordMode;
    whitelist: string[];
}

const DEFAULT_CONFIG: SanitizerConfig = {
    ipMode: "all",
    passwordMode: "all",
    whitelist: [],
};

/**
 * 加载 sanitizer 配置
 */
export function loadSanitizerConfig(): SanitizerConfig {
    if (!existsSync(CONFIG_PATH)) {
        return { ...DEFAULT_CONFIG };
    }
    try {
        const content = readFileSync(CONFIG_PATH, "utf-8");
        const parsed = JSON.parse(content);
        return {
            ipMode: parsed.ipMode || DEFAULT_CONFIG.ipMode,
            passwordMode: parsed.passwordMode || DEFAULT_CONFIG.passwordMode,
            whitelist: Array.isArray(parsed.whitelist) ? parsed.whitelist : [],
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * 保存 sanitizer 配置
 */
export function saveSanitizerConfig(config: SanitizerConfig): void {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 获取配置文件路径
 */
export function getSanitizerConfigPath(): string {
    return CONFIG_PATH;
}
