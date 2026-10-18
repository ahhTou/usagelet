// 与 ccusage 20.0.21 所用 serde_json 1.0.151 行为一致的 JSON 解析与按类型解码。
//
// 运行期 ccusage 用不带 float_roundtrip 的 serde_json 解析价格 JSON：浮点数先把十进制尾数读成
// u64（溢出后丢弃后续位），再乘除 10 的幂表，并非严格正确舍入。构建期（build.rs）则开了
// float_roundtrip。要做到逐位一致，数字必须按同样的算法读出，所以这里不用 JSON.parse。
//
// 解析结果：null / boolean / string / JsonNumber / Array / Map（对象，重复键后者覆盖）。

const U64_MAX = 18446744073709551615n;
const U64_DIV10 = U64_MAX / 10n;
const U64_MOD10 = U64_MAX % 10n;
const I64_MIN = -(2n ** 63n);
const TWO_63 = 2n ** 63n;
const TWO_64 = 2n ** 64n;
const I32_MAX = 2147483647;
const I32_MIN = -2147483648;
// serde_json 的 POW10 表：1e0..1e308，每项都是 rustc 正确舍入后的字面量，与 JS 解析结果相同。
export const POW10 = Array.from({ length: 309 }, (_, k) => Number(`1e${k}`));
// serde_json 默认递归深度上限：进入第 128 层容器时报错。
const RECURSION_LIMIT = 128;

export class SerdeJsonError extends Error {}
export class DecodeError extends Error {}

/** JSON 数字：kind 为 'u64' | 'i64' | 'f64'，value 为按 serde 规则得到的 f64，int 为整数的精确值。 */
export class JsonNumber {
  constructor(kind, value, int = null) {
    this.kind = kind;
    this.value = value;
    this.int = int;
  }
}

const isDigit = (c) => c >= 0x30 && c <= 0x39;
const u64Overflow = (sig, digit) => sig >= U64_DIV10 && (sig > U64_DIV10 || digit > U64_MOD10);
const i32Overflow = (exp, digit) => exp >= 214748364 && (exp > 214748364 || digit > 7);
const saturateI32 = (x) => (x > I32_MAX ? I32_MAX : x < I32_MIN ? I32_MIN : x);

// serde_json `f64_from_parts`（非 float_roundtrip）：尾数先转 f64，再乘或除 POW10[|exp|]。
function f64FromParts(negative, significand, exponent) {
  let f = Number(significand);
  for (;;) {
    // Rust 用 `exponent.wrapping_abs() as usize`，i32::MIN 会变成极大下标而查不到表。
    const index = exponent === I32_MIN ? Infinity : Math.abs(exponent);
    if (index <= 308) {
      if (exponent >= 0) {
        f *= POW10[index];
        if (!Number.isFinite(f)) throw new SerdeJsonError('number out of range');
      } else {
        f /= POW10[index];
      }
      break;
    }
    if (f === 0) break;
    if (exponent >= 0) throw new SerdeJsonError('number out of range');
    f /= 1e308;
    exponent += 308;
  }
  return negative ? -f : f;
}

// serde_json `parse_exponent`：指数按 i32 累加，溢出时按 `parse_exponent_overflow` 处理。
function parseExponent(negative, significand, startingExp, expNegative, expDigits) {
  let exp = expDigits.charCodeAt(0) - 48;
  for (let j = 1; j < expDigits.length; j++) {
    const digit = expDigits.charCodeAt(j) - 48;
    if (i32Overflow(exp, digit)) {
      if (significand !== 0n && !expNegative) throw new SerdeJsonError('number out of range');
      return negative ? -0 : 0;
    }
    exp = exp * 10 + digit;
  }
  const finalExp = expNegative ? saturateI32(startingExp - exp) : saturateI32(startingExp + exp);
  return f64FromParts(negative, significand, finalExp);
}

// serde_json `parse_decimal` 及其溢出分支：小数位继续并入 u64 尾数，溢出后余下位全部忽略。
function afterInteger(negative, significand, exponentBefore, fracDigits, expNegative, expDigits) {
  if (fracDigits === null) {
    return expDigits === null
      ? f64FromParts(negative, significand, exponentBefore)
      : parseExponent(negative, significand, exponentBefore, expNegative, expDigits);
  }
  let after = 0;
  for (let j = 0; j < fracDigits.length; j++) {
    const digit = BigInt(fracDigits.charCodeAt(j) - 48);
    if (u64Overflow(significand, digit)) break;
    significand = significand * 10n + digit;
    after -= 1;
  }
  const exponent = exponentBefore + after;
  return expDigits === null
    ? f64FromParts(negative, significand, exponent)
    : parseExponent(negative, significand, exponent, expNegative, expDigits);
}

