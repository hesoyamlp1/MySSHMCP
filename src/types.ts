export interface ProxyConfig {
  host: string;
  port: number;
  type?: 4 | 5;  // SOCKS4 或 SOCKS5，默认 5
  username?: string;
  password?: string;
}

export interface ProxyJumpConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ShortcutArg {
  name: string;
  description?: string;
  enum?: string[];
  default?: string;
}

export interface ShortcutConfig {
  command: string;
  stdin?: string;
  description?: string;
  runsOn?: string;
  args?: ShortcutArg[];
  secrets?: Record<string, string>;
}

export interface ServerConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  sudoPassword?: string;
  proxy?: ProxyConfig;
  proxyJump?: ProxyJumpConfig;
  shortcuts?: Record<string, ShortcutConfig>;
  /**
   * 连接该服务器时注入到 connect 响应的指令性提示（区别于描述性的 notes）
   * 例如 "部署这台必须走 deploy_kg shortcut，不要手动 cp jar"
   */
  hints?: string | string[];
}

export interface ServersConfig {
  servers: ServerConfig[];
  shortcuts?: Record<string, ShortcutConfig>;
  /**
   * 内建 local shell 专属的 shortcut。与全局 shortcuts 合并后对 local 生效，
   * 同名时 localShortcuts 覆盖全局。
   */
  localShortcuts?: Record<string, ShortcutConfig>;
  /**
   * 全局指令性提示。会注入到 list 和 connect 响应里。
   * 用于告诉模型"跨工具/跨机器"层面的决策要点，例如：
   * - "VPS 与 mac 都注册了 SSH MCP，跨机传文件优先用离源/目标最近的 MCP"
   * - "部署用 deploy_kg shortcut，不要手动 cp jar"
   */
  globalHints?: string | string[];
  /**
   * local shell 专属的指令性提示（只在连 local 时生效）。
   */
  localHints?: string | string[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ConnectionStatus {
  connected: boolean;
  serverName: string | null;
  host: string | null;
  username: string | null;
}

export interface ShellResult {
  output: string;
  totalLines: number;
  complete: boolean;
  truncated?: boolean;
  slow?: boolean;
  waiting?: boolean;
  /**
   * 命令退出码。仅在 sentinel 模式（非 interactive）成功捕获时填充。
   * undefined 表示无法判定（交互式 / 超时 / sentinel 丢失）。
   */
  exitCode?: number;
  message: string;
}

export interface ShellConfig {
  quickTimeout: number;   // 快速检测超时（默认 2000ms）
  maxTimeout: number;     // 最大超时（默认 5000ms）
  maxLines: number;       // 截断行数（默认 200）
  maxBufferLines: number; // 最大缓冲（默认 10000）
}

