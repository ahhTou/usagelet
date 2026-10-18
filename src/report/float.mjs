// f64 的文本表示：serde_json 1.0.151（zmij）序列化、json_float、Rust 的 format!("{:.2}")。
// JS number 与 Rust f64 同为 IEEE 754 binary64，加法结果逐位相同；差异只在文本格式。

const I64_MAX = 2n ** 63n - 1n;
const TWO_63 = 2 ** 63;

/**
 * serde_json 写 f64 的文本（zmij 最短往返表示）：
 * 十进制指数在 -5..=15 内用定点写法（整数值补 ".0"），否则写成 d.ddde±X；非有限值为 null。
 */
export function formatF64(x) {
  if (!Number.isFinite(x)) return 'null';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  // toExponential() 不带参数时给出最短往返有效数字，与 zmij 的有效数字一致。
  const [mantissa, exponent] = x.toExponential().split('e');
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const e = Number(exponent);
  const n = digits.length;
  let text;
  if (e >= -5 && e <= 15) {
    if (n - 1 <= e) text = digits + '0'.repeat(e + 1 - n) + '.0';
    else if (e >= 0) text = digits.slice(0, e + 1) + '.' + digits.slice(e + 1);
    else text = '0.' + '0'.repeat(-e - 1) + digits;
  } else {
    text =
      digits[0] + (n > 1 ? '.' + digits.slice(1) : '') + 'e' + (e < 0 ? '-' : '+') + Math.abs(e);
  }
  return negative ? '-' + text : text;
}

/** json_float：有限且为整数值（落在 i64 区间）时按 i64 输出（饱和转换），否则按 f64 输出。 */
export function jsonFloat(x) {
  if (Number.isFinite(x) && Number.isInteger(x) && x >= -TWO_63 && x <= TWO_63) {
    const value = BigInt(x);
    return String(value > I64_MAX ? I64_MAX : value);
  }
  return formatF64(x);
}

/** json_float 结果再取 Value::as_f64().unwrap_or(0.0)：非有限值变成 null，再落回 0。 */
export function jsonFloatAsF64(x) {
  if (!Number.isFinite(x)) return 0;
  if (Number.isInteger(x) && x >= -TWO_63 && x <= TWO_63) {
    const value = BigInt(x);
    return Number(value > I64_MAX ? I64_MAX : value);
  }
  return x;
}

const view = new DataView(new ArrayBuffer(8));

/** 把有限 f64 拆成精确的 mantissa × 2^exponent（mantissa 为非负 bigint）。 */
function decompose(x) {
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased === 0) return [mantissa, -1074];
  mantissa |= 1n << 52n;
  return [mantissa, biased - 1075];
}

/**
 * format_currency：Rust 的 format!("${value:.2}")。
 * 对二进制精确值做两位小数舍入，恰好一半时取偶（0.125 → 0.12）；负零与舍入到零的负数保留负号。
 */
export function formatCurrency(x) {
  if (Number.isNaN(x)) return '$NaN';
  if (x === Infinity) return '$inf';
  if (x === -Infinity) return '$-inf';
  const negative = x < 0 || Object.is(x, -0);
  const [mantissa, exponent] = decompose(Math.abs(x));
  let numerator = mantissa * 100n;
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  let quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && (quotient & 1n) === 1n)) quotient += 1n;
  const digits = quotient.toString().padStart(3, '0');
  return `$${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const bits = new BigInt64Array(1);
const floats = new Float64Array(bits.buffer);

/** f64::total_cmp */
export function totalCmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b && (a !== 0 || Object.is(a, b))) return 0;
  const key = (v) => {
    floats[0] = v;
    const x = bits[0];
    return x ^ BigInt.asIntN(64, BigInt.asUintN(64, x >> 63n) >> 1n);
  };
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
