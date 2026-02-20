import { Client, SFTPWrapper } from "ssh2";
import { resolve } from "path";
import { homedir } from "os";

// 禁止访问的本地敏感路径前缀
const BLOCKED_PATHS = [
  "/etc/shadow",
  "/etc/sudoers",
  "/private/etc",
];

// 禁止上传的敏感文件名
const BLOCKED_UPLOAD_PATTERNS = [
  /id_rsa$/i,
  /id_ed25519$/i,
  /id_ecdsa$/i,
  /\.pem$/i,
  /authorized_keys$/i,
  /known_hosts$/i,
  /ssh-servers\.json$/i,
];

export class SFTPManager {
  private sftp: SFTPWrapper | null = null;

  /**
   * 校验本地路径安全性
   * - 规范化路径（消除 .. 穿越）
   * - 拒绝访问敏感系统路径
   */
  private validateLocalPath(localPath: string, action: "upload" | "download"): string {
    // 规范化路径，消除 .. 等穿越
    const resolved = resolve(localPath);

    // 检查是否指向敏感系统路径
    for (const blocked of BLOCKED_PATHS) {
      if (resolved.startsWith(blocked)) {
        throw new Error(`安全限制: 禁止${action === "upload" ? "上传" : "下载到"}路径 ${blocked}`);
      }
    }

    // 上传时额外检查是否试图上传 SSH 密钥等敏感文件
    if (action === "upload") {
      for (const pattern of BLOCKED_UPLOAD_PATTERNS) {
        if (pattern.test(resolved)) {
          throw new Error(`安全限制: 禁止上传可能包含敏感信息的文件 (${resolved})`);
        }
      }
    }

    return resolved;
  }

  /**
   * 懒加载获取 SFTP 通道
   * 如果已有通道则复用，否则从 SSH Client 创建新通道
   */
  async getSftp(client: Client): Promise<SFTPWrapper> {
    if (this.sftp) {
      return this.sftp;
    }

    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`无法创建 SFTP 通道: ${err.message}`));
          return;
        }

        this.sftp = sftp;

        // 监听关闭事件
        sftp.on("close", () => {
          this.sftp = null;
        });

        resolve(sftp);
      });
    });
  }

  /**
   * 上传本地文件到远程服务器
   */
  async upload(client: Client, localPath: string, remotePath: string): Promise<string> {
    const safePath = this.validateLocalPath(localPath, "upload");
    const sftp = await this.getSftp(client);

    return new Promise((resolve, reject) => {
      sftp.fastPut(safePath, remotePath, (err) => {
        if (err) {
          reject(new Error(`上传失败: ${err.message}`));
          return;
        }
        resolve(`文件上传成功`);
      });
    });
  }

  /**
   * 从远程服务器下载文件到本地
   */
  async download(client: Client, remotePath: string, localPath: string): Promise<string> {
    const safePath = this.validateLocalPath(localPath, "download");
    const sftp = await this.getSftp(client);

    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, safePath, (err) => {
        if (err) {
          reject(new Error(`下载失败: ${err.message}`));
          return;
        }
        resolve(`文件下载成功`);
      });
    });
  }

  /**
   * 检查 SFTP 通道是否已打开
   */
  isOpen(): boolean {
    return this.sftp !== null;
  }

  /**
   * 关闭 SFTP 通道
   */
  close(): void {
    if (this.sftp) {
      this.sftp.end();
      this.sftp = null;
    }
  }
}
