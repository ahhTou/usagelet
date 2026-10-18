import { basename, sep } from 'node:path';
import { records } from '../io.mjs';
import { validCount, sum, BUCKETS } from '../shared.mjs';
import { strictTimestamp } from '../compat.mjs';
import { usageCost } from '../cost.mjs';

const FORBIDDEN_NULL = new Set([
  'id',
  'cwd',
  'model',
  'speed',
  'costUSD',
  'version',
  'sessionId',
  'requestId',
  'isApiErrorMessage',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
]);
function invalidNull(value, iteration = false) {
  if (Array.isArray(value)) return value.some((x) => invalidNull(x, iteration));
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([k, v]) =>
        (v === null && FORBIDDEN_NULL.has(k) && !(iteration && k === 'model')) ||
        invalidNull(v, k === 'iterations'),
    );
  return false;
}
function usage(u) {
  if (!u || !validCount(u.input_tokens) || !validCount(u.output_tokens)) return null;
  for (const k of ['cache_creation_input_tokens', 'cache_read_input_tokens'])
    if (u[k] !== undefined && !validCount(u[k])) return null;
  if (u.speed !== undefined && u.speed !== null && !['standard', 'fast'].includes(u.speed))
    return null;
  let write = u.cache_creation_input_tokens ?? 0;
  if (u.cache_creation !== undefined && u.cache_creation !== null) {
    const c = u.cache_creation;
    if (typeof c !== 'object' || Array.isArray(c)) return null;
    for (const k of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'])
      if (c[k] !== undefined && !validCount(c[k])) return null;
    write = sum([c.ephemeral_5m_input_tokens ?? 0, c.ephemeral_1h_input_tokens ?? 0]);
  }
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationTokens: write,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}
// ccusage 的 TokenUsageRaw：缺省计数为 0，cache_creation 明细按 5m / 1h 分别计价。
function rawUsage(u) {
  const c = u.cache_creation;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    speed: u.speed ?? undefined,
    cache_creation:
      c && typeof c === 'object'
        ? {
            ephemeral_5m_input_tokens: c.ephemeral_5m_input_tokens ?? 0,
            ephemeral_1h_input_tokens: c.ephemeral_1h_input_tokens ?? 0,
          }
        : undefined,
  };
}
function pathSession(file) {
  const parts = file.split(sep),
    i = parts.indexOf('projects'),
    p = i >= 0 ? parts.slice(i + 1) : parts;
  if (p.length === 2) return basename(file, '.jsonl');
  if (p.at(-2) === 'subagents' && p.length >= 4) return p.at(-3);
  return p.at(-2) ?? 'unknown';
}
function valid(r) {
  for (const k of ['sessionId', 'requestId', 'version'])
    if (r[k] !== undefined && (typeof r[k] !== 'string' || !r[k])) return false;
  if (r.version !== undefined && !/^\d+\.\d+\.\d/.test(r.version)) return false;
  if (r.costUSD !== undefined && (typeof r.costUSD !== 'number' || !Number.isFinite(r.costUSD)))
    return false;
  if (r.isSidechain !== undefined && r.isSidechain !== null && typeof r.isSidechain !== 'boolean')
    return false;
  for (const k of ['id', 'model'])
    if (r.message[k] !== undefined && (typeof r.message[k] !== 'string' || !r.message[k]))
      return false;
  return strictTimestamp(r.timestamp) !== null;
}
const total = (row) => sum(BUCKETS.map((k) => row[k]));
function replace(next, prev) {
  if (next.sidechain !== prev.sidechain) return prev.sidechain;
  if (total(next) !== total(prev)) return total(next) > total(prev);
  if (next.cost !== prev.cost) return next.cost > prev.cost;
  return next.speed !== undefined && prev.speed === undefined;
}
export async function claude(files, ctx) {
  const list = [],
    exact = new Map(),
    routes = new Map();
  function insert(row) {
    if (!row.id) {
      list.push(row);
      return;
    }
    const exactKey = JSON.stringify([
      row.id,
      row.request,
      row.session,
      row.request === undefined ? row.timestamp : null,
    ]);
    const route = JSON.stringify([row.id, row.session]);
    let index = exact.get(exactKey);
    if (index === undefined)
      index = (routes.get(route) ?? []).find((i) => row.sidechain || list[i].sidechain);
    if (index === undefined) {
      index = list.length;
      list.push(row);
      (routes.get(route) ?? routes.set(route, []).get(route)).push(index);
      exact.set(exactKey, index);
    } else if (replace(row, list[index])) {
      list[index] = row;
      exact.set(exactKey, index);
    }
  }
  for (const file of files)
    for await (const root of records(file, ctx, (l) => l.includes('"usage":{'))) {
      if (invalidNull(root)) continue;
      let r = root;
      if (!r.message?.usage && root.data?.message?.message?.usage)
        r = { ...root.data.message, sessionId: root.sessionId, version: undefined };
      if (!r.message || !valid(r)) continue;
      const main = usage(r.message.usage);
      if (!main) continue;
      const m = r.message,
        session = r.sessionId ?? pathSession(file),
        at = Date.parse(strictTimestamp(r.timestamp));
      const base = {
        timestamp: r.timestamp,
        agent: 'claude',
        session,
        request: r.requestId,
        sidechain: !!r.isSidechain,
      };
      // 费用在去重之前算：ccusage 的替换规则在 token 相同时比较的是算出的费用。
      const priced = usageCost(ctx, {
        model: m.model,
        usage: rawUsage(m.usage),
        costUSD: r.costUSD,
        timestamp: at,
      });
      insert({
        ...base,
        ...main,
        ...priced,
        speed: m.usage.speed,
        // 展示名在汇总时再解析别名；fast 模式追加 -fast，与 ccusage 一致。
        model:
          m.model === '<synthetic>' || !m.model
            ? null
            : m.model + (m.usage.speed === 'fast' ? '-fast' : ''),
        id: m.id,
      });
      let index = 0;
      const iterations = root.message?.usage?.iterations;
      if (
        !Array.isArray(iterations) ||
        iterations.some(
          (u) =>
            !u ||
            typeof u.type !== 'string' ||
            !usage(u) ||
            (u.model !== undefined && u.model !== null && typeof u.model !== 'string'),
        )
      )
        continue;
      for (const u of iterations) {
        if (u.type !== 'advisor_message' || typeof u.model !== 'string' || !u.model) continue;
        const parsed = usage(u);
        if (!parsed) continue;
        insert({
          ...base,
          ...parsed,
          ...usageCost(ctx, {
            model: u.model,
            usage: rawUsage(u),
            costUSD: undefined,
            timestamp: at,
          }),
          speed: u.speed,
          model: u.model,
          id: m.id ? `${m.id}:advisor:${index}` : undefined,
        });
        index++;
      }
    }
  return list;
}
