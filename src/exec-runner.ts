import { Client } from "ssh2";
import { spawn, execFileSync } from "child_process";
import { existsSync } from "fs";

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
  /** 在哪个目录跑（exec 每次是全新 shell、cwd 不持久，用这个省掉 cd x && 前缀）。 */
  cwd?: string;
}

/**
 * 本机 exec 用的 PATH：launchd/systemd 起的 daemon 继承的是最小 PATH（mac 上连 sysctl/brew 都不在），
 * 这里在**首次用到时抓一次登录 shell 的 $PATH**（source 过 profile，就是终端里看到的那个），
 * 与当前 process.env.PATH 取并集——既拿到 mac 的原生 PATH，又不丢 systemd unit 里配的（如 git-ai）。
 * 只付一次、带 4s 超时兜底，绝不进每条命令。
 */
let cachedPath: string | null = null;
function enrichedPath(): string {
  if (cachedPath !== null) return cachedPath;
  const base = process.env.PATH ?? "/usr/bin:/bin";
  // windows 没有登录 shell 这套（PATH 从注册表继承，已经是全的），直接用 base
  if (process.platform === "win32") {
    cachedPath = base;
    return cachedPath;
  }
  let login = "";
  try {
    const shell = process.env.SHELL || "/bin/sh";
    login = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], {
      timeout: 4000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* 抓不到就只用 base */
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of `${login}:${base}`.split(":")) {
    if (dir && !seen.has(dir)) { seen.add(dir); merged.push(dir); }
  }
  cachedPath = merged.join(":");
  return cachedPath;
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

  const runCommand = options.cwd
    ? `cd -- '${options.cwd.replace(/'/g, "'\\''")}' && ${command}`
    : command;

  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(runCommand, (err, stream) => {
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
        // end() 只发 EOF，exec 通道是 allowHalfOpen 的，远端进程不退通道就一直开着——
        // 这条通道、两个 data 监听和收集到的字符串都挂到远端退出或连接断。close() 发 CHANNEL_CLOSE，
        // sshd 收到会关掉会话侧的管道（进程再写就是 SIGPIPE）。
        try { stream.close(); } catch { /* */ }
        if (settled) return;
        // 超时就按「不再等」落地：把已经收到的输出立刻返回，别等 close 事件（远端进程不退它就不来）。
        settled = true;
        stream.removeAllListeners("data");
        stream.stderr.removeAllListeners("data");
        stream.resume();
        stream.stderr.resume();
        resolve({
          stdout,
          stderr,
          exitCode: null,
          signal: undefined,
          timedOut,
          truncated,
          bytesStdout,
          bytesStderr,
        });
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
 * 命令字符串通过 $SHELL -c 解释（非交互模式，不加载 rc 文件、没有 alias）。
 *
 * 两个细节是为了不让 bash 偷偷去 source ~/.bashrc（Debian/Ubuntu 的 bash 打了 SSH_SOURCE_BASHRC 补丁：
 * 非交互 -c 且 stdin 是 socket、SHLVL<2 时会当自己是 sshd/rshd 起的、照样跑 ~/.bashrc）：
 * - 没有 stdin 内容时 stdin 用 /dev/null，不给 socket（node 的 "pipe" 底下是 socketpair）；
 * - shell 是 bash 时加 --norc。
 * 实测这台 VPS 的 ~/.bashrc 会跑 ssh-add -l 去探 mac 上转发过来的 agent，一次 500ms；
 * 起 daemon 的客户端不带 SHLVL（SDK 默认 env、cron）时每条本地命令都要多等这 500ms。
 */
/**
 * windows 上用哪个 shell 跑本地命令 —— cmd，不是 PowerShell。
 *
 * 2026-08-18 在 windows-4070ti 上把两边都实测了一遍，结论是 cmd 赢在退出码语义：
 *   - `pwsh -Command "cmd /c exit 7"` 返回的是 1，不是 7 —— 外部程序的退出码被压平。
 *     加 `; exit $LASTEXITCODE` 包装能修好原生程序那一半，但 cmdlet 本身不设
 *     $LASTEXITCODE，于是 `Get-Item 不存在的路径` 反而 exit 0 —— 失败被报成成功，
 *     比不包装更危险。
 *   - `cmd /d /s /c` 直接透传子进程的退出码（实测 exit 7 就是 7，命令不存在是 1）。
 * 退出码是 exec 通道的核心契约（isError 全靠它），不能拿它换 PowerShell 的其它好处。
 * 要 PowerShell 的结构化能力，在命令里显式写 `pwsh -NoProfile -Command "..."` 即可。
 *
 * chcp 65001 前缀解决中文乱码：daemon 是后台进程，它 spawn 出来的 cmd 默认用系统 ANSI
 * 代码页（中文 windows 是 936/GBK），输出的中文按 utf8 解码就是乱码（实测 `ver` 会变成
 * "Microsoft Windows [�汾 10.0.26200.9168]"）。`>nul` 吞掉 chcp 自己那行提示；
 * `&` 是无条件串联，ERRORLEVEL 取最后一条命令的，所以退出码不受影响（已实测）。
 *
 * 不看 process.env.SHELL：windows 上它要么没有，要么是 git-bash 设的 unix 风格路径，
 * 拿它 spawn 会 ENOENT（这就是 2.9.3 之前 windows 上 connect local 直接崩的原因）。
 */
function winShell(command: string): { shell: string; shellArgs: string[] } {
  return {
    shell: process.env.ComSpec || "cmd.exe",
    shellArgs: ["/d", "/s", "/c", `chcp 65001 >nul & ${command}`],
  };
}

export function execLocal(
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const isWin = process.platform === "win32";
  const { shell, shellArgs } = isWin
    ? winShell(command)
    : (() => {
        const sh = process.env.SHELL || "/bin/sh";
        return {
          shell: sh,
          shellArgs: /(^|\/)bash$/.test(sh) ? ["--norc", "-c", command] : ["-c", command],
        };
      })();
  const hasStdin = options.stdin !== undefined;

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(shell, shellArgs, {
        stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
        cwd: options.cwd,
        env: { ...process.env, PATH: enrichedPath() },
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
      // SIGKILL 只杀 bash -c 那个 shell；它的子孙进程还握着 stdout/stderr 管道时 close 事件不来。
      // 给 1 秒收尾，然后销毁管道（子孙再写就是 SIGPIPE）、按超时落地，别让这个 Promise 挂着。
      const settleTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.stdout?.destroy(); } catch { /* */ }
        try { child.stderr?.destroy(); } catch { /* */ }
        resolve({
          stdout,
          stderr,
          exitCode: null,
          signal: "SIGKILL",
          timedOut,
          truncated,
          bytesStdout,
          bytesStderr,
        });
      }, 1000);
      if (typeof settleTimer.unref === "function") settleTimer.unref();
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

    if (hasStdin) {
      // 命令没读完 stdin 就退出时这里会收到 EPIPE；没有 error 监听它就是未捕获异常，会把整个 daemon 打崩
      child.stdin?.on("error", () => { /* 命令提前退出，stdin 剩下的不要了 */ });
      child.stdin?.end(options.stdin);
    }
  });
}
