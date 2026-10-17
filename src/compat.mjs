// 兼容契约固定于 ccusage v20.0.21，不在对账时临时改名或排除记录。
import { validCount, sum, ZERO } from './shared.mjs';
export const COMPAT = 'ccusage@20.0.21';
export const BASE_AGENTS = ['claude', 'codex', 'zcode'];
export const nonempty = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
export function aliases(raw = '') {
  try {
    const value = JSON.parse(raw);
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      Object.values(value).every((x) => typeof x === 'string')
    )
      return value;
  } catch {}
  return Object.fromEntries(
    raw
      .trim()
      .replace(/^\{|\}$/g, '')
      .split(/[,;\n]/)
      .flatMap((pair) => {
        const at = pair.indexOf('=');
        return at > 0 && pair.slice(at + 1).trim()
          ? [[pair.slice(0, at).trim(), pair.slice(at + 1).trim()]]
          : [];
      }),
  );
}
export function alias(model, map) {
  if (!model) return null;
  if (Object.hasOwn(map, model) && map[model]) return map[model];
  if (model.endsWith('-fast') && Object.hasOwn(map, model.slice(0, -5)) && map[model.slice(0, -5)])
    return map[model.slice(0, -5)] + '-fast';
  return model;
}
export function strictTimestamp(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!m || +m[2] > 23 || +m[3] > 59 || +m[4] > 59) return null;
  const date = new Date(m[1] + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== m[1]) return null;
  if (m[5] !== 'Z' && (+m[5].slice(1, 3) > 23 || +m[5].slice(4) > 59)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
export function timestamp(value) {
  if (typeof value === 'string') return strictTimestamp(value.trim());
  if (!validCount(value)) return null;
  const date = new Date(value > 10_000_000_000 ? value : value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function finiteCount(value, fallback = 0) {
  if (!validCount(value)) return fallback;
  return value;
}
export function rawCodex(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const choose = (...keys) => {
    for (const k of keys) {
      const v =
        typeof u[k] === 'string' && /^\+?\d+$/.test(u[k].trim()) ? Number(u[k].trim()) : u[k];
      if (validCount(v)) return v;
    }
    return 0;
  };
  const input = choose('input_tokens', 'prompt_tokens', 'input'),
    output = choose('output_tokens', 'completion_tokens', 'output');
  const read = Math.min(
    input,
    choose('cached_input_tokens', 'cache_read_input_tokens', 'cached_tokens'),
  );
  const write = Math.min(
    input - read,
    choose('cache_write_input_tokens', 'cache_creation_input_tokens'),
  );
  return {
    input_tokens: input,
    cached_input_tokens: read,
    cache_write_input_tokens: write,
    output_tokens: output,
    reasoning_output_tokens: choose('reasoning_output_tokens', 'reasoning_tokens'),
    total_tokens: choose('total_tokens') || sum([input, output]),
  };
}
export const rawSignature = (u) => JSON.stringify(Object.values(u));
export const rawBuckets = (u) => ({
  inputTokens: Math.max(0, u.input_tokens - u.cached_input_tokens - u.cache_write_input_tokens),
  outputTokens: u.output_tokens,
  cacheCreationTokens: u.cache_write_input_tokens,
  cacheReadTokens: u.cached_input_tokens,
});
export const rawNonzero = (u) =>
  u && Object.entries(u).some(([k, v]) => k !== 'total_tokens' && v > 0);
export function subtract(current, previous) {
  const delta = Object.fromEntries(
    Object.entries(current).map(([k, v]) => [k, Math.max(0, v - (previous?.[k] ?? 0))]),
  );
  // 不再做 total 的回推：累计差分之后保留记录的 total delta。
  delta.cached_input_tokens = Math.min(delta.cached_input_tokens, delta.input_tokens);
  delta.cache_write_input_tokens = Math.min(
    delta.cache_write_input_tokens,
    delta.input_tokens - delta.cached_input_tokens,
  );
  return delta;
}
export function totalFallback(usage, total) {
  const missing = Math.max(0, total - sum(Object.values(usage)));
  let extraTotalTokens = 0;
  if (missing && !usage.outputTokens) usage.outputTokens = missing;
  else extraTotalTokens = missing;
  return { ...usage, extraTotalTokens };
}
export const EMPTY = () => ({ ...ZERO(), extraTotalTokens: 0 });
