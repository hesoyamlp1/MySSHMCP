import { Client } from "ssh2";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ServerConfig, CommandResult, ConnectionStatus } from "./types.js";

export class SSHManager {
  private client: Client | null = null;
  private currentServer: ServerConfig | null = null;
  private isConnected: boolean = false;

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

      this.client.on("ready", () => {
        this.isConnected = true;
        this.currentServer = config;
        resolve();
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

  async executeCommand(command: string, timeout: number = 30000): Promise<CommandResult> {
    if (!this.client || !this.isConnected) {
      throw new Error("未连接到服务器，请先使用 connect_server 连接");
    }

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timeoutId: NodeJS.Timeout;

      this.client!.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        timeoutId = setTimeout(() => {
          stream.close();
          reject(new Error(`命令执行超时 (>${timeout}ms)`));
        }, timeout);

        stream.on("close", (code: number) => {
          clearTimeout(timeoutId);
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code || 0,
          });
        });

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
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
