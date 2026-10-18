// DeepSeek Harness（DSH）会话日志采集。
//
// 口径对齐 DSH 自身的 tokenUsage 投影（@deepseek-ai/dsh-token-meter，usage-projection）：
// - 只有 assistant/message 与 assistant/attempt 计费；message 优先用 data.usage，否则取内嵌流里最后一个 usage 块；
// - 同一 (turn, step) 的后一个样本替换前一个（相同则不变）；llm/retry-started 关闭替换槽，重试另算一次；
// - DSH 的 inputTokens 本身就是未命中缓存的输入，与缓存读写互斥，总量为四桶之和（reasoning 属于 output）。
// 跨会话统计时只计每个会话自己的事件：分叉 / 子智能体会话继承的前缀是父会话事件的副本，
// 截点与 DSH 的 inheritedEventCount 一致（v2+ 为最后一个 inherited 的 session/end-seed，v0/v1 为 seedLength）。
// 历史 v0/v1 的顶层 assistant/chunk 按 dsh-session-format-v1-to-v2 的规则归组为尝试，再按上面的口径折叠。
import { createReadStream } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { issue } from '../shared.mjs';
import { dshCost } from '../cost.mjs';

// 与 dsh-session-format 的 CANONICAL_LOG_FILENAME 一致：v0 不带 .v0，正版本无前导零；压缩时追加 .zstd。
export const DSH_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;
const PACKED = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);
// 只解析与用量、路由、归组、继承截点有关的行；其他行（工具结果、正文等）只看类型前缀。
const RELEVANT = new Set([
  'session',
  'assistant/message',
  'assistant/attempt',
  'assistant/chunk',
  'llm/retry',
  'llm/retry-started',
  'request/header',
  'request/context',
  'session/end-seed',
  'turn/start',
  'turn/end',
  'step/end',
  'compaction/summary',
  'compact/summary',
  ...PACKED,
]);
const TYPE_PREFIX = /^\{"type":"([^"\\]+)"/;
const MAX_FRAME = 64 * 1024 * 1024;
export const LATEST_VERSION = 4;

const count = (n) => Number.isSafeInteger(n) && n >= 0;

// ——— 发现 ———

// 每个会话目录只取编号最高的规范代际（与 DSH 运行时一致，旧代际是迁移前的只读存档）。
export async function dshFiles(paths, ctx) {
  const selected = new Map(),
    visited = new Set();
  async function visit(path, explicit) {
    const canonical = await realpath(path);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const info = await stat(canonical);
    if (info.isFile()) {
      // 显式指定的单个文件不要求规范文件名。
      if (explicit) selected.set(canonical, { file: canonical });
      return;
    }
    if (!info.isDirectory()) return;
    const entries = (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    let best = null;
    for (const entry of entries) {
      // 不跟随符号链接，也不进入凭据、配置等非会话目录以外的链接目标。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(join(canonical, entry.name), false);
        continue;
      }
      const m = entry.isFile() && entry.name.match(DSH_LOG);
      if (!m) continue;
      const version = m[1] === undefined ? 0 : Number(m[1]),
        compressed = !!m[2],
        file = join(canonical, entry.name);
      if (!best || version > best.version) best = { file, version, compressed };
      else if (version === best.version) {
        // DSH 不允许同一根目录混用两种编码；遇到时取压缩版并提示。
        issue(
          ctx,
          'dsh_mixed_encoding',
          canonical,
          'DSH 会话目录同时有压缩与未压缩日志，已取压缩版',
        );
        if (compressed) best = { file, version, compressed };
      }
    }
    if (best) selected.set(best.file, best);
  }
  for (const path of paths) await visit(path, true);
  return [...selected.keys()].sort();
}

// ——— 读取 ———

