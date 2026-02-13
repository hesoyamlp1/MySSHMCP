import { Client } from "ssh2";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { SocksClient } from "socks";
import { ServerConfig, ConnectionStatus, ProxyConfig } from "./types.js";
import { ShellManager } from "./shell-manager.js";
import { getSanitizer } from "./sanitizer.js";

// 内置的本地服务器配置
export const LOCAL_SERVER: ServerConfig = {
  name: "local",
  host: "localhost",
  port: 0,
  username: process.env.USER || process.env.USERNAME || "local",
};

export class SSHManager {
  private client: Client | null = null;
  private currentServer: ServerConfig | null = null;
  private isConnected: boolean = false;
  private shellManager: ShellManager;
  private isLocalConnection: boolean = false;

  constructor() {
    this.shellManager = new ShellManager();
  }

  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      return join(homedir(), path.slice(1));
    }
    return path;
  }

  /**
   * 检查是否是本地连接
   */
  static isLocalServer(config: ServerConfig): boolean {
    return config.name === "local" || config.host === "local";
  }

  async connect(config: ServerConfig): Promise<void> {
    if (this.isConnected) {
      await this.disconnect();
    }

    // 检查是否是本地连接
    if (SSHManager.isLocalServer(config)) {
      return this.connectLocal();
    }

    return this.connectSSH(config);
  }

  /**
   * 本地连接
   */
  private async connectLocal(): Promise<void> {
    try {
      await this.shellManager.openLocal();
      this.isConnected = true;
      this.isLocalConnection = true;
      this.currentServer = LOCAL_SERVER;
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  /**
   * SSH 远程连接
   */
  private async connectSSH(config: ServerConfig): Promise<void> {
    // 如果配置了代理，先建立代理连接
    let proxySocket: ReturnType<typeof SocksClient.createConnection> extends Promise<infer T> ? T : never;
    if (config.proxy) {
      try {
        proxySocket = await this.createProxyConnection(config.proxy, config.host, config.port || 22);
      } catch (error) {
        throw new Error(`代理连接失败: ${error instanceof Error ? error.message : error}`);
      }
    }

    return new Promise((resolve, reject) => {
      this.client = new Client();

      this.client.on("ready", async () => {
        this.isConnected = true;
        this.isLocalConnection = false;
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
        keepaliveInterval: 10000,   // 每 10 秒发送心跳
        keepaliveCountMax: 3,       // 3 次无响应才断开
      };

      // 如果有代理，使用代理 socket
      if (proxySocket) {
        connectConfig.sock = proxySocket.socket;
      }

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

  /**
   * 通过 SOCKS 代理创建连接
   */
  private async createProxyConnection(proxy: ProxyConfig, destHost: string, destPort: number) {
    return SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.type || 5,
        userId: proxy.username,
        password: proxy.password,
      },
      command: "connect",
      destination: {
        host: destHost,
        port: destPort,
      },
    });
  }

  async disconnect(): Promise<void> {
    // 先关闭 shell
    this.shellManager.close();

    if (this.client && this.isConnected && !this.isLocalConnection) {
      this.client.end();
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.isConnected = false;
    this.isLocalConnection = false;
    this.currentServer = null;
    this.client = null;
    // 清除敏感信息
    getSanitizer().clearSensitiveValues();
  }

  /**
   * 注册服务器配置中的敏感信息
   */
  private registerSensitiveInfo(config: ServerConfig): void {
    const sanitizer = getSanitizer();
    sanitizer.addSensitiveValues([
      config.host,
      config.password,
      config.passphrase,
      config.username,
      config.privateKeyPath,
      config.proxy?.host,
      config.proxy?.password,
    ]);
  }

  getShellManager(): ShellManager {
    return this.shellManager;
  }

  isLocal(): boolean {
    return this.isLocalConnection;
  }

  getStatus(): ConnectionStatus {
    return {
      connected: this.isConnected,
      serverName: this.currentServer?.name || null,
      host: this.isLocalConnection ? "local" : (this.currentServer?.host || null),
      username: this.currentServer?.username || null,
    };
  }
}
