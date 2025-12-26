import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ServersConfig, ServerConfig } from "./types.js";

export class ConfigManager {
  private config: ServersConfig | null = null;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || this.resolveConfigPath();
  }

  private resolveConfigPath(): string {
    if (process.env.SSH_MCP_CONFIG_PATH) {
      return this.expandPath(process.env.SSH_MCP_CONFIG_PATH);
    }
    return join(homedir(), ".config", "ssh-mcp", "servers.json");
  }

  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      return join(homedir(), path.slice(1));
    }
    return path;
  }

  load(): ServersConfig {
    if (!existsSync(this.configPath)) {
      throw new Error(`配置文件不存在: ${this.configPath}\n请创建配置文件或设置 SSH_MCP_CONFIG_PATH 环境变量`);
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

  getServer(name: string): ServerConfig | undefined {
    if (!this.config) this.load();
    return this.config!.servers.find((s) => s.name === name);
  }

  listServers(): ServerConfig[] {
    if (!this.config) this.load();
    return this.config!.servers;
  }

  getConfigPath(): string {
    return this.configPath;
  }
}
