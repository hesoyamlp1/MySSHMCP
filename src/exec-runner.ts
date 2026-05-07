import { Client } from "ssh2";
import { spawn } from "child_process";

/**
 * 单次 exec 调用的结果。stdout/stderr 都是已 utf-8 解码、已截断（如超限）的字符串。
 * 与 PTY shell 不同，此处不做 ANSI 清洗——exec 通道天生没有终端，sshd 默认不分配 PTY。
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
  bytesStdout: number;
  bytesStderr: number;
}

export interface ExecOptions {
  /** 通过 stdin 喂给被执行命令的字面量内容（不再做任何 escape / heredoc 包装） */
  stdin?: string;
  /** 整体超时（毫秒），到点强杀。默认 30s。 */
  timeoutMs?: number;
  /** 单流（stdout/stderr 各自）保留的最大字节，超了就截断并标记 truncated。默认 1MB。 */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 通过 SSH exec 通道跑一条命令。**不复用** PTY 持久 shell，因此：
 * - 没有 bracketed-paste / 续行 prompt / sentinel 之类终端层面的污染
 * - cwd 和 env 是 sshd 默认值（通常是 $HOME），不继承 PTY shell 当前状态
 * - 命令字符串会被远端 login shell 解释（bash/zsh 的 -c），可以用引号、管道、重定向
 */
export function execRemote(
  client: Client,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(new Error(`exec 失败: ${err.message}`));
        return;
      }

      let stdout = "";
      let stderr = "";
      let bytesStdout = 0;
      let bytesStderr = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.signal("KILL"); } catch { /* 部分 sshd 不支持 signal，吃掉 */ }
        try { stream.end(); } catch { /* */ }
      }, timeoutMs);

      stream.on("data", (d: Buffer) => {
        bytesStdout += d.length;
        if (stdout.length < maxBytes) {
          stdout += d.toString("utf8");
          if (stdout.length > maxBytes) {
            stdout = stdout.slice(0, maxBytes);
            truncated = true;
          }
        } else {
          truncated = true;
        }
      });
      stream.stderr.on("data", (d: Buffer) => {
        bytesStderr += d.length;
        if (stderr.length < maxBytes) {
          stderr += d.toString("utf8");
          if (stderr.length > maxBytes) {
            stderr = stderr.slice(0, maxBytes);
            truncated = true;
          }
        } else {
          truncated = true;
        }
      });

      stream.on("close", (code: number | null, signal?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal,
          timedOut,
          truncated,
          bytesStdout,
          bytesStderr,
        });
      });

      stream.on("error", (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });

      if (options.stdin !== undefined) {
        stream.end(options.stdin);
      } else {
        stream.end();
      }
    });
  });
}

/**
 * 在 daemon 所在机器上跑一条命令（绕过 PTY，直接 child_process）。
 * 命令字符串通过 $SHELL -c 解释（非交互模式，不会加载 .zshrc 的 alias）。
 */
export function execLocal(
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const shell = process.env.SHELL || "/bin/sh";

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(shell, ["-c", command], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let bytesStdout = 0;
    let bytesStderr = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* */ }
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      bytesStdout += d.length;
      if (stdout.length < maxBytes) {
        stdout += d.toString("utf8");
        if (stdout.length > maxBytes) {
          stdout = stdout.slice(0, maxBytes);
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      bytesStderr += d.length;
      if (stderr.length < maxBytes) {
        stderr += d.toString("utf8");
        if (stderr.length > maxBytes) {
          stderr = stderr.slice(0, maxBytes);
          truncated = true;
        }
      } else {
        truncated = true;
      }
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? undefined,
        timedOut,
        truncated,
        bytesStdout,
        bytesStderr,
      });
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}
