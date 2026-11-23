// 读取 ccusage 4f1df4ed build.rs 生成的定价表，格式见上游 pricing/table.rs（MIT）。
import { inflateRawSync } from 'node:zlib';
import { primary, secondary } from './pricing-snapshot.mjs';
import { normalizedPricingKey } from '../../pricing/keys.mjs';

// 顺序与上游 CACHE_DEFAULTS_BY_SEGMENT_PREFIX 相同，值为写入、读取价格对输入价的倍率。
const claudeFable = [1.25, 0.025];
const claude55 = [1.25, 0.05];
const surcharged = [1.25, 0.1];
const gpt6 = [1.25, 0.05];
const atInput = [1, 0.1];
const defaults = [
  ...Array(4).fill(claudeFable),
  ...Array(2).fill(claude55),
  surcharged,
  ...Array(8).fill(gpt6),
  ...Array(10).fill(surcharged),
  ...Array(12).fill(atInput),
  [1, 0.05],
  atInput,
  [1, 0.02],
  [1, 0.15],
  [1, 0.25],
  atInput,
  [1, 0.2],
  [1, 0.2],
  [1, 0.2],
  ...Array(6).fill(atInput),
  [1, 0.25],
];
const prefixDefaults = [
  [/^claude-(fable|mythos)-5-[12]/, claudeFable],
  [/^claude-(opus|sonnet)-5-5/, claude55],
  [/^claude-/, surcharged],
  [/^(openai-)?gpt-6-(?:2-(?:astra|sol)|1-(?:sol|terra))/, gpt6],
  [/^(openai-)?gpt-(?:5-[6-9]|6)/, surcharged],
  [/^(openai-)?(?:codex-|gpt-|chatgpt-|o[134](?:-|$))/, atInput],
  [/^gemini-4/, [1, 0.05]],
  [/^gemini-/, atInput],
  [/^deepseek-/, [1, 0.02]],
  [/^grok-4-5/, [1, 0.15]],
  [/^grok-/, [1, 0.25]],
  [/^kimi-k3/, atInput],
  [/^(glm-|qwen|minimax-m)/, [1, 0.2]],
  [/^(mistral|devstral|codestral|ministral|magistral|pixtral)-/, atInput],
  [/^nova-/, [1, 0.25]],
];

function reader(bytes, offset = 0) {
  function next() {
    const value = bytes[offset++];
    if (value === undefined) throw Error('Antigravity 定价表不完整');
    return value;
  }
  function uint() {
    let value = 0;
    let place = 1;
    for (;;) {
      const byte = next();
      value += (byte & 127) * place;
      if (byte < 128) return value;
      place *= 128;
    }
  }
  function take(length) {
    const end = offset + length;
    if (end > bytes.length) throw Error('Antigravity 定价表不完整');
    const result = bytes.subarray(offset, end);
    offset = end;
    return result;
  }
  return { next, uint, take, section: () => take(uint()) };
}

const fold = (key) => normalizedPricingKey(key).replace(/[A-Z]/g, (c) => c.toLowerCase());

function decode(bytes, delta) {
  const table = reader(bytes);
  const values = table.take(table.uint() * 8);
  const flags = table.section();
  const limits = table.section();
  const rates = table.section();
  const keys = table.section();
  const records = table.section();
  const result = [];
  let keyOffset = 0;
  let flagOffset = 0;
  let limitOffset = 0;
  let rateOffset = 0;
  for (let i = 0; i < records.length; i += delta ? 4 : 10) {
    const length = records[i + (delta ? 0 : 3)];
    if (delta) {
      flagOffset += records[i + 1];
      limitOffset += records[i + 2];
      rateOffset += records[i + 3];
    } else {
      keyOffset = records.readUIntLE(i, 3);
      flagOffset = records.readUInt16LE(i + 4);
      limitOffset = records.readUInt16LE(i + 6);
      rateOffset = records.readUInt16LE(i + 8);
    }
    const key = keys.toString('utf8', keyOffset, keyOffset + length);
    keyOffset += length;
    const meta = reader(flags, flagOffset);
    const limit = reader(limits, limitOffset);
    const rate = reader(rates, rateOffset);
    const bits = meta.next();
    const vendorStart = meta.uint();
    const schedule = meta.uint();
    const mode = meta.next();
    meta.uint(); // explicit_fields
    const published = meta.next();
    let multipliers = defaults[meta.uint()];
    if (published === 1) {
      const parts = fold(key).split('/');
      multipliers =
        parts
          .map((part) => prefixDefaults.find(([match]) => match.test(part))?.[1])
          .find(Boolean) ?? multipliers;
    }
    const [write, read] = multipliers;
    const optional = () => {
      const id = rate.uint();
      return id ? values.readDoubleLE((id - 1) * 8) : null;
    };
    limit.uint(); // context_limit
    const input = values.readDoubleLE(rate.uint() * 8);
    const output = values.readDoubleLE(rate.uint() * 8);
    const explicitWrite = optional();
    const explicitRead = optional();
    optional(); // cache_create_1h
    const threshold = mode ? limit.uint() : null;
    const inputAbove = mode ? optional() : null;
    const outputAbove = mode ? optional() : null;
    const writeAbove = mode ? optional() : null;
    if (mode) optional(); // cache_create_1h_above
    const readAbove = mode ? optional() : null;
    const cacheWrite = explicitWrite ?? input * write;
    const cacheRead = explicitRead ?? input * read;
    result.push({
      key,
      identity: normalizedPricingKey(key),
      vendorKey: vendorStart
        ? Buffer.from(key)
            .subarray(vendorStart - 1)
            .toString('utf8')
        : key,
      isDirect: (bits & 4) !== 0,
      exactOnly: (bits & 8) !== 0,
      host: (bits >> 5) & 3,
      free: (bits & 128) !== 0,
      schedule,
      rates: {
        input,
        output,
        cache_create: cacheWrite,
        cache_read: cacheRead,
        input_above_200k: inputAbove,
        output_above_200k: outputAbove,
        cache_create_above_200k:
          writeAbove ??
          (mode === 2 && inputAbove !== null ? Math.max(inputAbove * write, cacheWrite) : null),
        cache_read_above_200k:
          readAbove ??
          (mode === 2 && inputAbove !== null ? Math.max(inputAbove * read, cacheRead) : null),
        long_context_threshold: mode === 2 ? threshold : null,
        marginal_threshold: mode === 1 ? threshold : null,
      },
    });
  }
  return result;
}

let tables;
export function pricingTables() {
  if (!tables) {
    // models-dev-table.bin 带 8193 字节的查询过滤器；直接读取紧随其后的表。
    tables = [
      decode(Buffer.from(primary, 'base64'), false),
      decode(inflateRawSync(Buffer.from(secondary, 'base64').subarray(8193)), true),
    ];
  }
  return tables;
}
