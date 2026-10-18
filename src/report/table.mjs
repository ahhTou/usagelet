// ccusage-terminal 的 SimpleTable（ccusage 20.0.21 table.rs）逐行移植：列宽计算、适配终端宽度、
// 换行与截断、日期压缩、ANSI 续接与边框。
import { rustLines, splitWhitespace } from './text.mjs';
import {
  ansiContinuation,
  ensureAnsiReset,
  paint,
  truncateToWidth,
  visibleWidth,
  visibleWidthMaxLine,
  DEFAULT_TERMINAL_WIDTH,
} from './terminal.mjs';

const MAX_MODELS_CONTENT_WIDTH = 25;
const MIN_WRAP_COLUMN_WIDTH = 8;
const MAX_FALLBACK_TEXT_WIDTH = 12;

export const LEFT = 'left';
export const RIGHT = 'right';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const requiredWidth = (widths) => widths.reduce((a, b) => a + b, 0) + widths.length + 1;
const sub = (a, b) => Math.max(0, a - b);

/** Iterator::max_by_key：返回键最大的下标，并列时取最后一个；没有候选时为 -1。 */
function maxByKey(indexes, key) {
  let best = -1;
  let bestKey;
  for (const index of indexes) {
    const k = key(index);
    if (best < 0 || k[0] > bestKey[0] || (k[0] === bestKey[0] && k[1] >= bestKey[1])) {
      best = index;
      bestKey = k;
    }
  }
  return best;
}

export class SimpleTable {
  /**
   * @param {string[]} headers
   * @param {('left'|'right')[]} aligns
   * @param {{ color?: boolean, terminalWidth?: number, compactDates?: boolean }} options
   */
  constructor(headers, aligns, { color = false, terminalWidth, compactDates = false } = {}) {
    this.headers = [...headers];
    this.aligns = [...aligns];
    this.rows = [];
    this.color = color;
    this.terminalWidth = terminalWidth ?? DEFAULT_TERMINAL_WIDTH;
    this.compactDates = compactDates;
  }

  push(row) {
    this.rows.push([...row]);
  }

  separator() {
    this.rows.push(null);
  }

  get columnCount() {
    return this.headers.length;
  }

  renderLines() {
    const widths = this.columnWidths();
    const lines = [border('┌', '┬', '┐', widths)];
    for (const headerRow of expandMultilineRow(this.headers, this.headers.length, widths)) {
      const colored = headerRow.map((header) => paint(this.color, header, 'blue'));
      lines.push(tableLine(colored, this.aligns, widths));
    }
    lines.push(border('├', '┼', '┤', widths));
    this.rows.forEach((row, rowIndex) => {
      if (row) {
        const compacted = this.compactDateRow(row, widths);
        for (const physical of expandMultilineRow(compacted, this.headers.length, widths))
          lines.push(tableLine(physical, this.aligns, widths));
      } else lines.push(border('├', '┼', '┤', widths));
      if (row && rowIndex + 1 < this.rows.length && this.rows[rowIndex + 1] !== null)
        lines.push(border('├', '┼', '┤', widths));
    });
    lines.push(border('└', '┴', '┘', widths));
    return lines;
  }

  /** 与 print() 相同的文本：每行后接 \n。 */
  render() {
    return this.renderLines()
      .map((line) => `${line}\n`)
      .join('');
  }

  columnWidths() {
    const modelColumn = this.headers.indexOf('Models');
    const rows = this.rows.filter(Boolean);
    const columnMax = (index) =>
      rows.reduce(
        (max, row) => (index < row.length ? Math.max(max, visibleWidthMaxLine(row[index])) : max),
        0,
      );
    const numeric = this.aligns.map((align, index) => (align !== RIGHT ? 0 : columnMax(index)));
    const text = this.aligns.map((align, index) => (align === RIGHT ? 0 : columnMax(index)));
    const content = this.headers.map((header, index) => {
      const width = visibleWidthMaxLine(header);
      return index === modelColumn ? Math.min(width, MAX_MODELS_CONTENT_WIDTH) : width;
    });
    for (const row of rows) {
      row.forEach((cell, index) => {
        let width = visibleWidthMaxLine(cell);
        if (index === modelColumn) width = Math.min(width, MAX_MODELS_CONTENT_WIDTH);
        if (index < content.length) content[index] = Math.max(content[index], width);
      });
    }
    const widths = content.map((width, index) => {
      if (index === modelColumn) return clamp(width + 2, 15, MAX_MODELS_CONTENT_WIDTH + 2);
      if (this.aligns[index] === RIGHT) return Math.max(width + 3, 11);
      if (index === 1) return Math.max(width + 2, 15);
      return Math.max(width + 2, 10);
    });
    const firstColumnMin =
      this.compactDates && requiredWidth(widths) <= this.terminalWidth ? 12 : 10;
    return fitWidthsToTerminal(
      widths,
      this.aligns,
      this.terminalWidth,
      firstColumnMin,
      modelColumn < 0 ? null : modelColumn,
      { numeric, text },
      this.compactDates,
    );
  }

  compactDateRow(row, widths) {
    if (!this.compactDates || sub(widths[0] ?? 0, 2) >= 10) return row;
    const out = [...row];
    if (out.length > 0) {
      const compact = compactDateCell(out[0]);
      if (compact !== undefined) out[0] = compact;
    }
    return out;
  }
}

function expandMultilineRow(row, columnCount, widths) {
  const cells = [];
  for (let index = 0; index < columnCount; index++) {
    const contentWidth = sub(widths[index] ?? 0, 2);
    const lines = index < row.length ? wrapCellLines(row[index], contentWidth) : [];
    cells.push(lines.length > 0 ? lines : ['']);
  }
  const height = cells.reduce((max, lines) => Math.max(max, lines.length), 1);
  return Array.from({ length: height }, (_, line) => cells.map((lines) => lines[line] ?? ''));
}

