// u64 计数：安全整数范围内用 number，超出时用 bigint；加法按 Rust saturating_add 饱和于 u64::MAX。
const U64_MAX = 2n ** 64n - 1n;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const normalize = (value) => (value <= SAFE ? Number(value) : value);

/** 校验并规范化一个 u64 计数（number 须为非负安全整数，bigint 须在 0..=u64::MAX）。 */
export function toU64(value, field = '计数') {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } else if (typeof value === 'bigint') {
    if (value >= 0n && value <= U64_MAX) return normalize(value);
  }
  throw new TypeError(`${field} 必须是非负整数（u64），实际为 ${String(value)}`);
}

/** u64::saturating_add */
export function addU64(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    const sum = a + b;
    if (sum <= Number.MAX_SAFE_INTEGER) return sum;
  }
  const sum = BigInt(a) + BigInt(b);
  return normalize(sum > U64_MAX ? U64_MAX : sum);
}

/** 依次 saturating_add 求和（对应 fold(0, u64::saturating_add)）。 */
export const sumU64 = (values) => values.reduce(addU64, 0);

export const isZeroU64 = (value) => value === 0 || value === 0n;

/** format_number：十进制千分位逗号。 */
export function formatNumber(value) {
  const digits = String(value);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}