// serde_json `parse_number` 的整数分支：正数为 u64；负数按 i64 wrapping_neg 规则，-0 与超出 i64 的值变为 f64。
function integerNumber(negative, significand) {
  if (!negative) return new JsonNumber('u64', Number(significand), significand);
  const asI64 = significand >= TWO_63 ? significand - TWO_64 : significand;
  const wrapped = asI64 === I64_MIN ? asI64 : -asI64;
  if (wrapped >= 0n) return new JsonNumber('f64', -Number(significand));
  return new JsonNumber('i64', Number(wrapped), wrapped);
}

function accumulateInteger(intDigits) {
  let significand = 0n;
  let used = 0;
  if (intDigits !== '0') {
    for (; used < intDigits.length; used++) {
      const digit = BigInt(intDigits.charCodeAt(used) - 48);
      if (u64Overflow(significand, digit)) break;
      significand = significand * 10n + digit;
    }
  } else {
    used = 1;
  }
  return { significand, used };
}

/** 按 serde_json 默认（非 float_roundtrip）规则把数字词素转成 JsonNumber。 */
export function serdeDefaultNumber(negative, intDigits, fracDigits, expNegative, expDigits) {
  const { significand, used } = accumulateInteger(intDigits);
  if (used < intDigits.length) {
    // `parse_long_integer`：溢出后余下的整数位只计入指数。
    const exponent = intDigits.length - used;
    return new JsonNumber(
      'f64',
      afterInteger(negative, significand, exponent, fracDigits, expNegative, expDigits),
    );
  }
  if (fracDigits === null && expDigits === null) return integerNumber(negative, significand);
  return new JsonNumber(
    'f64',
    afterInteger(negative, significand, 0, fracDigits, expNegative, expDigits),
  );
}

// float_roundtrip：整数规则相同，浮点用正确舍入（JS 的 Number(字符串) 即正确舍入）。
function roundtripNumber(negative, intDigits, fracDigits, expNegative, expDigits, lexeme) {
  if (fracDigits === null && expDigits === null) {
    const { significand, used } = accumulateInteger(intDigits);
    if (used === intDigits.length) return integerNumber(negative, significand);
  }
  if (expDigits !== null) {
    // 指数位数溢出 i32 时两种模式共用 `parse_exponent_overflow`。
    let exp = expDigits.charCodeAt(0) - 48;
    for (let j = 1; j < expDigits.length; j++) {
      const digit = expDigits.charCodeAt(j) - 48;
      if (i32Overflow(exp, digit)) {
        const zero = !/[1-9]/.test(intDigits + (fracDigits ?? ''));
        if (!zero && !expNegative) throw new SerdeJsonError('number out of range');
        return new JsonNumber('f64', negative ? -0 : 0);
      }
      exp = exp * 10 + digit;
    }
  }
  const value = Number(lexeme);
  if (!Number.isFinite(value)) throw new SerdeJsonError('number out of range');
  return new JsonNumber('f64', value);
}

class Parser {
  constructor(text, float) {
    this.s = text;
    this.i = 0;
    this.float = float;
  }

