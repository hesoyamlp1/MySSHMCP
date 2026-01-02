export interface ServerConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ServersConfig {
  servers: ServerConfig[];
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

