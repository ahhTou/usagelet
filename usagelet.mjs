#!/usr/bin/env node
/*
 * usagelet · MIT · Copyright (c) 2026 ahhTou
 * 统计规则参考 ccusage（MIT，Copyright (c) 2025 ryoppippi）。
 * DeepSeek 持久化协议与 Zstd 帧扫描参考 DeepSeek Harness（MIT，2026 DeepSeek）。
 * 完整许可随单文件分发，见文件末尾。
 */
import { createReadStream, realpathSync } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';

export const VERSION = '0.1.0';
const AGENTS = ['claude', 'codex', 'zcode', 'deepseek'];
const BUCKETS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
const ZERO = () => Object.fromEntries(BUCKETS.map(k => [k, 0]));
const compressed = p => /\.jsonl\.(zst|zstd)$/.test(p);
const logFile = p => /\.jsonl(?:\.(?:zst|zstd))?$/.test(p);
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const sum = values => values.reduce((a, b) => {
  if (!Number.isSafeInteger(a + b)) throw new Error('token 总量超出 JS 安全整数范围');
  return a + b;
}, 0);
function count(n, fallback = null) {
  if (n === undefined || n === null) return fallback;
  if (!validCount(n)) throw new Error('token 字段必须是非负安全整数');
  return n;
}
function buckets(u, style = 'claude') {
  const codex = style === 'codex', dsh = style === 'deepseek';
  let input = count(dsh ? u.inputTokens : u.input_tokens);
  const output = count(dsh ? u.outputTokens : u.output_tokens);
  let read = count(dsh ? u.cacheReadTokens : codex ? u.cached_input_tokens : u.cache_read_input_tokens, codex ? 0 : null);
  let write = count(dsh ? u.cacheWriteTokens : codex ? u.cache_write_input_tokens ?? u.cache_creation_input_tokens : u.cache_creation_input_tokens, codex ? 0 : null);
  if (style === 'claude' && u.cache_creation && typeof u.cache_creation === 'object') {
    write = sum([count(u.cache_creation.ephemeral_5m_input_tokens, 0), count(u.cache_creation.ephemeral_1h_input_tokens, 0)]);
  }
  if (codex || style === 'zcode') {
    // 这两个来源的 input 已包含缓存；统一成互斥的四个桶。
    if (input !== null && read !== null && write !== null) {
      read = Math.min(read, input);
      write = Math.min(write, input - read);
      input -= read + write;
    } else input = null;
  }
  return { inputTokens: input, outputTokens: output, cacheCreationTokens: write, cacheReadTokens: read };
}
function issue(ctx, code, source, message) {
  const key = `${code}:${source}`;
  const existing = ctx.issues.get(key);
  if (existing) existing.count++;
  else ctx.issues.set(key, { code, source, message, count: 1 });
}

async function exists(p) {
  try { await stat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function walk(root, ctx) {
  const result = [], visited = new Set();
  async function visit(p) {
    const canonical = await realpath(p);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const info = await stat(canonical);
    if (info.isFile()) { if (logFile(canonical)) result.push(canonical); return; }
    if (!info.isDirectory()) return;
    for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // 不遍历日志目录外的符号链接，也不扫描配置、凭据或附件。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() || logFile(entry.name)) await visit(join(canonical, entry.name));
    }
  }
  await visit(root);
  const present = new Set(result);
  return result.filter(p => !(compressed(p) && present.has(p.replace(/\.(zst|zstd)$/, ''))))
    .filter(p => !ctx.noCompressed || !compressed(p)).sort();
}

// DSH 使用拼接 Zstd 帧；Node 22 的流式接口不能可靠跨帧，逐帧扫描后解压。
function frameSize(b) {
  if (b.length < 5) return null;
  if (b.readUInt32LE(0) !== 0xfd2fb528) throw new Error('Zstd 帧头损坏');
  const d = b[4];
  if (d & 0x18) throw new Error('Zstd 帧头包含保留位');
  const single = !!(d & 0x20), flag = d >>> 6, dict = d & 3;
  let offset = 5 + (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
  if (b.length < offset) return null;
  for (;;) {
    if (b.length < offset + 3) return null;
    const header = b.readUIntLE(offset, 3), type = header >>> 1 & 3;
    if (type === 3) throw new Error('Zstd 块类型无效');
    offset += 3 + (type === 1 ? 1 : header >>> 3);
    if (b.length < offset) return null;
    if (header & 1) break;
  }
  offset += d & 4 ? 4 : 0;
  return b.length < offset ? null : offset;
}
async function* dshFrames(file) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      const size = frameSize(pending);
      if (size === null) break;
      yield zlib.zstdDecompressSync(pending.subarray(0, size), { maxOutputLength: 64 * 1024 * 1024 });
      pending = pending.subarray(size);
    }
    if (pending.length > 64 * 1024 * 1024) throw new Error('单个 Zstd 帧超过 64 MiB 上限');
  }
  if (pending.length) throw new Error('末尾 Zstd 帧不完整；请等写入结束后重试');
}

