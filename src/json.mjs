// 保留 serde 对重复已知字段和整数字面量的校验，避免 JSON.parse 吞掉差异。
const integerKeys = new Set([
  'input_tokens',
  'prompt_tokens',
  'input',
  'cached_input_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cache_write_input_tokens',
  'cached_tokens',
  'output_tokens',
  'completion_tokens',
  'output',
  'reasoning_output_tokens',
  'reasoning_tokens',
  'total_tokens',
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
]);
const knownKeys = new Set([
  ...integerKeys,
  'message',
  'usage',
  'id',
  'model',
  'model_name',
  'timestamp',
  'created_at',
  'createdAt',
  'version',
  'sessionId',
  'requestId',
  'isSidechain',
  'costUSD',
  'speed',
  'cache_creation',
  'type',
  'payload',
  'info',
  'last_token_usage',
  'total_token_usage',
]);
export function parseCompatible(line) {
  const data = JSON.parse(line, (key, value, context) =>
    integerKeys.has(key) && typeof value === 'number' && /[.eE]/.test(context?.source ?? '')
      ? NaN
      : value,
  );
  const tokens = line.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g),
    stack = [];
  for (const [token] of tokens) {
    if (token === '{') {
      stack.push({ keys: new Set(), expectKey: true });
      continue;
    }
    if (token === '[') {
      stack.push(null);
      continue;
    }
    if (token === '}' || token === ']') {
      stack.pop();
      continue;
    }
    const frame = stack.at(-1);
    if (!frame) continue;
    if (token === ',') {
      frame.expectKey = true;
      continue;
    }
    if (token === ':') {
      frame.expectKey = false;
      continue;
    }
    if (frame.expectKey && token.startsWith('"')) {
      const key = JSON.parse(token);
      if (knownKeys.has(key) && frame.keys.has(key)) throw Error(`重复字段 ${key}`);
      frame.keys.add(key);
      frame.expectKey = false;
    }
  }
  return data;
}