// DSH 压缩日志是多个独立 Zstd 帧的拼接；Node 的 zstdDecompressSync 只解第一帧、截断帧不报错，
// 所以先按帧头扫描出完整帧再逐帧解压。返回 null 表示数据不足一帧。
function frameSize(b) {
  if (b.length < 8) return null;
  const magic = b.readUInt32LE(0);
  if ((magic & 0xfffffff0) === 0x184d2a50)
    return 8 + b.readUInt32LE(4) <= b.length ? 8 + b.readUInt32LE(4) : null;
  if (magic !== 0xfd2fb528) throw new Error('Zstd 帧头损坏');
  const d = b[4];
  if (d & 0x08) throw new Error('Zstd 帧头包含保留位');
  const single = !!(d & 0x20),
    flag = d >>> 6,
    dict = d & 3;
  let offset =
    5 + (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
  for (;;) {
    if (b.length < offset + 3) return null;
    const header = b.readUIntLE(offset, 3),
      type = (header >>> 1) & 3;
    if (type === 3) throw new Error('Zstd 块类型无效');
    offset += 3 + (type === 1 ? 1 : header >>> 3);
    if (b.length < offset) return null;
    if (header & 1) break;
  }
  offset += d & 4 ? 4 : 0;
  return b.length < offset ? null : offset;
}

// 产出解压后的字节块。末尾不完整的帧（写入中途或崩溃）只取能解出的部分，与 DSH 的
// “残缺末帧只贡献其中完整的 JSONL 行”一致；完整帧校验失败视为损坏，停止读取并告警。
async function* zstdChunks(file, ctx) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      let size;
      try {
        size = frameSize(pending);
      } catch (e) {
        issue(ctx, 'dsh_corrupt', file, `DSH 日志损坏（${e.message}），只统计损坏位置之前的记录`);
        return;
      }
      if (size === null) break;
      const frame = pending.subarray(0, size);
      pending = pending.subarray(size);
      if ((frame.readUInt32LE(0) & 0xfffffff0) === 0x184d2a50) continue;
      try {
        yield zlib.zstdDecompressSync(frame, { maxOutputLength: MAX_FRAME });
      } catch (e) {
        issue(ctx, 'dsh_corrupt', file, `DSH 日志损坏（${e.message}），只统计损坏位置之前的记录`);
        return;
      }
    }
    if (pending.length > MAX_FRAME) {
      issue(ctx, 'dsh_corrupt', file, '单个 Zstd 帧超过 64 MiB 上限，已停止读取该会话');
      return;
    }
  }
  if (pending.length >= 8 && pending.readUInt32LE(0) === 0xfd2fb528) {
    try {
      yield zlib.zstdDecompressSync(pending, { maxOutputLength: MAX_FRAME });
    } catch {
      // 残缺末帧解不出任何完整块时忽略即可。
    }
  }
}

// 逐行产出 { line, index }：只在遇到换行时才算一行完整记录，末尾没有换行的残行按 DSH 的规则丢弃。
async function* lines(file, ctx) {
  const source = file.endsWith('.zstd') ? zstdChunks(file, ctx) : createReadStream(file);
  let rest = Buffer.alloc(0),
    index = 0;
  for await (const chunk of source) {
    let buffer = rest.length ? Buffer.concat([rest, chunk]) : chunk,
      start = 0;
    for (let i = buffer.indexOf(10); i >= 0; i = buffer.indexOf(10, start)) {
      const line = buffer.toString('utf8', start, i);
      start = i + 1;
      if (line.trim()) yield { line, index: index++ };
    }
    rest = buffer.subarray(start);
  }
}

// ——— 解析单个会话 ———

const usageChunk = (stream) => {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--) {
    const r = stream[i];
    if (r && r.type === 'chunk' && r.chunk && r.chunk.type === 'usage') return r.chunk.usage;
  }
  return undefined;
};
const routeOf = (value) =>
  value && typeof value.model === 'string' && value.model.trim()
    ? {
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: value.model.trim(),
      }
    : null;