// 流式解压，内存只保留当前行及用量元数据，不保存对话内容。
async function* records(file, ctx, interesting) {
  const input = createReadStream(file);
  let stream = input, pumping;
  if (compressed(file)) {
    if (typeof zlib.createZstdDecompress !== 'function') throw new Error('读取压缩日志需要支持 Zstd 的 Node.js（最低 22.16）');
    if (file.endsWith('.zstd')) {
      input.destroy();
      stream = Readable.from(dshFrames(file));
    } else {
      stream = zlib.createZstdDecompress();
      pumping = pipeline(input, stream).then(() => null, e => e);
    }
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo++;
      if (!line.trim() || (interesting && !interesting(line))) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('不是 JSON 对象');
        yield record;
      } catch (e) { issue(ctx, 'invalid_json', file, `第 ${lineNo} 行 JSON 损坏`); }
    }
    const error = await pumping;
    if (error) throw error;
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  } finally {
    lines.close(); input.destroy(); if (stream !== input) stream.destroy();
    if (pumping) await pumping;
  }
}
function makeRecord(agent, model, timestamp, usage) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('用量记录缺少模型标识');
  if (timestamp === undefined || timestamp === null || !Number.isFinite(new Date(timestamp).getTime())) throw new Error('用量记录缺少有效时间戳');
  return { agent, model: model.trim(), timestamp, ...usage };
}

async function claude(files, ctx) {
  const seen = new Map(), routes = new Map();
  for (const file of files) {
    for await (const r of records(file, ctx, l => /"usage"\s*:/.test(l))) {
      const m = r.message;
      if (!m?.usage || (m.role && m.role !== 'assistant') || r.isApiErrorMessage) continue;
      if (m.model === '<synthetic>') continue;
      try {
        if (!m.id) throw new Error('用量记录缺少 message.id，无法可靠去重');
        const session = r.sessionId ?? basename(file).replace(/\.jsonl(?:\.(?:zst|zstd))?$/, '');
        const route = JSON.stringify([session, m.id]);
        const candidate = JSON.stringify([session, m.id, r.requestId ?? m.usage.request_id ?? r.timestamp]);
        const previousKey = routes.get(route);
        const key = previousKey && (r.isSidechain || seen.get(previousKey)?.sidechain) ? previousKey : candidate;
        const next = { ...makeRecord('claude', m.model, r.timestamp, buckets(m.usage)), sidechain: !!r.isSidechain };
        const prev = seen.get(key);
        if (!prev) seen.set(key, next);
        else {
          // 保留完整快照，避免拼出不存在的逐字段最大值；主线优先于重放侧链。
          if (prev.model !== next.model) throw new Error('重复请求出现不同模型');
          const total = row => sum(BUCKETS.map(k => row[k] ?? 0));
          if (prev.sidechain !== next.sidechain ? prev.sidechain : total(next) > total(prev)) seen.set(key, next);
        }
        routes.set(route, key);
        for (const [index, u] of (m.usage.iterations ?? []).entries()) {
          if (u.type !== 'advisor_message') continue;
          const advisorKey = `${key}:advisor:${index}`;
          const advisor = makeRecord('claude', u.model, r.timestamp, buckets(u));
          const prevAdvisor = seen.get(advisorKey);
          if (!prevAdvisor || sum(BUCKETS.map(k => advisor[k] ?? 0)) > sum(BUCKETS.map(k => prevAdvisor[k] ?? 0))) seen.set(advisorKey, advisor);
        }
      } catch (e) { issue(ctx, 'invalid_usage', file, e.message); }
    }
  }
  return [...seen.values()];
}

