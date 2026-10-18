export const VERSION = '0.3.0';
export const AGENTS = ['claude', 'codex', 'zcode', 'dsh'];
export const BUCKETS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
export const ZERO = () => Object.fromEntries(BUCKETS.map((k) => [k, 0]));
export const compressed = (p) => /\.jsonl\.(zst|zstd)$/.test(p);
export const logFile = (p) => /\.jsonl(?:\.(?:zst|zstd))?$/.test(p);
export const validCount = (n) => Number.isSafeInteger(n) && n >= 0;
export const sum = (values) =>
  values.reduce((a, b) => {
    if (!Number.isSafeInteger(a + b)) throw new Error('token 总量超出 JS 安全整数范围');
    return a + b;
  }, 0);
export function count(n, fallback = null) {
  if (n === undefined || n === null) return fallback;
  if (!validCount(n)) throw new Error('token 字段必须是非负安全整数');
  return n;
}
export function buckets(u, style = 'claude') {
  const codex = style === 'codex',
    dsh = style === 'deepseek';
  let input = count(dsh ? u.inputTokens : u.input_tokens);
  const output = count(dsh ? u.outputTokens : u.output_tokens);
  let read = count(
    dsh ? u.cacheReadTokens : codex ? u.cached_input_tokens : u.cache_read_input_tokens,
    codex ? 0 : null,
  );
  let write = count(
    dsh
      ? u.cacheWriteTokens
      : codex
        ? (u.cache_write_input_tokens ?? u.cache_creation_input_tokens)
        : u.cache_creation_input_tokens,
    codex ? 0 : null,
  );
  if (style === 'claude' && u.cache_creation && typeof u.cache_creation === 'object') {
    write = sum([
      count(u.cache_creation.ephemeral_5m_input_tokens, 0),
      count(u.cache_creation.ephemeral_1h_input_tokens, 0),
    ]);
  }
  if (codex || style === 'zcode') {
    // 这两个来源的 input 已包含缓存；统一成互斥的四个桶。
    if (input !== null && read !== null && write !== null) {
      read = Math.min(read, input);
      write = Math.min(write, input - read);
      input -= read + write;
    } else input = null;
  }
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: write,
    cacheReadTokens: read,
  };
}
export function issue(ctx, code, source, message) {
  const key = `${code}:${source}`;
  const existing = ctx.issues.get(key);
  if (existing) existing.count++;
  else ctx.issues.set(key, { code, source, message, count: 1 });
}

export function makeRecord(agent, model, timestamp, usage) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('用量记录缺少模型标识');
  if (
    timestamp === undefined ||
    timestamp === null ||
    !Number.isFinite(new Date(timestamp).getTime())
  )
    throw new Error('用量记录缺少有效时间戳');
  return { agent, model: model.trim(), timestamp, ...usage };
}