// 返回会话头、继承截点和按出现顺序排列的用量候选（尚未折叠）。
export async function readDshSession(file, ctx, { extended = false } = {}) {
  let header = null,
    version = null,
    route = null,
    seq = 0,
    taggedCut,
    bad = 0;
  const samples = [],
    compactions = [];
  // v0/v1：顶层 assistant/chunk 与打包行组成的尝试组，规则见 dsh-session-format-v1-to-v2。
  let group = null;
  const finishGroup = () => {
    if (!group) return;
    if (group.usage !== undefined)
      samples.push({
        kind: 'attempt',
        seq: group.lastSeq,
        time: group.lastTime,
        turn: group.turn,
        step: group.step,
        usage: group.usage,
        route: group.route,
      });
    group = null;
  };
  const extendGroup = (turn, step, firstSeq, n, time) => {
    if (group && (group.terminal || group.turn !== turn || group.step !== step)) finishGroup();
    group ??= { turn, step, seqs: [], usage: undefined, terminal: false, route };
    for (let i = 0; i < n; i++) group.seqs.push(firstSeq + i);
    group.lastSeq = firstSeq + n - 1;
    group.lastTime = time;
  };

  for await (const { line, index } of lines(file, ctx)) {
    const prefix = TYPE_PREFIX.exec(line);
    if (prefix && !RELEVANT.has(prefix[1])) {
      seq++;
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('不是 JSON 对象');
    } catch {
      bad++;
      if (index > 0) seq++;
      continue;
    }
    if (index === 0) {
      if (row.type !== 'session') {
        issue(ctx, 'dsh_header', file, 'DSH 日志首行不是会话头，已跳过该文件');
        return null;
      }
      header = row;
      version = row.version;
      if (!count(version)) {
        issue(
          ctx,
          'dsh_header',
          file,
          `DSH 会话头版本无效（${JSON.stringify(version)}），已跳过该文件`,
        );
        return null;
      }
      if (version > LATEST_VERSION)
        issue(
          ctx,
          'dsh_untested_version',
          file,
          `DSH 日志格式 v${version} 尚未验证，按 v${LATEST_VERSION} 规则尽力统计`,
        );
      continue;
    }
    if (!header) continue;
    const legacy = version <= 1;
    // 打包行占用一段连续 seq；只携带文本/推理/工具参数增量，不含用量。
    if (PACKED.has(row.type)) {
      const d = row.data ?? {},
        n = Array.isArray(d.texts) ? d.texts.length : Array.isArray(d.args) ? d.args.length : 0;
      const first = count(row.seq0) ? row.seq0 : seq;
      if (legacy && n > 0 && count(d.turn) && count(d.step))
        extendGroup(d.turn, d.step, first, n, row.time0 ?? 0);
      seq = first + Math.max(n, 1);
      continue;
    }
    const at = count(row.seq) ? row.seq : seq;
    seq = at + 1;
    const d = row.data && typeof row.data === 'object' ? row.data : {};
    switch (row.type) {
      case 'request/header':
        route = routeOf(d.header?.config) ?? route;
        break;
      case 'request/context':
        route = routeOf(d) ?? route;
        break;
      case 'session/end-seed':
        if (d.inherited === true) taggedCut = at;
        break;
      case 'llm/retry-started':
        if (legacy) finishGroup();
        samples.push({ kind: 'retry', seq: at, turn: d.turn, step: d.step });
        break;
      case 'turn/start':
        if (legacy && group && group.turn !== d.turn) finishGroup();
        break;
      case 'turn/end':
      case 'step/end':
      case 'llm/retry':
        if (legacy) finishGroup();
        break;
      case 'assistant/chunk': {
        if (!legacy || !count(d.turn) || !count(d.step)) break;
        extendGroup(d.turn, d.step, at, 1, row.time);
        if (d.chunk?.type === 'usage') group.usage = d.chunk.usage;
        if (d.chunk?.type === 'finish') group.terminal = true;
        break;
      }
      case 'assistant/attempt':
        samples.push({
          kind: 'attempt',
          seq: at,
          time: row.time,
          turn: d.turn,
          step: d.step,
          usage: usageChunk(d.stream),
          route,
        });
        break;
      case 'assistant/message': {
        const message = d.message && typeof d.message === 'object' ? d.message : null;
        // v0 早期结构把来源写在 data.provenance，迁移时改成 message.source。
        const source = routeOf(message?.source) ?? routeOf(d.provenance);
        let streamUsage = usageChunk(d.stream);
        if (legacy) {
          // 引用了当前尝试组的全部块才算认领；否则当前组按未认领尝试结算。
          const cites = Array.isArray(row.sourceEventSeqs) ? expandSeqs(row.sourceEventSeqs) : null;
          const claims =
            group &&
            group.turn === d.turn &&
            group.step === d.step &&
            cites &&
            cites.length > 0 &&
            cites.length === group.seqs.length &&
            cites.every((s, i) => s === group.seqs[i]);
          if (claims) {
            streamUsage = group.usage;
            group = null;
          } else {
            if (cites && cites.length > 0 && group)
              issue(
                ctx,
                'dsh_legacy_chunks',
                file,
                'v0/v1 消息引用的流式块与尝试组不一致，按未认领尝试处理',
              );
            finishGroup();
          }
        }
        samples.push({
          kind: 'message',
          seq: at,
          time: row.time,
          turn: d.turn,
          step: d.step,
          usage: d.usage !== undefined ? d.usage : streamUsage,
          route: source ?? route,
        });
        break;
      }
      case 'compaction/summary':
      case 'compact/summary':
        if (extended && d.usage !== undefined)
          compactions.push({
            seq: at,
            time: row.time,
            id: d.compactionId ?? `legacy-compaction:${at}`,
            usage: d.usage,
            route: routeOf(d) ?? route,
          });
        break;
    }
  }
  finishGroup();
  if (!header) {
    issue(ctx, 'dsh_header', file, 'DSH 日志为空或缺少会话头，已跳过该文件');
    return null;
  }
  if (bad) issue(ctx, 'invalid_json', file, `DSH 日志有 ${bad} 行 JSON 损坏，已跳过这些行`);
  // 继承截点：v0/v1 来自会话头 seedLength，v2+ 来自最后一个 inherited 的 end-seed 标记。
  const seeded = version <= 1 ? header.seedLength !== undefined : header.isSeeded === true;
  let cut = 0;
  if (version <= 1) cut = seeded && count(header.seedLength) ? header.seedLength : 0;
  else if (seeded) {
    if (taggedCut === undefined) {
      issue(ctx, 'dsh_seed_cut', file, '分叉会话缺少继承截点标记，无法区分自有用量，已跳过该会话');
      cut = Infinity;
    } else cut = taggedCut;
  } else if (taggedCut !== undefined) {
    issue(ctx, 'dsh_seed_cut', file, '未标记为分叉的会话含继承截点标记，按标记位置排除继承前缀');
    cut = taggedCut;
  }
  return {
    file,
    id: typeof header.id === 'string' && header.id ? header.id : file,
    version,
    seeded,
    cut,
    createdAt: count(header.createdAt) ? header.createdAt : null,
    samples,
    compactions,
  };
}