const RAW_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
function rawCodex(u) {
  if (u.input_tokens === undefined || u.output_tokens === undefined) throw new Error('Codex 用量缺少 input_tokens / output_tokens');
  return Object.fromEntries(RAW_KEYS.map(k => [k, count(k === 'cache_write_input_tokens' ? u[k] ?? u.cache_creation_input_tokens : u[k], 0)]));
}
const rawSignature = u => JSON.stringify(RAW_KEYS.map(k => u[k]));
async function codex(files, ctx) {
  const sessions = new Map(), responses = new Set();
  for (const file of files) {
    let id = file.replace(/\.(zst|zstd)$/, ''), parent = null, model = null, previous = null;
    const events = [], pending = new Map(), requests = new Map(), compacted = new Set();
    let latest = null;
    for await (const r of records(file, ctx, l => /"(?:session_meta|turn_context|token_count|token_usage_record|compacted|thread_settings_applied)"/.test(l))) {
      const p = r.payload ?? {};
      if (r.type === 'session_meta') { id = p.id ?? id; parent = p.forked_from_id ?? p.source?.subagent?.thread_spawn?.parent_thread_id ?? null; }
      if (r.type === 'turn_context') model = p.model ?? model;
      if (p.type === 'thread_settings_applied') model = p.thread_settings?.model ?? model;
      try {
        if (r.type === 'token_usage_record' && p.response_id && p.usage) {
          const raw = rawCodex(p.usage);
          const event = { record: makeRecord('codex', p.model ?? model ?? 'unknown', r.timestamp, buckets(p.usage, 'codex')), raw, response: p.response_id, thread: p.thread_token_usage && rawSignature(rawCodex(p.thread_token_usage)) };
          pending.set(p.response_id, event); requests.set(p.response_id, event); latest = p.response_id;
          if (compacted.has(p.response_id)) { events.push(event); pending.delete(p.response_id); }
        }
        if (r.type === 'compacted' && p.compaction_response_id) {
          compacted.add(p.compaction_response_id);
          if (pending.has(p.compaction_response_id)) { events.push(pending.get(p.compaction_response_id)); pending.delete(p.compaction_response_id); }
        }
        if (r.type !== 'event_msg' || p.type !== 'token_count' || !p.info) continue;
        const info = p.info, total = info.total_token_usage && rawCodex(info.total_token_usage);
        const advanced = !total || !previous || rawSignature(total) !== rawSignature(previous);
        let raw;
        if (advanced && info.last_token_usage) raw = rawCodex(info.last_token_usage);
        else if (total) raw = Object.fromEntries(RAW_KEYS.map(k => [k, Math.max(0, total[k] - (previous?.[k] ?? 0))]));
        if (total) previous = total;
        if (!raw || !RAW_KEYS.some(k => raw[k] > 0)) continue;
        const candidate = requests.get(latest);
        if (advanced && candidate && (rawSignature(candidate.raw) === rawSignature(raw) || (total && candidate.thread === rawSignature(total)))) {
          pending.delete(latest); requests.delete(latest);
          const emitted = events.indexOf(candidate); if (emitted >= 0) events.splice(emitted, 1);
        }
        model = p.model ?? info.model ?? model;
        events.push({ record: makeRecord('codex', model ?? 'unknown', r.timestamp, buckets(raw, 'codex')), raw });
      } catch (e) { issue(ctx, 'invalid_usage', file, e.message); }
    }
    const session = sessions.get(id) ?? { parent, events: new Map(), file };
    for (const event of events) {
      const key = event.response ? `response:${event.response}` : JSON.stringify([event.record.timestamp, event.record.model, rawSignature(event.raw)]);
      session.events.set(key, event);
    }
    sessions.set(id, session);
  }
  const out = [], prefixes = new Map(), resolving = new Set();
  function visit(id) {
    if (prefixes.has(id)) return prefixes.get(id);
    if (resolving.has(id)) throw new Error('Codex 分支关系出现循环');
    resolving.add(id);
    const s = sessions.get(id);
    let parentEvents = [], skip = 0;
    if (s.parent) {
      if (sessions.has(s.parent)) parentEvents = visit(s.parent);
      else issue(ctx, 'missing_parent', s.file, 'Codex 分支父会话缺失，无法验证重放前缀');
    }
    const all = [...s.events.values()];
    const normal = all.filter(e => !e.response);
    if (s.parent && parentEvents.length) {
      while (skip < normal.length && skip < parentEvents.length && rawSignature(normal[skip].raw) === rawSignature(parentEvents[skip].raw)) skip++;
    }
    let position = 0;
    for (const e of all) {
      if (e.response) { if (responses.has(e.response)) continue; responses.add(e.response); }
      else if (position++ < skip) continue;
      if (e.record.model === 'unknown') issue(ctx, 'unknown_model', s.file, 'Codex 用量缺少可确认的模型，归为 unknown');
      out.push(e.record);
    }
    resolving.delete(id); prefixes.set(id, normal); return normal;
  }
  for (const id of sessions.keys()) visit(id);
  return out;
}

