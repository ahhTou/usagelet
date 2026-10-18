// 模型别名，移植自 ccusage 20.0.21 rust/crates/ccusage-core/src/model_aliases.rs（MIT）。
// 上游从环境变量 CCUSAGE_MODEL_ALIASES 读取；这里只做解析与解析结果的应用，原始文本由调用方传入。
import { parseSerdeJson } from './serde-json.mjs';
import { rustTrim } from './util.mjs';

/**
 * 解析别名文本，规则同 `parse_model_aliases`：以 `{` 开头且是「值全为字符串」的 JSON 对象时直接采用
 * （空字符串值也保留，查找时忽略）；否则去掉成对的首尾花括号，按 `,` `;` `\n` 切分 `from=to`。
 * @param {string} raw
 * @returns {Map<string, string>}
 */
export function parseModelAliases(raw = '') {
  const trimmed = rustTrim(String(raw));
  if (trimmed.startsWith('{')) {
    try {
      const value = parseSerdeJson(trimmed);
      if (value instanceof Map && [...value.values()].every((v) => typeof v === 'string')) {
        return new Map(value);
      }
    } catch {
      // JSON 不合法时退回分隔符格式，与上游一致。
    }
  }
  const stripped =
    trimmed.length >= 2 && trimmed.startsWith('{') && trimmed.endsWith('}')
      ? trimmed.slice(1, -1)
      : trimmed;
  const aliases = new Map();
  for (const pair of stripped.split(/[,;\n]/)) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const from = rustTrim(pair.slice(0, at));
    const to = rustTrim(pair.slice(at + 1));
    if (from && to) aliases.set(from, to);
  }
  return aliases;
}

const EMPTY = new Map();
const converted = new WeakMap();

/**
 * 把调用方给的别名统一成 Map：接受 Map、普通对象（如 compat.mjs 的 aliases() 结果）、
 * 原始文本或空值。只保留字符串值。
 */
export function toAliasMap(aliases) {
  if (aliases === undefined || aliases === null) return EMPTY;
  if (typeof aliases === 'string') return parseModelAliases(aliases);
  if (typeof aliases !== 'object') throw new TypeError('aliases 必须是 Map、对象或字符串');
  const cached = converted.get(aliases);
  if (cached) return cached;
  const entries = aliases instanceof Map ? [...aliases] : Object.entries(aliases);
  const map = new Map(entries.filter(([k, v]) => typeof k === 'string' && typeof v === 'string'));
  converted.set(aliases, map);
  return map;
}

/**
 * `resolve_model_name`：先查完整名；否则 `-fast` 结尾时查去掉后缀的名字，命中则补回 `-fast`。
 * 空字符串目标视为未配置。
 */
export function resolveModelName(model, aliases) {
  const map = toAliasMap(aliases);
  if (map.size === 0) return model;
  const direct = map.get(model);
  if (direct) return direct;
  if (model.endsWith('-fast')) {
    const base = map.get(model.slice(0, -5));
    if (base) return `${base}-fast`;
  }
  return model;
}
