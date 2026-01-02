import { Client, ClientChannel } from "ssh2";
import { ShellResult, ShellConfig } from "./types.js";

const DEFAULT_CONFIG: ShellConfig = {
  quickTimeout: 2000,
  maxTimeout: 5000,
  maxLines: 200,
  maxBufferLines: 10000,
};

export class ShellManager {
  private shell: ClientChannel | null = null;
  private outputBuffer: string = "";
  private outputLines: string[] = [];
  private lastOutputTime: number = 0;
  private config: ShellConfig;

  constructor(config?: Partial<ShellConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 打开 PTY Shell（在 SSH 连接成功后调用）
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
          });

          stream.on("error", (err: Error) => {
            console.error("Shell error:", err.message);
          });

          // 等待初始提示符
          setTimeout(() => {
            resolve();
          }, 500);
        }
      );
    });
  }

  /**
   * 检查 shell 是否已打开
   */
  isOpen(): boolean {
    return this.shell !== null;
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
   */
  read(
    lines?: number,
    offset?: number,
    clear?: boolean
  ): ShellResult {
    const startIdx = offset || 0;
    const endIdx = lines ? startIdx + lines : this.outputLines.length;
    const selectedLines = this.outputLines.slice(startIdx, endIdx);

    // 包含不完整的最后一行
    let output = selectedLines.join("\n");
    if (this.outputBuffer && (!lines || endIdx >= this.outputLines.length)) {
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
    this.outputLines = [];
    this.outputBuffer = "";
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

        const lastLine = this.outputBuffer ||
          (newLines.length > 0 ? newLines[newLines.length - 1] : "");
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
    // 移除 ANSI 转义序列
    const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, "").trim();

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