async function zcode(paths, ctx) {
  const { DatabaseSync } = await import('node:sqlite');
  const seen = new Set(), out = [];
  for (const path of paths) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
      const columns = new Set(db.prepare('PRAGMA table_info(model_usage)').all().map(r => r.name));
      for (const k of ['id', 'model_id', 'started_at', 'input_tokens', 'output_tokens', 'status']) if (!columns.has(k)) throw new Error(`ZCode model_usage 缺少 ${k}`);
      const fields = ['id', 'model_id', 'started_at', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map(k => columns.has(k) ? k : `NULL AS ${k}`).join(', ');
      for (const r of db.prepare(`SELECT ${fields} FROM model_usage WHERE status = 'completed'`).iterate()) {
        if (seen.has(r.id)) continue;
        try {
          const next = makeRecord('zcode', r.model_id, r.started_at, buckets(r, 'zcode'));
          seen.add(r.id); out.push(next);
        } catch (e) { issue(ctx, 'invalid_usage', path, e.message); }
      }
    } finally { db.close(); }
  }
  return out;
}

async function deepseek(files, ctx) {
  // 同一目录里的多个 format generation 是同一历史的迁移副本，只读最高版本。
  const selected = new Map(), other = [];
  for (const file of files) {
    const m = basename(file).match(/^session(?:\.v(\d+))?\.jsonl(?:\.(?:zst|zstd))?$/);
    if (!m) { other.push(file); continue; }
    const version = Number(m[1] ?? 0), key = dirname(file);
    if (!selected.has(key) || selected.get(key).version < version) selected.set(key, { file, version });
  }
  const settlements = new Map();
  for (const file of [...selected.values()].map(v => v.file).concat(other)) {
    let id = file, model = null, epoch = 0;
    for await (const r of records(file, ctx)) {
      const d = r.data ?? {};
      if (r.type === 'session') {
        id = r.id ?? id;
        if (!Number.isInteger(r.version) || r.version < 0 || r.version > 4) throw new Error(`DeepSeek Harness 不支持的日志版本 ${r.version}`);
        if (r.isSeeded) issue(ctx, 'seeded_session', file, 'DeepSeek 会话带种子历史，当前尚未验证重放去重');
      }
      if (r.type === 'request/header') model = d.model ?? model;
      if (r.type === 'llm/retry-started') epoch++;
      if (!['assistant/message', 'assistant/attempt'].includes(r.type)) continue;
      const samples = (d.stream ?? []).filter(x => x.type === 'chunk' && x.chunk?.type === 'usage');
      const usage = d.usage ?? samples.at(-1)?.chunk.usage;
      if (!usage) continue;
      try {
        if (!Number.isInteger(d.turn) || !Number.isInteger(d.step)) throw new Error('DeepSeek 用量缺少 turn / step');
        const route = d.message?.source?.model ?? model;
        const record = makeRecord('deepseek', route, r.time, buckets(usage, 'deepseek'));
        // 同一步的快照是替换关系；明确重试边界后才叠加。
        settlements.set(JSON.stringify([id, d.turn, d.step, epoch]), record);
      } catch (e) { issue(ctx, 'invalid_usage', file, e.message); }
    }
  }
  return [...settlements.values()];
}

