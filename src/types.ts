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
}

export interface ServersConfig {
  servers: ServerConfig[];
  shortcuts?: Record<string, ShortcutConfig>;
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
  message: string;
}

export interface ShellConfig {
  quickTimeout: number;   // 快速检测超时（默认 2000ms）
  maxTimeout: number;     // 最大超时（默认 5000ms）
  maxLines: number;       // 截断行数（默认 200）
  maxBufferLines: number; // 最大缓冲（默认 10000）
}