function expandSeqs(list) {
  const out = [];
  for (const entry of list) {
    if (count(entry)) out.push(entry);
    else if (Array.isArray(entry) && entry.length === 2 && count(entry[0]) && count(entry[1]))
      for (let s = entry[0]; s <= entry[1] && out.length < 1_000_000; s++) out.push(s);
  }
  return out;
}

// 校验并换算成四个互斥的桶；与 usage-projection 的 bucketsFrom 相同（缓存缺省为 0）。
export function dshBuckets(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (!count(inputTokens) || !count(outputTokens)) return null;
  if (cacheReadTokens !== undefined && !count(cacheReadTokens)) return null;
  if (cacheWriteTokens !== undefined && !count(cacheWriteTokens)) return null;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens: cacheWriteTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
  };
}
const sameBuckets = (a, b) =>
  a.inputTokens === b.inputTokens &&
  a.outputTokens === b.outputTokens &&
  a.cacheCreationTokens === b.cacheCreationTokens &&
  a.cacheReadTokens === b.cacheReadTokens;

// 按 tokenUsage 投影折叠会话自有事件，返回计费样本（每个尝试一条）。
export function foldDshSession(session, ctx) {
  const out = [],
    ordinals = new Map();
  let last = null;
  for (const s of session.samples) {
    if (s.seq < session.cut) continue;
    if (s.kind === 'retry') {
      if (last && last.turn === s.turn && last.step === s.step) last = null;
      continue;
    }
    if (s.usage === undefined) continue;
    const buckets = dshBuckets(s.usage);
    if (!buckets || !count(s.turn) || !count(s.step)) {
      issue(ctx, 'dsh_invalid_usage', session.file, 'DSH 用量记录字段无效，已跳过该条');
      continue;
    }
    const time = count(s.time) && s.time > 0 ? s.time : session.createdAt;
    const entry = {
      sessionId: session.id,
      turn: s.turn,
      step: s.step,
      time,
      route: s.route,
      ...buckets,
    };
    if (last && last.turn === s.turn && last.step === s.step) {
      const previous = out[last.index];
      if (sameBuckets(previous, buckets)) continue;
      out[last.index] = { ...entry, ordinal: previous.ordinal };
      continue;
    }
    const key = `${s.turn}:${s.step}`,
      ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    out.push({ ...entry, ordinal });
    last = { turn: s.turn, step: s.step, index: out.length - 1 };
  }
  return out;
}

