import { Client, ClientChannel } from "ssh2";
import { spawn, ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import * as pty from "node-pty";
import { ShellResult, ShellConfig } from "./types.js";
import { cleanOutput, cleanLine, isPromptLine } from "./output-cleaner.js";

export interface SendOptions {
  /**
   * 交互式模式：跳过 sentinel 包装。用于启动 REPL（mysql、python、ssh 跳板）
   * 或向 REPL 内输入子命令。默认 false（包装 sentinel + 拿 exitCode）。
   */
  interactive?: boolean;
}

const DEFAULT_CONFIG: ShellConfig = {
  quickTimeout: 2000,
  maxTimeout: 5000,
  maxLines: 200,
  maxBufferLines: 10000,
};

interface ShellStream {
  write(data: string): void;
  end(): void;
  on(event: "data", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

export class ShellManager {
  private shell: ShellStream | null = null;
  private localProcess: ChildProcess | null = null;
  private ptyProcess: pty.IPty | null = null;
  private outputBuffer: string = "";
  private outputLines: string[] = [];
  private lastOutputTime: number = 0;
  private config: ShellConfig;
  private isLocal: boolean = false;

  constructor(config?: Partial<ShellConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 打开远程 PTY Shell（在 SSH 连接成功后调用）
   */
  async open(client: Client): Promise<void> {
    return new Promise((resolve, reject) => {
      client.shell(
        { term: "xterm-256color", rows: 40, cols: 120 },
        (err, stream) => {
          if (err) {
            reject(new Error(`无法打开 shell: ${err.message}`));
            return;
          }

          this.shell = stream;
          this.isLocal = false;
          this.setupStream(stream);

          // 等待初始提示符
          setTimeout(() => {
            resolve();
          }, 500);
        }
      );
    });
  }

  /**
   * 打开本地 Shell（使用 node-pty 创建真正的 PTY）。
   * PTY 申请失败时抛错，由调用方（SSHManager.connectLocal）决定是否降级。
   */
  async openLocal(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const shellPath = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");

        const ptyProc = pty.spawn(shellPath, [], {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd: process.cwd(),
          env: process.env as { [key: string]: string },
        });

        this.ptyProcess = ptyProc;
        this.isLocal = true;

        const dataListeners: ((data: Buffer) => void)[] = [];
        const closeListeners: (() => void)[] = [];
        const errorListeners: ((err: Error) => void)[] = [];

        ptyProc.onData((data: string) => {
          dataListeners.forEach((l) => l(Buffer.from(data)));
        });
        ptyProc.onExit(() => {
          closeListeners.forEach((l) => l());
        });

        const stream: ShellStream = {
          write: (data: string) => ptyProc.write(data),
          end: () => ptyProc.kill(),
          on: ((event: string, listener: unknown) => {
            if (event === "data") dataListeners.push(listener as (data: Buffer) => void);
            else if (event === "close") closeListeners.push(listener as () => void);
            else if (event === "error") errorListeners.push(listener as (err: Error) => void);
          }) as ShellStream["on"],
        };

        this.shell = stream;
        this.setupStream(stream);

        setTimeout(() => resolve(), 500);
      } catch (error) {
        reject(new Error(`无法打开本地 shell: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /**
   * 设置 stream 的事件监听
   */
  private setupStream(stream: ShellStream): void {
    this.outputBuffer = "";
    this.outputLines = [];
    this.lastOutputTime = Date.now();

    // 监听数据事件
    stream.on("data", (data: Buffer) => {
      const text = data.toString();
      this.outputBuffer += text;
      this.lastOutputTime = Date.now();

      // 按行分割并存储
      const lines = this.outputBuffer.split("\n");
      // 最后一个可能是不完整的行，保留在 buffer
      this.outputBuffer = lines.pop() || "";
      this.outputLines.push(...lines);

      // 限制缓冲区大小
      if (this.outputLines.length > this.config.maxBufferLines) {
        this.outputLines = this.outputLines.slice(-this.config.maxBufferLines);
      }
    });

    // 监听关闭事件
    stream.on("close", () => {
      this.shell = null;
      this.localProcess = null;
      this.ptyProcess = null;
    });

    stream.on("error", (err: Error) => {
      console.error("Shell error:", err.message);
    });
  }

  /**
   * 检查 shell 是否已打开
   */
  isOpen(): boolean {
    return this.shell !== null;
  }

  /**
   * 是否是本地 shell
   */
  isLocalShell(): boolean {
    return this.isLocal;
  }

  /**
   * 发送命令，智能等待完成
   *
   * 默认模式（非 interactive）：在用户命令后追加一条 sentinel printf，
   * 出现 `__MCP_DONE_<nonce>_<rc>__` 字样即视为完成，并捕获 exit code。
   * 这绕开了 prompt 正则永远列不全的结构问题。
   *
   * interactive=true：仅写入用户输入，不追加 sentinel。用于 REPL 启动 / REPL 内输入。
   */
  async send(
    input: string,
    config?: Partial<ShellConfig>,
    options?: SendOptions
  ): Promise<ShellResult> {
    if (!this.shell) {
      return {
        output: "",
        totalLines: 0,
        complete: false,
        message: "Shell 未打开，请先连接服务器",
      };
    }

    const mergedConfig = { ...this.config, ...config };
    const interactive = options?.interactive ?? false;

    const startLineCount = this.outputLines.length;
    this.outputBuffer = "";

    let sentinelNonce: string | undefined;
    let sentinelRegex: RegExp | undefined;
    if (interactive) {
      this.shell.write(input + "\n");
    } else {
      sentinelNonce = randomBytes(8).toString("hex");
      sentinelRegex = new RegExp(`__MCP_DONE_${sentinelNonce}_(\\d+)__`);
      const sentinelCmd = `__MCP_RC=$?; printf '\\n__MCP_DONE_${sentinelNonce}_%d__\\n' "$__MCP_RC"`;
      this.shell.write(input + "\n" + sentinelCmd + "\n");
    }

    return await this.waitForCompletion(startLineCount, mergedConfig, sentinelRegex, sentinelNonce, input);
  }

  /**
   * 读取缓冲区内容（默认清洗 ANSI / 命令回显 / prompt）
   * @param lines 返回行数：不传默认 20 行，-1 返回全部，正整数返回对应行数
   * @param offset 起始偏移，默认 0
   * @param clear 读取后是否清空缓冲区
   * @param raw  true 时返回未清洗的原始 PTY 流（调试用）
   */
  read(
    lines?: number,
    offset?: number,
    clear?: boolean,
    raw?: boolean
  ): ShellResult {
    const startIdx = offset || 0;

    const effectiveLines = lines === undefined ? 20 : (lines === -1 ? undefined : lines);
    const endIdx = effectiveLines ? startIdx + effectiveLines : this.outputLines.length;
    const selectedLines = this.outputLines.slice(startIdx, endIdx);

    let outLines: string[];
    let trailingBuffer = "";
    if (this.outputBuffer && (!effectiveLines || endIdx >= this.outputLines.length)) {
      trailingBuffer = this.outputBuffer;
    }

    if (raw) {
      outLines = selectedLines.slice();
      if (trailingBuffer) outLines.push(trailingBuffer);
    } else {
      const merged = trailingBuffer ? [...selectedLines, trailingBuffer] : selectedLines;
      outLines = cleanOutput(merged);
    }

    const output = outLines.join("\n");

    const result: ShellResult = {
      output,
      totalLines: this.outputLines.length + (this.outputBuffer ? 1 : 0),
      complete: true,
      message: `读取了 ${selectedLines.length} 行${raw ? "（raw）" : ""}`,
    };

    if (clear) {
      this.outputLines = [];
      this.outputBuffer = "";
    }

    return result;
  }

  /**
   * 发送信号
   */
  sendSignal(signal: "SIGINT" | "SIGTSTP" | "SIGQUIT"): boolean {
    if (!this.shell) {
      return false;
    }

    // 通过写入控制字符来模拟信号
    const signalChars: Record<string, string> = {
      SIGINT: "\x03",   // Ctrl+C
      SIGTSTP: "\x1a",  // Ctrl+Z
      SIGQUIT: "\x1c",  // Ctrl+\
    };

    const char = signalChars[signal];
    if (char) {
      this.shell.write(char);
      return true;
    }
    return false;
  }

  /**
   * 强制复位当前行：发 Ctrl-C → 短暂等待 → Ctrl-U → 换行。
   * 用于卡在 heredoc> / dquote> / cmdand 等续行 prompt 时。
   * 故意不发 Ctrl-D（会把 shell 关掉）。
   */
  async resetLine(): Promise<boolean> {
    if (!this.shell) return false;
    this.shell.write("\x03");           // 中断当前命令 / 退出续行 prompt
    await new Promise((r) => setTimeout(r, 80));
    if (!this.shell) return false;
    this.shell.write("\x15\n");         // 清空行缓冲 + 拿一个干净 prompt
    return true;
  }

  /**
   * 用一个外部提供的"重开 shell"回调来重置。该回调由 SSHManager 注入：
   * 它知道当前是 local pty 还是 ssh client，由它决定重开方式。
   * 此处只负责关掉旧 shell 并清空缓冲区。
   */
  async hardReset(reopen: () => Promise<void>): Promise<void> {
    if (this.shell) {
      try { this.shell.end(); } catch { /* ignore */ }
    }
    this.shell = null;
    this.localProcess = null;
    this.ptyProcess = null;
    this.outputBuffer = "";
    this.outputLines = [];
    await reopen();
  }

  /**
   * 关闭 shell
   */
  close(): void {
    if (this.shell) {
      this.shell.end();
      this.shell = null;
    }
    if (this.localProcess) {
      this.localProcess.kill();
      this.localProcess = null;
    }
    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }
    this.outputLines = [];
    this.outputBuffer = "";
    this.isLocal = false;
  }

  /**
   * 获取当前缓冲区行数
   */
  getBufferLineCount(): number {
    return this.outputLines.length + (this.outputBuffer ? 1 : 0);
  }

  /**
   * 扫描新输出（已收集的行 + 当前 buffer）寻找 sentinel，找到则返回 exit code
   */
  private scanSentinel(
    startLineCount: number,
    sentinelRegex: RegExp
  ): number | null {
    for (let i = startLineCount; i < this.outputLines.length; i++) {
      const m = sentinelRegex.exec(this.outputLines[i]);
      if (m) return parseInt(m[1], 10);
    }
    if (this.outputBuffer) {
      const m = sentinelRegex.exec(this.outputBuffer);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  /**
   * 等待命令完成。两种模式：
   * - sentinel 模式（sentinelRegex 非空）：见到 sentinel 立刻完成，捕获 exit code
   * - interactive 模式（sentinelRegex 为空）：回退到 prompt + stable-output 启发式
   */
  private async waitForCompletion(
    startLineCount: number,
    config: ShellConfig,
    sentinelRegex: RegExp | undefined,
    sentinelNonce: string | undefined,
    echoInput: string
  ): Promise<ShellResult> {
    const startTime = Date.now();
    let lastCheckTime = startTime;
    let stableCount = 0;

    return new Promise((resolve) => {
      const check = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const timeSinceLastOutput = Date.now() - this.lastOutputTime;

        const newLines = this.outputLines.slice(startLineCount);

        // ---- sentinel 模式：100% 确定性完成 ----
        if (sentinelRegex) {
          const rc = this.scanSentinel(startLineCount, sentinelRegex);
          if (rc !== null) {
            clearInterval(check);
            const slow = elapsed > config.quickTimeout;
            resolve(
              this.buildResult({
                rawNewLines: newLines,
                trailingBuffer: this.outputBuffer,
                totalLines: newLines.length,
                complete: true,
                truncated: false,
                slow,
                waiting: false,
                exitCode: rc,
                sentinelMarker: sentinelNonce,
                echoInput,
              })
            );
            return;
          }
        }

        // ---- 回退：prompt 检测（interactive 或 sentinel 丢失时兜底）----
        let lastLine = this.outputBuffer ||
          (newLines.length > 0 ? newLines[newLines.length - 1] : "");
        const cleaned = cleanLine(lastLine);
        const hasPrompt = isPromptLine(cleaned);

        if (this.lastOutputTime <= lastCheckTime) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        lastCheckTime = Date.now();

        // interactive 模式：A/B 策略沿用 prompt 检测
        if (!sentinelRegex) {
          if (elapsed <= config.quickTimeout && hasPrompt && stableCount >= 2) {
            clearInterval(check);
            resolve(this.buildResult({
              rawNewLines: newLines,
              trailingBuffer: this.outputBuffer,
              totalLines: newLines.length,
              complete: true,
              truncated: false,
              slow: false,
              waiting: false,
              echoInput,
            }));
            return;
          }
          if (elapsed > config.quickTimeout && elapsed <= config.maxTimeout && hasPrompt && stableCount >= 2) {
            clearInterval(check);
            resolve(this.buildResult({
              rawNewLines: newLines,
              trailingBuffer: this.outputBuffer,
              totalLines: newLines.length,
              complete: true,
              truncated: false,
              slow: true,
              waiting: false,
              echoInput,
            }));
            return;
          }
        }

        // C: 超时（适用于 sentinel 丢失 / interactive 卡住）
        if (elapsed > config.maxTimeout) {
          clearInterval(check);
          const truncated = newLines.length > config.maxLines;
          const truncatedLines = truncated ? newLines.slice(-config.maxLines) : newLines;
          resolve(this.buildResult({
            rawNewLines: truncatedLines,
            trailingBuffer: this.outputBuffer,
            totalLines: newLines.length,
            complete: hasPrompt,
            truncated,
            slow: true,
            waiting: !hasPrompt,
            sentinelMarker: sentinelNonce,
            echoInput,
          }));
          return;
        }

        // D: 输出稳定但无提示符（仅 interactive 模式启用，sentinel 模式只等 sentinel/超时）
        if (!sentinelRegex) {
          const silenceThreshold = config.maxTimeout > DEFAULT_CONFIG.maxTimeout
            ? Math.min(config.maxTimeout * 0.2, 10000)
            : 500;
          const stableThreshold = config.maxTimeout > DEFAULT_CONFIG.maxTimeout ? 10 : 5;
          const minElapsed = config.maxTimeout > DEFAULT_CONFIG.maxTimeout
            ? Math.min(config.maxTimeout * 0.5, 30000)
            : 1000;
          if (timeSinceLastOutput > silenceThreshold && stableCount >= stableThreshold && elapsed > minElapsed) {
            clearInterval(check);
            resolve(this.buildResult({
              rawNewLines: newLines,
              trailingBuffer: this.outputBuffer,
              totalLines: newLines.length,
              complete: false,
              truncated: false,
              slow: false,
              waiting: true,
              echoInput,
            }));
            return;
          }
        }
      }, 100);
    });
  }

  /**
   * 构建结果对象 —— 输出在此处经清洗管线（ANSI / 命令回显 / sentinel / prompt）后返回
   */
  private buildResult(args: {
    rawNewLines: string[];
    trailingBuffer: string;
    totalLines: number;
    complete: boolean;
    truncated: boolean;
    slow: boolean;
    waiting: boolean;
    exitCode?: number;
    sentinelMarker?: string;
    echoInput: string;
  }): ShellResult {
    const { rawNewLines, trailingBuffer, totalLines, complete, truncated, slow, waiting, exitCode, sentinelMarker } = args;

    const merged = trailingBuffer ? [...rawNewLines, trailingBuffer] : rawNewLines;
    const cleanedLines = cleanOutput(merged, { sentinelMarker, echoInput: args.echoInput });
    const output = cleanedLines.join("\n");

    let message: string;
    if (complete) {
      const rcSuffix = exitCode !== undefined ? `，exit=${exitCode}` : "";
      message = slow
        ? `命令执行完成（耗时较长），共 ${totalLines} 行${rcSuffix}`
        : `命令执行完成，共 ${totalLines} 行${rcSuffix}`;
    } else if (truncated) {
      message = `输出超时，已截断至最近 ${this.config.maxLines} 行（共 ${totalLines} 行）。使用 read 获取完整输出。`;
    } else if (waiting) {
      message = `输出已稳定，命令可能在等待输入或仍在运行。共 ${totalLines} 行。`;
    } else {
      message = `共 ${totalLines} 行`;
    }

    return {
      output,
      totalLines,
      complete,
      truncated: truncated || undefined,
      slow: slow || undefined,
      waiting: waiting || undefined,
      exitCode,
      message,
    };
  }
}
