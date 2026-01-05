import { Client, ClientChannel } from "ssh2";
import { spawn, ChildProcess } from "child_process";
import * as pty from "node-pty";
import { ShellResult, ShellConfig } from "./types.js";

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
   * 打开本地 Shell（使用 node-pty 创建真正的 PTY）
   */
  async openLocal(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 检测系统默认 shell
        const shellPath = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh");

        // 使用 node-pty 创建真正的 PTY
        const ptyProc = pty.spawn(shellPath, [], {
          name: "xterm-256color",
          cols: 120,
          rows: 40,
          cwd: process.cwd(),
          env: process.env as { [key: string]: string },
        });

        this.ptyProcess = ptyProc;
        this.isLocal = true;

        // 创建统一的 stream 接口
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
          write: (data: string) => {
            ptyProc.write(data);
          },
          end: () => {
            ptyProc.kill();
          },
          on: ((event: string, listener: unknown) => {
            if (event === "data") {
              dataListeners.push(listener as (data: Buffer) => void);
            } else if (event === "close") {
              closeListeners.push(listener as () => void);
            } else if (event === "error") {
              errorListeners.push(listener as (err: Error) => void);
            }
          }) as ShellStream["on"],
        };

        this.shell = stream;
        this.setupStream(stream);

        // 等待初始提示符
        setTimeout(() => {
          resolve();
        }, 500);
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
   */
  async send(
    input: string,
    config?: Partial<ShellConfig>
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

    // 清空之前的输出，准备收集新输出
    const startLineCount = this.outputLines.length;
    this.outputBuffer = "";

    // 发送命令
    this.shell.write(input + "\n");

    // 等待命令完成
    return await this.waitForCompletion(startLineCount, mergedConfig);
  }

  /**
   * 读取缓冲区内容
   * @param lines 返回行数：不传默认 20 行，-1 返回全部，正整数返回对应行数
   * @param offset 起始偏移，默认 0
   * @param clear 读取后是否清空缓冲区
   */
  read(
    lines?: number,
    offset?: number,
    clear?: boolean
  ): ShellResult {
    const startIdx = offset || 0;

    // 处理 lines 参数：undefined 默认 20，-1 返回全部，其他返回指定行数
    const effectiveLines = lines === undefined ? 20 : (lines === -1 ? undefined : lines);
    const endIdx = effectiveLines ? startIdx + effectiveLines : this.outputLines.length;
    const selectedLines = this.outputLines.slice(startIdx, endIdx);

    // 包含不完整的最后一行
    let output = selectedLines.join("\n");
    if (this.outputBuffer && (!effectiveLines || endIdx >= this.outputLines.length)) {
      output += (output ? "\n" : "") + this.outputBuffer;
    }

    const result: ShellResult = {
      output,
      totalLines: this.outputLines.length + (this.outputBuffer ? 1 : 0),
      complete: true,
      message: `读取了 ${selectedLines.length} 行`,
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
   * 私有方法：等待命令完成
   */
  private async waitForCompletion(
    startLineCount: number,
    config: ShellConfig
  ): Promise<ShellResult> {
    const startTime = Date.now();
    let lastCheckTime = startTime;
    let stableCount = 0;

    return new Promise((resolve) => {
      const check = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const timeSinceLastOutput = Date.now() - this.lastOutputTime;

        // 获取新输出
        const newLines = this.outputLines.slice(startLineCount);
        const currentOutput = newLines.join("\n") +
          (this.outputBuffer ? "\n" + this.outputBuffer : "");

        // 获取最后一行用于提示符检测
        // 处理 \r（回车）：取最后一个 \r 后面的内容，因为那才是当前可见的行
        let lastLine = this.outputBuffer ||
          (newLines.length > 0 ? newLines[newLines.length - 1] : "");
        const lastCR = lastLine.lastIndexOf("\r");
        if (lastCR !== -1) {
          lastLine = lastLine.slice(lastCR + 1);
        }
        const hasPrompt = this.detectPrompt(lastLine);

        // 检测输出是否稳定（连续 3 次检查没有新输出）
        if (this.lastOutputTime <= lastCheckTime) {
          stableCount++;
        } else {
          stableCount = 0;
        }
        lastCheckTime = Date.now();

        // 策略 A: 快速 + 提示符（< 2秒）
        if (elapsed <= config.quickTimeout && hasPrompt && stableCount >= 2) {
          clearInterval(check);
          resolve(this.buildResult(
            currentOutput,
            newLines.length,
            true,
            false,
            false,
            false
          ));
          return;
        }

        // 策略 B: 慢速 + 提示符（2-5秒）
        if (elapsed > config.quickTimeout && elapsed <= config.maxTimeout && hasPrompt && stableCount >= 2) {
          clearInterval(check);
          resolve(this.buildResult(
            currentOutput,
            newLines.length,
            true,
            false,
            true,
            false
          ));
          return;
        }

        // 策略 C: 超时（> 5秒）
        if (elapsed > config.maxTimeout) {
          clearInterval(check);
          const truncated = newLines.length > config.maxLines;
          const truncatedLines = truncated
            ? newLines.slice(-config.maxLines)
            : newLines;
          const truncatedOutput = truncatedLines.join("\n") +
            (this.outputBuffer ? "\n" + this.outputBuffer : "");

          resolve(this.buildResult(
            truncatedOutput,
            newLines.length,
            hasPrompt,
            truncated,
            true,
            !hasPrompt
          ));
          return;
        }

        // 策略 D: 输出稳定但无提示符（500ms 无新输出）
        if (timeSinceLastOutput > 500 && stableCount >= 5 && elapsed > 1000) {
          clearInterval(check);
          resolve(this.buildResult(
            currentOutput,
            newLines.length,
            false,
            false,
            false,
            true
          ));
          return;
        }
      }, 100);
    });
  }

  /**
   * 私有方法：检测提示符
   */
  private detectPrompt(line: string): boolean {
    // 移除 ANSI 转义序列（更完整的正则）
    const cleanLine = line
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // 标准 ANSI 序列
      .replace(/\x1b\][^\x07]*\x07/g, "")      // OSC 序列 (如 \e]2;...\a)
      .replace(/\x1b\][^\x1b]*\x1b\\/g, "")    // OSC 序列 (如 \e]7;...\e\)
      .replace(/[\x00-\x1f]/g, "")             // 其他控制字符
      .trim();

    if (!cleanLine) return false;

    // 常见提示符模式
    const patterns = [
      /\$\s*$/,           // $ 结尾（普通用户）
      /#\s*$/,            // # 结尾（root 用户）
      />\s*$/,            // > 结尾（Windows/PowerShell）
      /\]\$\s*$/,         // ]$ 结尾（[user@host dir]$）
      /\]#\s*$/,          // ]# 结尾（[user@host dir]#）
      /\)\s*[$#>]\s*$/,   // )$ 或 )# 结尾（一些自定义 PS1）
      /~\s*[$#>]\s*$/,    // ~$ 结尾
      /@.*:\s*[$#>]\s*$/, // user@host: $ 格式
      /^➜\s+/,            // oh-my-zsh robbyrussell 主题 (➜ 开头)
      /❯\s*$/,            // pure/starship 主题
      /λ\s*$/,            // lambda 主题
      /^\s*%\s*$/,        // zsh 默认提示符
    ];

    return patterns.some((p) => p.test(cleanLine));
  }

  /**
   * 私有方法：构建结果对象
   */
  private buildResult(
    output: string,
    totalLines: number,
    complete: boolean,
    truncated: boolean,
    slow: boolean,
    waiting: boolean
  ): ShellResult {
    let message = "";

    if (complete) {
      message = slow
        ? `命令执行完成（耗时较长），共 ${totalLines} 行`
        : `命令执行完成，共 ${totalLines} 行`;
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
      message,
    };
  }
}