export function fitWidthsToTerminal(
  widths,
  aligns,
  terminalWidth,
  firstColumnMin,
  modelColumn,
  contentWidths,
  compactDates,
) {
  widths = [...widths];
  if (requiredWidth(widths) <= terminalWidth) return widths;
  const isModels = (index) => modelColumn === index || (modelColumn === null && index === 1);
  const fallbackMinimums = widths.map((_, index) => {
    if (aligns[index] === RIGHT) return 10;
    if (index === 0) return firstColumnMin;
    if (isModels(index)) return 12;
    return clamp(
      (contentWidths.text[index] ?? 0) + 2,
      MIN_WRAP_COLUMN_WIDTH,
      MAX_FALLBACK_TEXT_WIDTH,
    );
  });
  const contentMinimums = fallbackMinimums.map((minimum, index) =>
    aligns[index] === RIGHT ? Math.max(minimum, (contentWidths.numeric[index] ?? 0) + 2) : minimum,
  );
  while (requiredWidth(contentMinimums) > terminalWidth) {
    const candidates = contentMinimums
      .map((_, index) => index)
      .filter((index) => aligns[index] !== RIGHT && contentMinimums[index] > MIN_WRAP_COLUMN_WIDTH);
    const index = maxByKey(candidates, (i) => [isModels(i) ? 1 : 0, contentMinimums[i]]);
    if (index < 0) break;
    contentMinimums[index] -= 1;
  }
  const expansionLimits = [...widths];
  if (compactDates && expansionLimits.length > 0) expansionLimits[0] = firstColumnMin;
  if (requiredWidth(contentMinimums) <= terminalWidth) {
    const spare = sub(terminalWidth, requiredWidth(contentMinimums));
    distributeSpareWidth(contentMinimums, expansionLimits, spare);
    return contentMinimums;
  }

  const minimums = fallbackMinimums;
  const available = sub(terminalWidth, widths.length + 1);
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > 0) {
    const scale = available / total;
    widths = widths.map((width, index) => Math.max(Math.floor(width * scale), minimums[index]));
  }
  while (requiredWidth(widths) > terminalWidth) {
    const candidates = widths.map((_, index) => index).filter((i) => widths[i] > minimums[i]);
    const index = maxByKey(candidates, (i) => [aligns[i] !== RIGHT ? 1 : 0, widths[i]]);
    if (index < 0) break;
    widths[index] -= 1;
  }
  distributeSpareWidth(widths, expansionLimits, sub(terminalWidth, requiredWidth(widths)));
  return widths;
}

function distributeSpareWidth(widths, limits, spare) {
  if (widths.length === 0) return;
  let start = 0;
  while (spare > 0) {
    let found = -1;
    for (let offset = 0; offset < widths.length; offset++) {
      const index = (start + offset) % widths.length;
      if (widths[index] < limits[index]) {
        found = index;
        break;
      }
    }
    if (found < 0) break;
    widths[found] += 1;
    spare -= 1;
    start = (found + 1) % widths.length;
  }
}

function wrapCellLines(cell, width) {
  if (width === 0) return [''];
  const lines = [];
  for (const line of rustLines(cell)) {
    if (visibleWidth(line) <= width) lines.push(line);
    else lines.push(...wrapCellLine(line, width));
  }
  return lines;
}

function wrapCellLine(line, width) {
  const tokens = splitWhitespace(line);
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isListMarker(tokens[i]) && i + 1 < tokens.length) {
      words.push(`${tokens[i]} ${tokens[i + 1]}`);
      i += 1;
    } else words.push(tokens[i]);
  }
  if (words.length <= 1) return [truncateToWidth(line, width)];

  const pieces = [];
  let current = '';
  let source = '';
  for (const word of words) {
    const candidate =
      current === '' ? visibleWidth(word) : visibleWidth(current) + 1 + visibleWidth(word);
    if (candidate <= width) {
      if (current !== '') {
        current += ' ';
        source += ' ';
      }
      current += word;
      source += word;
    } else {
      if (current !== '') pieces.push([current, source]);
      current = visibleWidth(word) > width ? truncateToWidth(word, width) : word;
      source = word;
    }
  }
  if (current !== '') pieces.push([current, source]);
  let continuation = '';
  return pieces.map(([piece, pieceSource]) => {
    const out = continuation === '' ? piece : continuation + piece;
    continuation = ansiContinuation(continuation + pieceSource);
    return out;
  });
}

const isListMarker = (word) => visibleWidth(word) === 1 && word.includes('-');

/** compact_date_cell：YYYY-MM-DD 拆成 "YYYY\nMM-DD"。 */
export function compactDateCell(value) {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
    ? `${value.slice(0, 4)}\n${value.slice(5)}`
    : undefined;
}

function tableLine(cells, aligns, widths) {
  let line = '│';
  widths.forEach((width, index) => {
    const cell = cells[index] ?? '';
    const align = index === 0 && cell.startsWith('(assuming ') ? RIGHT : (aligns[index] ?? LEFT);
    line += ` ${padCell(cell, sub(width, 2), align)} │`;
  });
  return line;
}

function padCell(cell, width, align) {
  const value = ensureAnsiReset(cell);
  const visible = visibleWidth(value);
  if (visible >= width) return value;
  const padding = ' '.repeat(width - visible);
  return align === LEFT ? value + padding : padding + value;
}

function border(left, middle, right, widths) {
  return (
    left + widths.map((w, i) => '─'.repeat(w) + (i + 1 === widths.length ? right : middle)).join('')
  );
}
