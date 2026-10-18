// 定价模块共用的小工具：Rust 字符串语义（字节序、Unicode 空白）与 u64 计数运算。

const ASCII = /^[\x00-\x7f]*$/;
const encoder = new TextEncoder();

/** 按 UTF-8 字节序比较，对应 Rust `str`/`String` 的 Ord（BTreeMap 的迭代顺序）。 */
export function compareUtf8(a, b) {
  if (a === b) return 0;
  if (ASCII.test(a) && ASCII.test(b)) return a < b ? -1 : 1;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** UTF-8 字节长度，对应 Rust `str::len`。 */
export function utf8Length(value) {
  return ASCII.test(value) ? value.length : encoder.encode(value).length;
}

// Rust `char::is_whitespace`（Unicode White_Space）；与 JS trim 不同：不含 U+FEFF，含 U+0085。
const RUST_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Rust `str::trim`。 */
export function rustTrim(value) {
  return value.replace(RUST_WHITESPACE, '');
}

export const isAsciiDigit = (c) => c >= 0x30 && c <= 0x39;
export const isAsciiAlphanumeric = (c) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** token 计数：必须是非负安全整数；缺省（undefined/null）按 0。 */
export function count(value, name = 'token') {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负安全整数`);
  }
  return value;
}

/**
 * 计数相加。Rust 的 u64 加法在安全整数范围内与 JS 完全一致；超出 2^53 后 JS 无法精确表示，
 * 直接报错而不是给出近似值。
 */
export function addCount(a, b) {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('token 总量超出 JS 安全整数范围');
  return sum;
}

/** u64 `saturating_sub`。两个安全整数相减，结果在 0 处截断，始终精确。 */
export const saturatingSub = (a, b) => (a > b ? a - b : 0);
