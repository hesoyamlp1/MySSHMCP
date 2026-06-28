import { z } from "zod";

/**
 * ssh / sftp 两个工具的 inputSchema 形状（zod shape）。
 * 直连模式（tools.ts）和 hub 模式（hub.ts）共用同一份参数定义，
 * hub 只在此基础上多加一个 node 参数。
 */

export const SSH_INPUT_SHAPE = {
  action: z
    .enum(["list", "connect", "disconnect", "status", "notes", "sudo", "shortcuts", "reset_shell"])
    .optional()
    .describe("连接管理操作；reset_shell 关掉当前 PTY 重开一条（保留 SSH 连接）"),
  server: z.string().optional().describe("服务器名称（connect 时必填）"),
  content: z.string().optional().describe("备注内容（notes 写入时使用）"),
  command: z.string().optional().describe("要执行的命令。默认走 exec 通道：一发一收、独立、直接返回 stdout/stderr/exitCode，输出无需清洗、绝不会卡死 session。只有 mode:\"pty\"（或 interactive:true）才进持久 PTY shell——见 mode 参数。"),
  timeout: z.number().optional().describe("命令最大等待时间（秒），默认 5，最大 300。对于 pip install、apt upgrade 等长时间命令建议设置较大值"),
  read: z.boolean().optional().describe("读取缓冲区"),
  lines: z.number().optional().describe("读取行数，默认 20，-1 返回全部"),
  offset: z.number().optional().describe("读取起始偏移，默认 0"),
  clear: z.boolean().optional().describe("读取后清空缓冲区"),
  signal: z
    .enum(["SIGINT", "SIGTSTP", "SIGQUIT", "RESET"])
    .optional()
    .describe("发送信号：SIGINT/SIGTSTP/SIGQUIT 单字符；RESET 是组合（Ctrl-C + Ctrl-U + 换行）专治续行 prompt 卡死"),
  shortcut: z.string().optional().describe("要执行的 shortcut 名称（运维预配置的命名命令）"),
  args: z.record(z.string()).optional().describe("shortcut 参数键值对，会被自动 shell-escape"),
  dryRun: z.boolean().optional().describe("仅用于 shortcut：渲染但不执行，secrets 显示为占位符"),
  interactive: z.boolean().optional().describe("仅 pty 模式：启动 REPL（mysql/python/redis-cli）或向 REPL 内输入子命令时设 true，跳过 sentinel 包装。设了它即隐含 mode:\"pty\""),
  mode: z.enum(["exec", "pty"]).optional().describe("执行通道。exec（默认）：一次性、无状态、独立通道，直接拿 stdout/stderr/exitCode，无 PTY 产物、绝不会被 heredoc/续行符卡死——绝大多数命令用它。pty：持久 PTY shell，跨命令继承 cwd/env，用于交互式 REPL、TUI(vim/top/less)、tail -f + Ctrl-C、必须保留 shell 状态的多步操作。signal/read/reset_shell/interactive 都隐含 pty；PTY 在首次 pty 调用时懒加载。⚠️ 仅 pty 模式有 heredoc/未闭合引号→卡 heredoc>/quote> 的风险：pty 下绝不内联 heredoc 或留未闭合引号/反斜杠/行尾管道，多行内容用 sftp.write 或（默认 exec 通道的）stdin。"),
  raw: z.boolean().optional().describe("仅用于 read：返回未清洗的原始 PTY 流（含 ANSI/控制序列），调试用"),
  stdin: z.string().optional().describe("通过 stdin 喂给命令的字面量内容，在 exec 通道（默认）下生效，适合多行 yaml/sql/python（python3 - / kubectl apply -f - / psql / jq）"),
  exec: z.boolean().optional().describe("已废弃别名，等价 mode:\"exec\"（现已是默认）。新代码请用 mode"),
  onlineOnly: z.boolean().optional().describe("仅用于 list：只返回当前在线（端口探活通过、反向隧道已连）的机器"),
};

export const SFTP_INPUT_SHAPE = {
  action: z
    .enum(["upload", "download", "write", "read"])
    .describe("操作：upload/download 文件互传，write/read 内联文本读写"),
  localPath: z.string().optional().describe("本地文件路径（upload/download 用）"),
  remotePath: z.string().optional().describe("远端文件路径（upload/download 用）"),
  path: z.string().optional().describe("目标路径（write/read 用，自动按当前连接判断 local/远端）"),
  content: z.string().optional().describe("要写入的文本（write 必填）"),
  mode: z.number().optional().describe("权限位十进制数（write 可选，默认 420 即 0o644；可执行用 493 = 0o755）"),
  mkdirs: z.boolean().optional().describe("write 时父目录不存在自动建（默认 false）"),
  maxBytes: z.number().optional().describe("read 时最大字节数（默认 1048576）"),
};