function addBucket(target, row) {
  for (const k of BUCKETS) {
    target.knownTokens[k] = sum([target.knownTokens[k], row[k] ?? 0]);
    if (row[k] === null) target.missingFields.add(k);
  }
}
function newGroup() { return { knownTokens: ZERO(), missingFields: new Set(), records: 0 }; }
function finishGroup(g) {
  const values = Object.fromEntries(BUCKETS.map(k => [k, g.missingFields.has(k) ? null : g.knownTokens[k]]));
  return { ...values, totalTokens: g.missingFields.size ? null : sum(Object.values(g.knownTokens)), knownTokens: g.knownTokens, missingFields: [...g.missingFields].sort(), records: g.records };
}
export function aggregate(rows, options = {}) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: options.timezone ?? 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const groups = new Map(), totals = newGroup();
  for (const row of rows) {
    const parts = Object.fromEntries(format.formatToParts(new Date(row.timestamp)).map(x => [x.type, x.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (options.since && day < options.since || options.until && day > options.until) continue;
    if (BUCKETS.every(k => row[k] === 0)) continue;
    const key = JSON.stringify([day, row.agent, row.model]);
    const g = groups.get(key) ?? { day, agent: row.agent, model: row.model, ...newGroup() };
    addBucket(g, row); g.records++; groups.set(key, g);
    addBucket(totals, row); totals.records++;
  }
  const daily = new Map();
  for (const g of [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model))) {
    const day = daily.get(g.day) ?? { period: g.day, agents: [] };
    let agent = day.agents.find(a => a.agent === g.agent);
    if (!agent) { agent = { agent: g.agent, modelBreakdowns: [] }; day.agents.push(agent); }
    agent.modelBreakdowns.push({ modelName: g.model, ...finishGroup(g), cost: null, missingPricing: true });
    daily.set(g.day, day);
  }
  return { daily: [...daily.values()], totals: finishGroup(totals) };
}

export async function collect(options = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 16) throw new Error('usagelet 需要 Node.js >= 22.16');
  const ctx = { issues: new Map(), noCompressed: !!options.noCompressed };
  const selected = options.agents ?? AGENTS;
  for (const a of selected) if (!AGENTS.includes(a)) throw new Error(a === 'qoder' ? 'Qoder 已暂缓接入' : `未知来源 ${a}`);
  const home = options.home ?? homedir(), env = options.env ?? process.env;
  const defaults = {
    claude: env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR.split(',').map(p => basename(p.trim()) === 'projects' ? p.trim() : join(p.trim(), 'projects')) : [join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'claude/projects'), join(home, '.claude/projects')],
    codex: ['sessions', 'archived_sessions'].map(x => join(env.CODEX_HOME ?? join(home, '.codex'), x)),
    zcode: [join(env.ZCODE_HOME ?? join(home, '.zcode'), 'cli/db/db.sqlite')],
    deepseek: [join(env.DSH_HOME ?? join(home, '.dsh'), 'sessions')],
  };
  const sources = [], rows = [];
  for (const agent of selected) {
    const explicit = options.sources?.[agent], paths = explicit ?? defaults[agent];
    const found = [];
    for (const p of paths) {
      if (await exists(p)) found.push(await realpath(p));
      else if (explicit) throw new Error(`指定的 ${agent} 数据源不存在：${p}`);
    }
    const files = new Set();
    for (const p of new Set(found)) {
      if (agent === 'zcode') files.add(p);
      else for (const file of await walk(p, ctx)) files.add(file);
    }
    const before = rows.length;
    if (files.size) {
      const adapter = { claude, codex, zcode, deepseek }[agent];
      for (const row of await adapter([...files].sort(), ctx)) rows.push(row);
    }
    sources.push({ agent, status: !found.length ? 'not_found' : rows.length === before ? 'no_usage' : 'ok', files: files.size, records: rows.length - before });
  }
  const warnings = [...ctx.issues.values()];
  const data = aggregate(rows, options);
  return { metadata: { tool: 'usagelet', version: VERSION, timezone: options.timezone ?? 'Asia/Shanghai', complete: warnings.length === 0 && data.totals.missingFields.length === 0, compressedLogs: !options.noCompressed, sources, warnings }, ...data };
}
const HELP = `usagelet ${VERSION} · 本机 Agent 用量统计（Node.js >= 22.16）
用法：node usagelet.mjs [daily] [选项]
  --json                  输出 JSON；默认显示终端汇总
  --agent <来源>          claude,codex,zcode,deepseek，可用逗号选择多个
  --source <来源=路径>    指定日志目录 / 文件；ZCode 指向 SQLite 文件，可重复
  --tz <时区>             默认 Asia/Shanghai
  --since <YYYY-MM-DD>    起始日期（包含）
  --until <YYYY-MM-DD>    结束日期（包含）
  --no-compressed         仅用于与旧工具对账；主动排除压缩日志
  --by-agent -O           兼容 ccusage 调用；离线采集本来就不请求定价
  --version               显示版本
Qoder 暂缓接入。只读取日志与用量表，不读取凭据、不上传任何数据。
JSON 中缺失的计数为 null，并附 knownTokens / missingFields。
退出码：0 完整统计；2 存在数据质量警告；1 无法完成采集。`;
function dateOption(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`无效日期 ${value}`);
  return value;
}
export async function main(args = process.argv.slice(2)) {
  const options = { sources: {} }; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--help', '-h'].includes(arg)) { console.log(HELP); return 0; }
    if (arg === '--version') { console.log(VERSION); return 0; }
    if (arg === 'daily' && i === 0 || ['--by-agent', '-O', '--offline'].includes(arg)) continue;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--no-compressed') { options.noCompressed = true; continue; }
    if (!['--agent', '--source', '--tz', '--since', '--until'].includes(arg)) throw new Error(`未知参数 ${arg}`);
    const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (arg === '--agent') options.agents = [...new Set(value.split(','))];
    if (arg === '--tz') { new Intl.DateTimeFormat('en', { timeZone: value }); options.timezone = value; }
    if (arg === '--since') options.since = dateOption(value);
    if (arg === '--until') options.until = dateOption(value);
    if (arg === '--source') {
      const at = value.indexOf('='), agent = value.slice(0, at);
      if (at < 1 || !AGENTS.includes(agent) || !value.slice(at + 1)) throw new Error('--source 格式为 来源=路径（Qoder 暂缓）');
      (options.sources[agent] ??= []).push(resolve(value.slice(at + 1)));
    }
  }
  if (options.since && options.until && options.since > options.until) throw new Error('--since 不能晚于 --until');
  const result = await collect(options);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`usagelet ${VERSION} · ${result.metadata.timezone}`);
    console.log('日期        来源      模型                         输入         输出       缓存写入       缓存读取');
    for (const d of result.daily) for (const a of d.agents) for (const m of a.modelBreakdowns) console.log(`${d.period}  ${a.agent.padEnd(9)} ${m.modelName.padEnd(28)} ${BUCKETS.map(k => String(m[k] ?? '未知').padStart(12)).join(' ')}`);
    console.log(`\n${result.daily.length} 天 · 总 token：${result.totals.totalTokens ?? '不完整，见 JSON 的已知计数'}`);
    for (const source of result.metadata.sources) console.log(`${source.agent}: ${source.status} · ${source.files} 文件 · ${source.records} 条用量`);
  }
  for (const w of result.metadata.warnings) console.error(`[${w.code}] ${w.source}: ${w.message}（${w.count} 次）`);
  if (!result.metadata.complete) console.error('统计存在缺失或未确认项；请勿直接替换云端历史。');
  return result.metadata.complete ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, e => { console.error(`usagelet: ${e.message}`); process.exitCode = 1; });
}

/*
上游参考许可：
MIT License
Copyright (c) 2025 ryoppippi
Copyright (c) 2026 DeepSeek
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
