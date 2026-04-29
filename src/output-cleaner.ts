/**
 * PTY 输出清洗工具
 *
 * 原始 PTY 流里夹杂大量对模型无用的噪声：ANSI 控制序列、OSC 标题序列、
 * 命令回显的 \r[K 重绘片段、zsh 高亮 % 反白、bracketed paste 标记、
 * 末尾的 prompt 行等。这些每条返回都浪费几百到几千个 token，本模块把它们
 * 在结果出 PTY 前过滤掉。
 *
 * 内部 outputLines 仍保留原始流（用于提示符 / sentinel 检测）；只在出 PTY
 * 边界（read/send 的返回）调用 cleanOutput。
 */

const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const ANSI_OSC_BEL = /\x1b\][^\x07]*\x07/g;
const ANSI_OSC_ST = /\x1b\][^\x1b]*\x1b\\/g;
const ANSI_SIMPLE = /\x1b[=>78cM]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
  return s
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC_BEL, "")
    .replace(ANSI_OSC_ST, "")
    .replace(ANSI_SIMPLE, "");
}

/**
 * 折叠 \r：终端遇 \r 会把光标移回行首，后续字符覆盖前面，所以可见态只剩
 * 最后一个 \r 之后的部分。这一步顺带消掉了大部分 PTY 命令回显。
 *
 * 注意先剥掉结尾的 \r（标准 \r\n 行终止符的残留），否则会把整行折成空。
 */
export function foldCR(line: string): string {
  const trimmed = line.replace(/\r+$/, "");
  const idx = trimmed.lastIndexOf("\r");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function cleanLine(line: string): string {
  return foldCR(stripAnsi(line)).replace(CONTROL, "");
}

// 偏保守：只在能看出"用户名/主机/路径"上下文时认成 prompt，避免把 100$、--> 这种内容误剥
const PROMPT_PATTERNS: RegExp[] = [
  /^\s*[$#>%]\s*$/,         // 整行只有提示符（zsh 默认 %）
  /@[^\s]+.*[$#>%]\s*$/,    // user@host ... $/%/#/>
  /\][$#>%]\s*$/,           // [dir]$ / [dir]#
  /\)\s*[$#>%]\s*$/,        // (env)$
  /~[^@]*\s*[$#>%]\s*$/,    // ~ 或 ~/path 后接提示符
  /^➜\s+/,                  // oh-my-zsh robbyrussell
  /❯\s*$/,                  // pure / starship
  /λ\s*$/,                  // lambda 主题
];

export function isPromptLine(cleaned: string): boolean {
  const t = cleaned.trim();
  if (!t) return false;
  return PROMPT_PATTERNS.some((p) => p.test(t));
}

/**
 * 剥离 PTY 输出中的命令回显。仅做"按输入顺序匹配"的保守剥离，避免误伤
 * 真正的输出（典型坑：heredoc 里 input 行和 output 行字面一致）。
 *
 * 处理三种回显形态：
 * - 首行：可能裸 input、也可能 `<prompt>$ <input>`
 * - 多行命令的续行：bash/zsh 在 PS2 下回显 `> <input_line>`
 * - 复合命令：用 `\n` 分隔的多条命令，每条之前会有新的 prompt
 */
function stripCommandEcho(lines: string[], input: string): string[] {
  const inputLines = input.split("\n").map((l) => l.trim()).filter((l) => l);
  if (inputLines.length === 0) return lines;

  // 把一行 stripped 后能否对上某条 inputLine
  const matchesInput = (line: string, candidate: string): boolean => {
    const t = line.trim();
    if (t === candidate) return true;
    // 带 prompt 前缀的回显：`root@host:~# echo hello`
    const afterPrompt = line.replace(/^.*?[$#>%]\s+/, "").trim();
    if (afterPrompt === candidate) return true;
    // bash/zsh PS2 续行：`> hello`
    const afterPs2 = line.replace(/^>\s*/, "").trim();
    if (afterPs2 === candidate) return true;
    return false;
  };

  // 按 input 顺序往后扫，匹配上的行剥离（output 行原位保留）。这样能处理
  // `cmd1\ncmd2` 这种"中间夹真实输出"的多语句输入；代价是 output 中若出现
  // 字面相同的字符串可能被误剥，属可接受 trade-off。
  const drop = new Set<number>();
  let inputIdx = 0;
  for (let i = 0; i < lines.length && inputIdx < inputLines.length; i++) {
    if (matchesInput(lines[i], inputLines[inputIdx])) {
      drop.add(i);
      inputIdx++;
    }
  }
  return lines.filter((_, idx) => !drop.has(idx));
}

/**
 * 完整清洗管线：
 * 1. 每行 stripAnsi + foldCR + 控制字符过滤
 * 2. 剥离任何含 sentinel 标记的行（包括 sentinel printf 命令的回显与实际输出）
 * 3. 剥离命令回显行（按输入顺序匹配，避免误剥 heredoc body）
 * 4. 剥离首尾空行
 * 5. 剥离尾部连续的 prompt 行
 *
 * @param sentinelMarker 用于子串匹配剥离的标记（一般传 nonce）。会同时滤掉
 *                       printf 命令本身（含 `%d` 占位符）和 printf 输出（含实际 rc）。
 * @param echoInput      用户输入字符串。用于命令回显剥离。
 */
export function cleanOutput(
  rawLines: string[],
  options: { sentinelMarker?: string; echoInput?: string } = {}
): string[] {
  let lines = rawLines.map(cleanLine);

  if (options.sentinelMarker) {
    const marker = options.sentinelMarker;
    lines = lines.filter((l) => !l.includes(marker));
  }

  if (options.echoInput) {
    lines = stripCommandEcho(lines, options.echoInput);
  }

  while (lines.length > 0 && lines[0].trim() === "") lines.shift();

  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() === "" || isPromptLine(last)) {
      lines.pop();
    } else {
      break;
    }
  }

  return lines;
}
