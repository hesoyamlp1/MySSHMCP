import { randomBytes } from "crypto";
import { ShortcutConfig } from "./types.js";

const PLACEHOLDER_RE = /\{\{\s*(args|secret)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * 用单引号安全包裹一个字符串作为 shell 参数。
 * 内部 ' 转义为 '\''。
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ParsedPlaceholders {
  args: Set<string>;
  secrets: Set<string>;
}

/**
 * 扫描一段或多段模板里的 {{args.X}} 和 {{secret.X}} 占位符。
 */
export function parsePlaceholders(...templates: (string | undefined)[]): ParsedPlaceholders {
  const args = new Set<string>();
  const secrets = new Set<string>();
  for (const tpl of templates) {
    if (!tpl) continue;
    for (const m of tpl.matchAll(PLACEHOLDER_RE)) {
      if (m[1] === "args") args.add(m[2]);
      else secrets.add(m[2]);
    }
  }
  return { args, secrets };
}

/**
 * 静态校验单个 shortcut 的模板与声明的 args / secrets 是否一致，
 * 以及 enum/default 的合法性。在 ConfigManager.load() 后调用，发现问题立即抛错。
 */
export function validateShortcut(serverName: string, shortcutName: string, cfg: ShortcutConfig): void {
  const { args: refArgs, secrets: refSecrets } = parsePlaceholders(cfg.command, cfg.stdin);
  const declaredArgs = new Set((cfg.args ?? []).map((a) => a.name));
  const declaredSecrets = new Set(Object.keys(cfg.secrets ?? {}));

  for (const a of refArgs) {
    if (!declaredArgs.has(a)) {
      throw new Error(
        `服务器 '${serverName}' 的 shortcut '${shortcutName}' 模板引用了 {{args.${a}}}，但 args 数组里没有声明该参数`
      );
    }
  }
  for (const s of refSecrets) {
    if (!declaredSecrets.has(s)) {
      throw new Error(
        `服务器 '${serverName}' 的 shortcut '${shortcutName}' 模板引用了 {{secret.${s}}}，但 secrets 里没有定义该键`
      );
    }
  }

  // enum / default 静态校验
  for (const arg of cfg.args ?? []) {
    if (arg.enum && arg.enum.length === 0) {
      throw new Error(
        `服务器 '${serverName}' 的 shortcut '${shortcutName}' 的参数 '${arg.name}' 的 enum 不能为空数组`
      );
    }
    if (arg.enum && arg.default !== undefined && !arg.enum.includes(arg.default)) {
      throw new Error(
        `服务器 '${serverName}' 的 shortcut '${shortcutName}' 的参数 '${arg.name}' 的 default '${arg.default}' 不在 enum [${arg.enum.join(", ")}] 范围内`
      );
    }
  }
}

/**
 * 按占位符渲染一段模板。escape=true 时 args/secrets 走 shell-escape；
 * escape=false 时（heredoc 内）保持字面量。
 * dryRun=true 时，secrets 渲染为 <secret:NAME> 占位符，而不是真实值。
 */
function renderTemplate(
  template: string,
  effectiveArgs: Record<string, string>,
  secrets: Record<string, string>,
  escape: boolean,
  dryRun: boolean
): string {
  return template.replace(PLACEHOLDER_RE, (_match, kind: string, name: string) => {
    if (kind === "args") {
      const value = effectiveArgs[name];
      return escape ? shellQuote(value) : value;
    }
    // secret
    if (dryRun) {
      const placeholder = `<secret:${name}>`;
      return escape ? shellQuote(placeholder) : placeholder;
    }
    const value = secrets[name] ?? "";
    return escape ? shellQuote(value) : value;
  });
}

/**
 * 生成一个 heredoc delimiter，确保不和 stdin 内容碰撞。
 */
function generateDelimiter(stdinContent: string): string {
  for (let i = 0; i < 8; i++) {
    const suffix = randomBytes(3).toString("hex"); // 6 个 hex 字符
    const delim = `MORI_EOF_${suffix}`;
    if (!stdinContent.includes(delim)) return delim;
  }
  // 极不可能走到这里，兜底用更长的后缀
  return `MORI_EOF_${randomBytes(8).toString("hex")}`;
}

export type RenderMode = "execute" | "dryRun";

/**
 * 分离形式的渲染结果：command 和 stdin 各自字符串，由调用方决定怎么投递：
 * - 老路径：拼成 heredoc 灌进 PTY
 * - 新路径：command 走 exec 通道，stdin 直接喂给 channel
 */
export interface RenderedShortcut {
  command: string;
  stdin?: string;
}

/**
 * 渲染 shortcut（分离形式，推荐）。
 * - command 中的 args/secrets 会被 shell-escape（用单引号包裹）
 * - stdin 中的 args/secrets 保持字面量（不 escape，因为不再走 shell 解析）
 * - dryRun 模式：secrets 渲染为 <secret:NAME> 占位符
 */
export function renderShortcutSplit(
  shortcutName: string,
  cfg: ShortcutConfig,
  callerArgs: Record<string, string>,
  mode: RenderMode = "execute"
): RenderedShortcut {
  const declaredArgs = cfg.args ?? [];
  const declaredArgNames = new Set(declaredArgs.map((a) => a.name));

  // 1. 拒绝未声明的 caller 参数
  const unknown: string[] = [];
  for (const k of Object.keys(callerArgs)) {
    if (!declaredArgNames.has(k)) unknown.push(k);
  }
  if (unknown.length > 0) {
    throw new Error(
      `shortcut '${shortcutName}' 收到未声明的参数: ${unknown.join(", ")}（声明的参数: ${[...declaredArgNames].join(", ") || "无"}）`
    );
  }

  // 2. 应用 default
  const effectiveArgs: Record<string, string> = {};
  for (const arg of declaredArgs) {
    if (callerArgs[arg.name] !== undefined) {
      effectiveArgs[arg.name] = callerArgs[arg.name];
    } else if (arg.default !== undefined) {
      effectiveArgs[arg.name] = arg.default;
    }
  }

  // 3. 缺参检查（应用 default 之后）
  const { args: refArgs } = parsePlaceholders(cfg.command, cfg.stdin);
  const missing: string[] = [];
  for (const a of refArgs) {
    if (effectiveArgs[a] === undefined) missing.push(a);
  }
  if (missing.length > 0) {
    throw new Error(`shortcut '${shortcutName}' 缺少参数: ${missing.join(", ")}`);
  }

  // 4. enum 动态校验
  for (const arg of declaredArgs) {
    const value = effectiveArgs[arg.name];
    if (value !== undefined && arg.enum && !arg.enum.includes(value)) {
      throw new Error(
        `shortcut '${shortcutName}' 参数 '${arg.name}' 必须是 [${arg.enum.join(", ")}] 之一，收到 '${value}'`
      );
    }
  }

  const secrets = cfg.secrets ?? {};
  const dryRun = mode === "dryRun";

  const command = renderTemplate(cfg.command, effectiveArgs, secrets, true, dryRun);
  if (cfg.stdin === undefined) {
    return { command };
  }
  const stdin = renderTemplate(cfg.stdin, effectiveArgs, secrets, false, dryRun);
  return { command, stdin };
}

/**
 * 兼容老接口：返回拼成 heredoc 的单字符串（dryRun 展示用 / 走 PTY 兜底用）。
 * 新代码请用 renderShortcutSplit。
 */
export function renderShortcut(
  shortcutName: string,
  cfg: ShortcutConfig,
  callerArgs: Record<string, string>,
  mode: RenderMode = "execute"
): string {
  const { command, stdin } = renderShortcutSplit(shortcutName, cfg, callerArgs, mode);
  if (stdin === undefined) return command;
  const delim = generateDelimiter(stdin);
  return `${command} <<'${delim}'\n${stdin}\n${delim}`;
}
