import { Client } from "ssh2";
import { readFileSync } from "fs";
import { homedir, userInfo } from "os";
import { join } from "path";
import { SocksClient } from "socks";
import { ServerConfig, ConnectionStatus, ProxyConfig, ProxyJumpConfig } from "./types.js";
import { ShellManager } from "./shell-manager.js";
import { SFTPManager } from "./sftp-manager.js";

// 内置的本地服务器配置
export const LOCAL_SERVER: ServerConfig = {
  name: "local",
  host: "localhost",
  port: 0,
  username: process.env.USER || process.env.USERNAME || "local",
};

export class SSHManager {
  private client: Client | null = null;
  private jumpClient: Client | null = null;
  private currentServer: ServerConfig | null = null;
  private isConnected: boolean = false;
  private shellManager: ShellManager;
  private sftpManager: SFTPManager;
  private isLocalConnection: boolean = false;

  constructor() {
    this.shellManager = new ShellManager();
    this.sftpManager = new SFTPManager();
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
   * 本地连接。优先用 node-pty 开真 PTY；
   * 若 PTY 申请失败（典型原因：macOS launchd 托管的 daemon 无 TTY session），
   * 自动降级为"SSH loopback"——通过 ssh2 连 127.0.0.1 走自家 sshd，
   * sshd 会分配真 PTY，对 LLM 完全透明。
   */
  private async connectLocal(): Promise<void> {
    try {
      await this.shellManager.openLocal();
      this.isConnected = true;
      this.isLocalConnection = true;
      this.currentServer = LOCAL_SERVER;
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[mcp-ssh-pty] local PTY failed (${msg}); falling back to ssh loopback 127.0.0.1:22`);
      try {
        await this.connectLoopbackSSH();
      } catch (loopErr) {
        this.cleanup();
        const loopMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        throw new Error(`无法打开本地 shell（PTY 失败：${msg}；loopback SSH 失败：${loopMsg}）`);
      }
    }
  }

  /**
   * SSH loopback：连 127.0.0.1:22 当作 local shell。
   * 前置：当前用户 ~/.ssh/authorized_keys 里要有本机的一把 pub key。
   */
  private async connectLoopbackSSH(): Promise<void> {
    const username = process.env.USER || userInfo().username;
    const keyCandidates = [
      join(homedir(), ".ssh", "id_ed25519"),
      join(homedir(), ".ssh", "id_rsa"),
    ];
    let privateKey: Buffer | null = null;
    let usedKeyPath: string | null = null;
    for (const kp of keyCandidates) {
      try {
        privateKey = readFileSync(kp);
        usedKeyPath = kp;
        break;
      } catch { /* try next */ }
    }
    if (!privateKey) {
      throw new Error("找不到可用私钥（~/.ssh/id_ed25519 或 ~/.ssh/id_rsa）");
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;

      client.on("ready", async () => {
        if (this.client !== client) {
          client.end();
          reject(new Error("连接已被取消"));
          return;
        }
        this.isConnected = true;
        this.isLocalConnection = true; // 对外仍标记 local，保持行为一致
        this.currentServer = LOCAL_SERVER;
        try {
          await this.shellManager.open(client);
          console.error(`[mcp-ssh-pty] local fallback: ssh ${username}@127.0.0.1 via ${usedKeyPath}`);
          resolve();
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      });

      client.on("error", (err) => {
        this.cleanup();
        reject(err);
      });

      client.on("close", () => {
        if (this.client === client) this.cleanup();
      });

      client.connect({
        host: "127.0.0.1",
        port: 22,
        username,
        privateKey,
        // loopback 无 MITM 风险，跳过 host key 校验
        hostVerifier: () => true,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      });
    });
  }

  /**
   * SSH 远程连接
   */
  private async connectSSH(config: ServerConfig): Promise<void> {
    // ProxyJump: 先连跳板机，再通过 forwardOut 连目标
    if (config.proxyJump) {
      return this.connectViaJump(config);
    }

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
      const client = new Client();
      this.client = client;

      client.on("ready", async () => {
        // 检查是否已被 cleanup（竞态保护）
        if (this.client !== client) {
          client.end();
          reject(new Error("连接已被取消"));
          return;
        }

        this.isConnected = true;
        this.isLocalConnection = false;
        this.currentServer = config;

        // 连接成功后自动打开 shell（使用局部变量避免竞态）
        try {
          await this.shellManager.open(client);
          resolve();
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      });

      client.on("error", (err) => {
        this.cleanup();
        reject(err);
      });

      client.on("close", () => {
        // 仅当 client 仍是当前连接时才 cleanup
        if (this.client === client) {
          this.cleanup();
        }
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
   * 通过 ProxyJump 跳板机连接
   */
  private async connectViaJump(config: ServerConfig): Promise<void> {
    const jump = config.proxyJump!;
    const jumpPort = jump.port || 22;
    const destPort = config.port || 22;

    // 第一步：连接跳板机
    const jumpClient = new Client();
    this.jumpClient = jumpClient;

    const jumpStream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      jumpClient.on("ready", () => {
        // 第二步：通过跳板机建立到目标的隧道
        jumpClient.forwardOut(
          "127.0.0.1", 0,
          config.host, destPort,
          (err, stream) => {
            if (err) {
              jumpClient.end();
              reject(new Error(`跳板机隧道创建失败: ${err.message}`));
            } else {
              resolve(stream);
            }
          }
        );
      });

      jumpClient.on("error", (err) => {
        reject(new Error(`跳板机连接失败: ${err.message}`));
      });

      const jumpConfig: Record<string, unknown> = {
        host: jump.host,
        port: jumpPort,
        username: jump.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };

      if (jump.privateKeyPath) {
        try {
          jumpConfig.privateKey = readFileSync(this.expandPath(jump.privateKeyPath));
          if (jump.passphrase) {
            jumpConfig.passphrase = jump.passphrase;
          }
        } catch (error) {
          reject(new Error(`无法读取跳板机私钥文件: ${jump.privateKeyPath}`));
          return;
        }
      } else if (jump.password) {
        jumpConfig.password = jump.password;
      } else {
        reject(new Error("跳板机必须提供 password 或 privateKeyPath"));
        return;
      }

      jumpClient.connect(jumpConfig);
    });

    // 第三步：通过隧道连接目标服务器
    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;

      client.on("ready", async () => {
        // 检查是否已被 cleanup（竞态保护）
        if (this.client !== client) {
          client.end();
          reject(new Error("连接已被取消"));
          return;
        }

        this.isConnected = true;
        this.isLocalConnection = false;
        this.currentServer = config;

        try {
          await this.shellManager.open(client);
          resolve();
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      });

      client.on("error", (err) => {
        this.cleanup();
        reject(err);
      });

      client.on("close", () => {
        if (this.client === client) {
          this.cleanup();
        }
      });

      const connectConfig: Record<string, unknown> = {
        sock: jumpStream,
        username: config.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };

      if (config.privateKeyPath) {
        try {
          connectConfig.privateKey = readFileSync(this.expandPath(config.privateKeyPath));
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
    // 先关闭 SFTP 和 shell
    this.sftpManager.close();
    this.shellManager.close();

    if (this.client && this.isConnected && !this.isLocalConnection) {
      this.client.end();
    }
    if (this.jumpClient) {
      this.jumpClient.end();
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.sftpManager.close();
    this.isConnected = false;
    this.isLocalConnection = false;
    this.currentServer = null;
    this.client = null;
    this.jumpClient = null;
  }

  getClient(): Client | null {
    return this.client;
  }

  getShellManager(): ShellManager {
    return this.shellManager;
  }

  getSftpManager(): SFTPManager {
    return this.sftpManager;
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
