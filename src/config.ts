import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { ServersConfig, ServerConfig, ShortcutConfig } from "./types.js";
import { validateShortcut } from "./shortcut-renderer.js";

export type ConfigScope = "local" | "global";

export class ConfigManager {
  private config: ServersConfig | null = null;
  private configPath: string;
  private scope: ConfigScope;

  constructor(configPath?: string, scope?: ConfigScope) {
    if (configPath) {
      this.configPath = configPath;
      this.scope = "global";
    } else if (scope) {
      this.configPath = this.getPathByScope(scope);
      this.scope = scope;
    } else {
      const resolved = this.resolveConfigPath();
      this.configPath = resolved.path;
      this.scope = resolved.scope;
    }
  }

  private getPathByScope(scope: ConfigScope): string {
    if (scope === "local") {
      return join(process.cwd(), ".mori", "ssh", "ssh-servers.json");
    }
    return join(homedir(), ".mori", "ssh", "ssh-servers.json");
  }

  static getLocalPath(): string {
    return join(process.cwd(), ".mori", "ssh", "ssh-servers.json");
  }

  static getGlobalPath(): string {
    return join(homedir(), ".mori", "ssh", "ssh-servers.json");
  }

  private resolveConfigPath(): { path: string; scope: ConfigScope } {
    // 1. 优先使用环境变量
    if (process.env.SSH_MCP_CONFIG_PATH) {
      return {
        path: this.expandPath(process.env.SSH_MCP_CONFIG_PATH),
        scope: "global",
      };
    }

    // 2. 查找项目目录下的 .linMCP/ssh-servers.json
    const projectPath = join(process.cwd(), ".mori", "ssh", "ssh-servers.json");
    if (existsSync(projectPath)) {
      return { path: projectPath, scope: "local" };
    }

    // 3. 查找用户目录下的 ~/.linMCP/ssh-servers.json
    return {
      path: join(homedir(), ".mori", "ssh", "ssh-servers.json"),
      scope: "global",
    };
  }

  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      return join(homedir(), path.slice(1));
    }
    return path;
  }

  load(): ServersConfig {
    if (!existsSync(this.configPath)) {
      // 如果配置文件不存在，返回空配置
      this.config = { servers: [] };
      return this.config;
    }
    try {
      const content = readFileSync(this.configPath, "utf-8");
      this.config = JSON.parse(content);
      this.validateShortcuts();
      return this.config!;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`配置文件格式错误: ${this.configPath}\n${error.message}`);
      }
      throw error;
    }
  }

  private validateShortcuts(): void {
    if (!this.config) return;
    if (this.config.shortcuts) {
      for (const [name, cfg] of Object.entries(this.config.shortcuts)) {
        validateShortcut("<global>", name, cfg);
      }
    }
    for (const server of this.config.servers) {
      if (!server.shortcuts) continue;
      for (const [name, cfg] of Object.entries(server.shortcuts)) {
        validateShortcut(server.name, name, cfg);
      }
    }
  }

  /**
   * 返回某台服务器最终生效的 shortcut 字典：
   * 全局 shortcuts ∪ 该服务器自己的 shortcuts，同名时服务器级覆盖全局。
   */
  getEffectiveShortcuts(serverName: string): Record<string, ShortcutConfig> {
    if (!this.config) this.load();
    const global = this.config!.shortcuts ?? {};
    const server = this.config!.servers.find((s) => s.name === serverName);
    const own = server?.shortcuts ?? {};
    return { ...global, ...own };
  }

  /**
   * 判断某条 shortcut 来自全局还是服务器级（用于 summarize 的 source 字段）
   */
  getShortcutSource(serverName: string, shortcutName: string): "global" | "server" | null {
    if (!this.config) this.load();
    const server = this.config!.servers.find((s) => s.name === serverName);
    if (server?.shortcuts && shortcutName in server.shortcuts) return "server";
    if (this.config!.shortcuts && shortcutName in this.config!.shortcuts) return "global";
    return null;
  }

  save(): void {
    // 确保目录存在
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(
      this.configPath,
      JSON.stringify(this.config, null, 2),
      "utf-8"
    );
  }

  getServer(name: string): ServerConfig | undefined {
    if (!this.config) this.load();
    return this.config!.servers.find((s) => s.name === name);
  }

  listServers(): ServerConfig[] {
    if (!this.config) this.load();
    return this.config!.servers;
  }

  addServer(server: ServerConfig): void {
    if (!this.config) this.load();

    // 检查是否已存在
    const existing = this.config!.servers.findIndex((s) => s.name === server.name);
    if (existing >= 0) {
      // 更新已有配置
      this.config!.servers[existing] = server;
    } else {
      this.config!.servers.push(server);
    }

    this.save();
  }

  removeServer(name: string): boolean {
    if (!this.config) this.load();

    const index = this.config!.servers.findIndex((s) => s.name === name);
    if (index < 0) {
      return false;
    }

    this.config!.servers.splice(index, 1);
    this.save();
    return true;
  }

  /**
   * 规范化 hints：统一成 string[]，过滤空白条目；无则返回 undefined
   */
  private normalizeHints(raw: string | string[] | undefined): string[] | undefined {
    if (!raw) return undefined;
    const arr = Array.isArray(raw) ? raw : [raw];
    const cleaned = arr.map((s) => s.trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
  }

  /**
   * 全局指令性提示（配置顶层 globalHints）
   */
  getGlobalHints(): string[] | undefined {
    if (!this.config) this.load();
    return this.normalizeHints(this.config!.globalHints);
  }

  /**
   * 某台服务器的指令性提示（服务器级 hints）
   */
  getServerHints(serverName: string): string[] | undefined {
    if (!this.config) this.load();
    const s = this.config!.servers.find((s) => s.name === serverName);
    return this.normalizeHints(s?.hints);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getScope(): ConfigScope {
    return this.scope;
  }

  configExists(): boolean {
    return existsSync(this.configPath);
  }

  static localConfigExists(): boolean {
    return existsSync(ConfigManager.getLocalPath());
  }

  static globalConfigExists(): boolean {
    return existsSync(ConfigManager.getGlobalPath());
  }
}
