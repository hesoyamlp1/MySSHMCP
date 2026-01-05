import { Client } from "ssh2";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ServerConfig, ConnectionStatus } from "./types.js";
import { ShellManager } from "./shell-manager.js";
import { getSanitizer } from "./sanitizer.js";

export class SSHManager {
  private client: Client | null = null;
  private currentServer: ServerConfig | null = null;
  private isConnected: boolean = false;
  private shellManager: ShellManager;

  constructor() {
    this.shellManager = new ShellManager();
  }

  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      return join(homedir(), path.slice(1));
    }
    return path;
  }

  async connect(config: ServerConfig): Promise<void> {
    if (this.isConnected) {
      await this.disconnect();
    }

    return new Promise((resolve, reject) => {
      this.client = new Client();

      this.client.on("ready", async () => {
        this.isConnected = true;
        this.currentServer = config;

        // 注册敏感信息到过滤器
        this.registerSensitiveInfo(config);

        // 连接成功后自动打开 shell
        try {
          await this.shellManager.open(this.client!);
          resolve();
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      });

      this.client.on("error", (err) => {
        this.cleanup();
        reject(err);
      });

      this.client.on("close", () => {
        this.cleanup();
      });

      const connectConfig: Record<string, unknown> = {
        host: config.host,
        port: config.port || 22,
        username: config.username,
      };

      if (config.privateKeyPath) {
        try {
          const keyPath = this.expandPath(config.privateKeyPath);
          connectConfig.privateKey = readFileSync(keyPath);
          if (config.passphrase) {
            connectConfig.passphrase = config.passphrase;
          }
        } catch (error) {
          reject(new Error(`无法读取私钥文件: ${config.privateKeyPath}`));
          return;
        }
      } else if (config.password) {
        connectConfig.password = config.password;
      } else {
        reject(new Error("必须提供 password 或 privateKeyPath"));
        return;
      }

      this.client.connect(connectConfig);
    });
  }

  async disconnect(): Promise<void> {
    // 先关闭 shell
    this.shellManager.close();

    if (this.client && this.isConnected) {
      this.client.end();
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.isConnected = false;
    this.currentServer = null;
    this.client = null;
  }

  getShellManager(): ShellManager {
    return this.shellManager;
  }

  getStatus(): ConnectionStatus {
    return {
      connected: this.isConnected,
      serverName: this.currentServer?.name || null,
      host: this.currentServer?.host || null,
      username: this.currentServer?.username || null,
    };
  }
}