// 采集入口：返回统一用量记录。同一会话 id 出现在多份日志里（备份、多个 DSH_HOME）时只取一份：
// 格式版本高者优先，其次文件更大者（日志只追加，较大的是较新的副本）。
export async function dsh(files, ctx, { extended = false } = {}) {
  const sessions = new Map();
  for (const file of files) {
    const session = await readDshSession(file, ctx, { extended });
    if (!session) continue;
    session.size = (await stat(file)).size;
    const existing = sessions.get(session.id);
    if (!existing) {
      sessions.set(session.id, session);
      continue;
    }
    issue(
      ctx,
      'dsh_duplicate_session',
      session.id,
      '同一 DSH 会话出现在多份日志中，只统计其中一份',
    );
    if (
      session.version > existing.version ||
      (session.version === existing.version && session.size > existing.size)
    )
      sessions.set(session.id, session);
  }
  const rows = [];
  const record = (entry, session, id) => {
    if (!entry.route)
      issue(ctx, 'dsh_unknown_model', session.file, 'DSH 用量记录找不到模型路由，记为 unknown');
    const row = {
      agent: 'dsh',
      id,
      sessionId: session.id,
      model: entry.route?.model ?? 'unknown',
      provider: entry.route?.provider ?? '',
      timestamp: entry.time ?? 0,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      cacheReadTokens: entry.cacheReadTokens,
    };
    return ctx.pricing ? { ...row, ...dshCost(ctx, row) } : row;
  };
  for (const session of sessions.values()) {
    for (const entry of foldDshSession(session, ctx))
      rows.push(
        record(entry, session, `dsh:${session.id}:${entry.turn}:${entry.step}:${entry.ordinal}`),
      );
    // 扩展模式另计压缩摘要请求的用量；DSH 自己的 tokenUsage 不含这部分。
    for (const c of session.compactions) {
      if (c.seq < session.cut) continue;
      const buckets = dshBuckets(c.usage);
      if (!buckets) {
        issue(ctx, 'dsh_invalid_usage', session.file, 'DSH 压缩用量字段无效，已跳过该条');
        continue;
      }
      const time = count(c.time) && c.time > 0 ? c.time : session.createdAt;
      rows.push(
        record(
          { time, route: c.route, ...buckets },
          session,
          `dsh:${session.id}:compaction:${c.id}`,
        ),
      );
    }
  }
  // 与社区 DSH 适配器相同的稳定顺序：时间、会话、条目 id。
  rows.sort((a, b) =>
    a.timestamp !== b.timestamp
      ? a.timestamp - b.timestamp
      : a.sessionId !== b.sessionId
        ? a.sessionId < b.sessionId
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  return rows;
}
