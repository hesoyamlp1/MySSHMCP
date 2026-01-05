import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { ServersConfig, ServerConfig } from "./types.js";

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
      return join(process.cwd(), ".claude", "ssh-servers.json");
    }
    return join(homedir(), ".claude", "ssh-servers.json");
  }

  static getLocalPath(): string {
    return join(process.cwd(), ".claude", "ssh-servers.json");
  }

  static getGlobalPath(): string {
    return join(homedir(), ".claude", "ssh-servers.json");
  }

  private resolveConfigPath(): { path: string; scope: ConfigScope } {
    // 1. 优先使用环境变量
    if (process.env.SSH_MCP_CONFIG_PATH) {
      return {
        path: this.expandPath(process.env.SSH_MCP_CONFIG_PATH),
        scope: "global",
      };
    }

    // 2. 查找项目目录下的 .claude/ssh-servers.json
    const projectPath = join(process.cwd(), ".claude", "ssh-servers.json");
    if (existsSync(projectPath)) {
      return { path: projectPath, scope: "local" };
    }

    // 3. 查找用户目录下的 ~/.claude/ssh-servers.json
    return {
      path: join(homedir(), ".claude", "ssh-servers.json"),
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
      return this.config!;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`配置文件格式错误: ${this.configPath}\n${error.message}`);
      }
      throw error;
    }
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