  skipWhitespace() {
    const s = this.s;
    let i = this.i;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d) i++;
      else break;
    }
    this.i = i;
  }

  parseValue(depth) {
    this.skipWhitespace();
    const c = this.s.charCodeAt(this.i);
    if (c === 0x22) return this.parseString();
    if (c === 0x7b) return this.parseObject(depth + 1);
    if (c === 0x5b) return this.parseArray(depth + 1);
    if (c === 0x2d || isDigit(c)) return this.parseNumber();
    if (c === 0x6e) return this.literal('null', null);
    if (c === 0x74) return this.literal('true', true);
    if (c === 0x66) return this.literal('false', false);
    throw new SerdeJsonError('expected value');
  }

  literal(word, value) {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return value;
    }
    throw new SerdeJsonError('expected ident');
  }

  parseArray(depth) {
    if (depth >= RECURSION_LIMIT) throw new SerdeJsonError('recursion limit exceeded');
    this.i++;
    const out = [];
    this.skipWhitespace();
    if (this.s.charCodeAt(this.i) === 0x5d) {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue(depth));
      this.skipWhitespace();
      const c = this.s.charCodeAt(this.i);
      if (c === 0x2c) {
        this.i++;
        this.skipWhitespace();
        if (this.s.charCodeAt(this.i) === 0x5d) throw new SerdeJsonError('trailing comma');
        continue;
      }
      if (c === 0x5d) {
        this.i++;
        return out;
      }
      throw new SerdeJsonError('expected `,` or `]`');
    }
  }

  parseObject(depth) {
    if (depth >= RECURSION_LIMIT) throw new SerdeJsonError('recursion limit exceeded');
    this.i++;
    const out = new Map();
    this.skipWhitespace();
    if (this.s.charCodeAt(this.i) === 0x7d) {
      this.i++;
      return out;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.s.charCodeAt(this.i) !== 0x22) throw new SerdeJsonError('key must be a string');
      const key = this.parseString();
      this.skipWhitespace();
      if (this.s.charCodeAt(this.i) !== 0x3a) throw new SerdeJsonError('expected `:`');
      this.i++;
      out.set(key, this.parseValue(depth));
      this.skipWhitespace();
      const c = this.s.charCodeAt(this.i);
      if (c === 0x2c) {
        this.i++;
        this.skipWhitespace();
        if (this.s.charCodeAt(this.i) === 0x7d) throw new SerdeJsonError('trailing comma');
        continue;
      }
      if (c === 0x7d) {
        this.i++;
        return out;
      }
      throw new SerdeJsonError('expected `,` or `}`');
    }
  }

  hex4() {
    const text = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new SerdeJsonError('invalid escape');
    this.i += 4;
    return parseInt(text, 16);
  }

  parseString() {
    const s = this.s;
    let i = ++this.i;
    let out = '';
    let start = i;
    for (;;) {
      if (i >= s.length) throw new SerdeJsonError('EOF while parsing a string');
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        out += s.slice(start, i);
        this.i = i + 1;
        // Rust 的 str 不能含孤立代理项；serde_json 校验 \u 转义也拒绝它们。
        if (!out.isWellFormed()) throw new SerdeJsonError('lone surrogate');
        return out;
      }
      if (c < 0x20) throw new SerdeJsonError('control character found while parsing a string');
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += s.slice(start, i);
      this.i = i + 1;
      const e = s.charCodeAt(this.i++);
      if (e === 0x22) out += '"';
      else if (e === 0x5c) out += '\\';
      else if (e === 0x2f) out += '/';
      else if (e === 0x62) out += '\b';
      else if (e === 0x66) out += '\f';
      else if (e === 0x6e) out += '\n';
      else if (e === 0x72) out += '\r';
      else if (e === 0x74) out += '\t';
      else if (e === 0x75) {
        const n = this.hex4();
        if (n >= 0xdc00 && n <= 0xdfff) throw new SerdeJsonError('lone trailing surrogate');
        if (n >= 0xd800 && n <= 0xdbff) {
          if (s.charCodeAt(this.i) !== 0x5c || s.charCodeAt(this.i + 1) !== 0x75) {
            throw new SerdeJsonError('unexpected end of hex escape');
          }
          this.i += 2;
          const n2 = this.hex4();
          if (n2 < 0xdc00 || n2 > 0xdfff) throw new SerdeJsonError('lone leading surrogate');
          out += String.fromCharCode(n, n2);
        } else {
          out += String.fromCharCode(n);
        }
      } else {
        throw new SerdeJsonError('invalid escape');
      }
      i = this.i;
      start = i;
    }
  }

  parseNumber() {
    const s = this.s;
    let i = this.i;
    const start = i;
    let negative = false;
    if (s.charCodeAt(i) === 0x2d) {
      negative = true;
      i++;
    }
    const intStart = i;
    let c = s.charCodeAt(i);
    if (c === 0x30) {
      i++;
      if (isDigit(s.charCodeAt(i))) throw new SerdeJsonError('invalid number');
    } else if (c >= 0x31 && c <= 0x39) {
      while (isDigit(s.charCodeAt(i))) i++;
    } else {
      throw new SerdeJsonError('invalid number');
    }
    const intDigits = s.slice(intStart, i);
    let fracDigits = null;
    if (s.charCodeAt(i) === 0x2e) {
      i++;
      const fracStart = i;
      while (isDigit(s.charCodeAt(i))) i++;
      if (i === fracStart) throw new SerdeJsonError('invalid number');
      fracDigits = s.slice(fracStart, i);
    }
    let expNegative = false;
    let expDigits = null;
    c = s.charCodeAt(i);
    if (c === 0x65 || c === 0x45) {
      i++;
      c = s.charCodeAt(i);
      if (c === 0x2b) i++;
      else if (c === 0x2d) {
        expNegative = true;
        i++;
      }
      const expStart = i;
      while (isDigit(s.charCodeAt(i))) i++;
      if (i === expStart) throw new SerdeJsonError('invalid number');
      expDigits = s.slice(expStart, i);
    }
    this.i = i;
    if (this.float === 'roundtrip') {
      return roundtripNumber(
        negative,
        intDigits,
        fracDigits,
        expNegative,
        expDigits,
        s.slice(start, i),
      );
    }
    return serdeDefaultNumber(negative, intDigits, fracDigits, expNegative, expDigits);
  }
}

