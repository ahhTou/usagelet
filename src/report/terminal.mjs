// ccusage-terminal 的显示宽度、截断、ANSI 处理、颜色与终端宽度规则（ccusage 20.0.21）。
import { charWidth } from './unicode-width.mjs';
import { rustLines } from './text.mjs';

const ESC = 0x1b;
const isAsciiAlpha = (c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** skip_ansi_escape：ESC 后若是 '['，吞到首个 ASCII 字母（含）；否则只跳过 ESC。 */
function skipAnsiEscape(value, index) {
  index += 1;
  if (index < value.length && value.charCodeAt(index) === 0x5b) {
    index += 1;
    while (index < value.length && !isAsciiAlpha(value.charCodeAt(index))) index += 1;
    if (index < value.length) index += 1;
  }
  return index;
}

/** visible_width：跳过 ANSI 转义后各字符宽度之和。 */
export function visibleWidth(value) {
  let width = 0;
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === ESC) {
      index = skipAnsiEscape(value, index);
      continue;
    }
    const cp = value.codePointAt(index);
    width += charWidth(cp);
    index += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/** visible_width_max_line：多行文本中最宽一行的宽度。 */
export const visibleWidthMaxLine = (value) =>
  rustLines(value).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);

const containsAnsi = (value) => value.includes('\x1b');

/** ansi_continuation：截至文本末尾仍生效的 SGR 序列（遇到 \x1b[0m 清空）。 */
export function ansiContinuation(value) {
  let continuation = '';
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) !== ESC) {
      index += value.codePointAt(index) > 0xffff ? 2 : 1;
      continue;
    }
    const end = skipAnsiEscape(value, index);
    const escape = value.slice(index, end);
    if (escape.endsWith('m')) {
      if (escape === '\x1b[0m') continuation = '';
      else continuation += escape;
    }
    index = end;
  }
  return continuation;
}

/** ensure_ansi_reset：含转义且不以 \x1b[0m 结尾时补一个重置。 */
export const ensureAnsiReset = (value) =>
  !containsAnsi(value) || value.endsWith('\x1b[0m') ? value : `${value}\x1b[0m`;

/** truncate_to_width：截到不超过 width 列，用 … 标记截断，转义序列原样保留且不占宽度。 */
export function truncateToWidth(value, width) {
  if (visibleWidth(value) <= width) return value;
  if (width === 0) return '';
  if (width === 1) return '…';
  let output = '';
  let current = 0;
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === ESC) {
      const start = index;
      index = skipAnsiEscape(value, index);
      output += value.slice(start, index);
      continue;
    }
    const cp = value.codePointAt(index);
    const w = charWidth(cp);
    // 提前一列停下，给省略号留位置。
    if (current + w >= width) break;
    const size = cp > 0xffff ? 2 : 1;
    output += value.slice(index, index + size);
    current += w;
    index += size;
  }
  if (containsAnsi(value) && !output.endsWith('\x1b[0m')) output += '\x1b[0m';
  return output + '…';
}

export const COLORS = { blue: 34, green: 32, grey: 90, red: 31, yellow: 33 };

/**
 * use_color：--no-color 或存在 NO_COLOR 时关闭；否则 --color、存在 FORCE_COLOR 或 stdout 是 TTY 时开启。
 * 环境变量只看是否存在（空字符串也算）。
 */
export function useColor({ color = false, noColor = false, env = process.env, isTTY } = {}) {
  if (noColor || env.NO_COLOR !== undefined) return false;
  return Boolean(
    color || env.FORCE_COLOR !== undefined || (isTTY ?? process.stdout.isTTY === true),
  );
}

/** color：开启颜色时包上 \x1b[<code>m … \x1b[0m。 */
export const paint = (enabled, value, name) =>
  enabled ? `\x1b[${COLORS[name]}m${value}\x1b[0m` : value;

/** Rust 无符号整数 FromStr：可带一个前导 +，只允许 ASCII 数字，溢出即失败。 */
export function parseUnsigned(value, max) {
  if (typeof value !== 'string' || !/^\+?[0-9]+$/.test(value)) return undefined;
  const parsed = BigInt(value.startsWith('+') ? value.slice(1) : value);
  return parsed <= max ? parsed : undefined;
}

/** log_level：LOG_LEVEL 解析为 u8，失败为 undefined。 */
export function logLevel(env = process.env) {
  const parsed = parseUnsigned(env.LOG_LEVEL, 255n);
  return parsed === undefined ? undefined : Number(parsed);
}

export const DEFAULT_TERMINAL_WIDTH = 120;

/** 检测到的终端宽度：terminal_size 依次看 stdout、stderr（stdin 在 Node 中取不到窗口尺寸）。 */
export function detectTerminalWidth() {
  for (const stream of [process.stdout, process.stderr])
    if (stream?.isTTY && stream.columns > 0) return stream.columns;
  return undefined;
}

/** terminal_width：COLUMNS（usize 且 > 0）优先，其次检测到的宽度（> 0），否则 120。 */
export function terminalWidth({ env = process.env, detected = detectTerminalWidth() } = {}) {
  const columns = parseUnsigned(env.COLUMNS, 2n ** 64n - 1n);
  if (columns !== undefined && columns > 0n) return Number(columns);
  if (detected > 0) return detected;
  return DEFAULT_TERMINAL_WIDTH;
}

/** box_title_lines：标题盒子（含前后空行），内容居中，最小内容宽 40 + 2。 */
export function boxTitleLines(title, colorEnabled) {
  const lines = rustLines(title);
  const contentWidth = Math.max(40, ...lines.map(visibleWidth)) + 2;
  const out = ['', `╭${'─'.repeat(contentWidth + 2)}╮`, `│${' '.repeat(contentWidth + 2)}│`];
  for (const line of lines) {
    const padding = Math.max(0, contentWidth - visibleWidth(line));
    const left = Math.floor(padding / 2);
    out.push(
      `│ ${' '.repeat(left)}${paint(colorEnabled, line, 'blue')}${' '.repeat(padding - left)} │`,
    );
  }
  out.push(`│${' '.repeat(contentWidth + 2)}│`, `╰${'─'.repeat(contentWidth + 2)}╯`, '');
  return out;
}
