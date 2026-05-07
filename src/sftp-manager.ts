import { Client, SFTPWrapper } from "ssh2";
import { resolve, dirname, posix as pathPosix } from "path";
import { promises as fsp } from "fs";
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
   * 把内联文本写到远端文件（不走 PTY，绕开所有 heredoc / bracketed-paste 痛点）
   * @param mkdirs 父目录不存在时自动建（mkdir -p 语义）
   * @param mode  POSIX 权限位（八进制数，如 0o644）；默认 0o644
   */
  async writeRemote(
    client: Client,
    remotePath: string,
    content: string,
    options?: { mkdirs?: boolean; mode?: number }
  ): Promise<{ path: string; bytes: number }> {
    const sftp = await this.getSftp(client);
    const mode = options?.mode ?? 0o644;
    const buf = Buffer.from(content, "utf8");

    if (options?.mkdirs) {
      const parent = pathPosix.dirname(remotePath);
      if (parent && parent !== "." && parent !== "/") {
        await this.mkdirsRemote(sftp, parent);
      }
    }

    await new Promise<void>((res, rej) => {
      sftp.writeFile(remotePath, buf, { mode }, (err) => {
        if (err) rej(new Error(`写入远端失败: ${err.message}`));
        else res();
      });
    });
    return { path: remotePath, bytes: buf.length };
  }

  /**
   * 读取远端文件文本内容
   */
  async readRemote(
    client: Client,
    remotePath: string,
    options?: { encoding?: BufferEncoding; maxBytes?: number }
  ): Promise<{ path: string; bytes: number; content: string; truncated: boolean }> {
    const sftp = await this.getSftp(client);
    const encoding = options?.encoding ?? "utf8";
    const maxBytes = options?.maxBytes ?? 1024 * 1024; // 默认 1MB 上限

    const buf = await new Promise<Buffer>((res, rej) => {
      sftp.readFile(remotePath, (err, data) => {
        if (err) rej(new Error(`读取远端失败: ${err.message}`));
        else res(data);
      });
    });

    const truncated = buf.length > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;
    return {
      path: remotePath,
      bytes: buf.length,
      content: slice.toString(encoding),
      truncated,
    };
  }

  /**
   * 递归 mkdir（POSIX）。已存在不报错。
   */
  private async mkdirsRemote(sftp: SFTPWrapper, dir: string): Promise<void> {
    const exists = await new Promise<boolean>((res) => {
      sftp.stat(dir, (err) => res(!err));
    });
    if (exists) return;
    const parent = pathPosix.dirname(dir);
    if (parent && parent !== dir && parent !== "." && parent !== "/") {
      await this.mkdirsRemote(sftp, parent);
    }
    await new Promise<void>((res, rej) => {
      sftp.mkdir(dir, (err) => {
        if (!err) {
          res();
          return;
        }
        // 失败兜底：再 stat 一次，已存在（race 或权限差异）就吞掉
        sftp.stat(dir, (statErr) => {
          if (!statErr) res();
          else rej(new Error(`mkdir 失败 ${dir}: ${err.message}`));
        });
      });
    });
  }

  /**
   * 把内联文本写到本地（daemon 所在机器的）文件。不走 SFTP，直接 fs。
   */
  async writeLocalFile(
    localPath: string,
    content: string,
    options?: { mkdirs?: boolean; mode?: number }
  ): Promise<{ path: string; bytes: number }> {
    const safePath = this.validateLocalPath(localPath, "upload");
    const mode = options?.mode ?? 0o644;
    const buf = Buffer.from(content, "utf8");

    if (options?.mkdirs) {
      await fsp.mkdir(dirname(safePath), { recursive: true });
    }
    await fsp.writeFile(safePath, buf, { mode });
    return { path: safePath, bytes: buf.length };
  }

  /**
   * 读取本地文件
   */
  async readLocalFile(
    localPath: string,
    options?: { encoding?: BufferEncoding; maxBytes?: number }
  ): Promise<{ path: string; bytes: number; content: string; truncated: boolean }> {
    const safePath = this.validateLocalPath(localPath, "download");
    const encoding = options?.encoding ?? "utf8";
    const maxBytes = options?.maxBytes ?? 1024 * 1024;

    const buf = await fsp.readFile(safePath);
    const truncated = buf.length > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;
    return {
      path: safePath,
      bytes: buf.length,
      content: slice.toString(encoding),
      truncated,
    };
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