/**
 * 按 serde_json 语法解析 JSON 文本。
 * @param {string} text
 * @param {{ float?: 'default' | 'roundtrip' }} [options] default 对应运行期，roundtrip 对应 build.rs。
 */
export function parseSerdeJson(text, { float = 'default' } = {}) {
  if (typeof text !== 'string') throw new SerdeJsonError('JSON 必须是字符串');
  const parser = new Parser(text, float);
  const value = parser.parseValue(0);
  parser.skipWhitespace();
  if (parser.i !== text.length) throw new SerdeJsonError('trailing characters');
  return value;
}

// zmij / ryu 的输出格式决定了 serde 默认解析看到的尾数与指数（整数值会带上 ".0"）。
function shortestDigits(value) {
  const text = Math.abs(value).toString();
  const at = text.indexOf('e');
  const mantissa = at < 0 ? text : text.slice(0, at);
  let exponent = at < 0 ? 0 : Number(text.slice(at + 1));
  const dot = mantissa.indexOf('.');
  let digits = mantissa;
  if (dot >= 0) {
    exponent -= mantissa.length - dot - 1;
    digits = mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  }
  digits = digits.replace(/^0+(?=\d)/, '');
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }
  return { digits, exponent };
}

/**
 * 运行期看到的浮点值：把构建期得到的 f64 按 serde_json（zmij）序列化，再用默认规则读回。
 * 只用于价格快照生成；结果与正确舍入不同时，快照里写入读回后的值。
 */
export function serdeRuntimeFloat(value) {
  if (!Number.isFinite(value)) throw new SerdeJsonError('非有限浮点数无法序列化');
  if (value === 0) return value;
  const negative = value < 0;
  const { digits, exponent } = shortestDigits(value);
  const length = digits.length;
  const point = length + exponent;
  if (exponent >= 0 && point <= 16) {
    // "1234000.0"：整数位后补零，再带一位小数 0。
    return f64FromParts(negative, BigInt(digits + '0'.repeat(exponent) + '0'), -1);
  }
  return f64FromParts(negative, BigInt(digits), exponent);
}

// ---- 按 serde derive 语义从 Value 解码 ----

const fail = (message) => {
  throw new DecodeError(message);
};

export const de = {
  f64: (v) => (v instanceof JsonNumber ? v.value : fail('invalid type: expected f64')),
  u64: (v) =>
    v instanceof JsonNumber && v.kind === 'u64' ? v.value : fail('invalid type: expected u64'),
  string: (v) => (typeof v === 'string' ? v : fail('invalid type: expected string')),
  bool: (v) => (typeof v === 'boolean' ? v : fail('invalid type: expected bool')),
  option: (inner) => (v) => (v === null ? null : inner(v)),
  vec: (inner) => (v) => (Array.isArray(v) ? v.map(inner) : fail('invalid type: expected seq')),
  map: (inner) => (v) => {
    if (!(v instanceof Map)) fail('invalid type: expected map');
    const out = new Map();
    for (const [key, item] of v) out.set(key, inner(item));
    return out;
  },
  /**
   * 结构体：fields 为 [JSON 字段名, 解码器, 是否 Option]，顺序即 Rust 声明顺序。
   * 对象缺少 Option 字段时为 null；数组形式要求元素个数恰好等于字段数（serde derive 的 visit_seq）。
   */
  struct: (fields) => (v) => {
    const out = {};
    if (v instanceof Map) {
      for (const [name, decode, optional] of fields) {
        if (v.has(name)) out[name] = decode(v.get(name));
        else if (optional) out[name] = null;
        else fail(`missing field \`${name}\``);
      }
      return out;
    }
    if (Array.isArray(v)) {
      if (v.length !== fields.length) fail('invalid length');
      fields.forEach(([name, decode], index) => {
        out[name] = decode(v[index]);
      });
      return out;
    }
    return fail('invalid type: expected struct');
  },
};

/** 把解码异常转成 null，其它异常照常抛出。 */
export function tryDecode(decode, value) {
  try {
    return decode(value);
  } catch (error) {
    if (error instanceof DecodeError) return null;
    throw error;
  }
}
