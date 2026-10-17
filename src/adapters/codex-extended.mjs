import { basename, dirname } from 'node:path';
import { records } from '../io.mjs';
import { BUCKETS, buckets, makeRecord, issue, sum, count } from '../shared.mjs';
const RAW_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
];
function rawCodex(u) {
  if (u.input_tokens === undefined || u.output_tokens === undefined)
    throw new Error('Codex 用量缺少 input_tokens / output_tokens');
  return Object.fromEntries(
    RAW_KEYS.map((k) => [
      k,
      count(k === 'cache_write_input_tokens' ? (u[k] ?? u.cache_creation_input_tokens) : u[k], 0),
    ]),
  );
}
const rawSignature = (u) => JSON.stringify(RAW_KEYS.map((k) => u[k]));
export async function codex(files, ctx) {
  const sessions = new Map(),
    responses = new Set();
  for (const file of files) {
    let id = file.replace(/\.(zst|zstd)$/, ''),
      parent = null,
      model = null,
      previous = null;
    const events = [],
      pending = new Map(),
      requests = new Map(),
      compacted = new Set();
    let latest = null;
    for await (const r of records(file, ctx, (l) =>
      /"(?:session_meta|turn_context|token_count|token_usage_record|compacted|thread_settings_applied)"/.test(
        l,
      ),
    )) {
      const p = r.payload ?? {};
      if (r.type === 'session_meta') {
        id = p.id ?? id;
        parent = p.forked_from_id ?? p.source?.subagent?.thread_spawn?.parent_thread_id ?? null;
      }
      if (r.type === 'turn_context') model = p.model ?? model;
      if (p.type === 'thread_settings_applied') model = p.thread_settings?.model ?? model;
      try {
        if (r.type === 'token_usage_record' && p.response_id && p.usage) {
          const raw = rawCodex(p.usage);
          const event = {
            record: makeRecord(
              'codex',
              p.model ?? model ?? 'unknown',
              r.timestamp,
              buckets(p.usage, 'codex'),
            ),
            raw,
            response: p.response_id,
            thread: p.thread_token_usage && rawSignature(rawCodex(p.thread_token_usage)),
          };
          pending.set(p.response_id, event);
          requests.set(p.response_id, event);
          latest = p.response_id;
          if (compacted.has(p.response_id)) {
            events.push(event);
            pending.delete(p.response_id);
          }
        }
        if (r.type === 'compacted' && p.compaction_response_id) {
          compacted.add(p.compaction_response_id);
          if (pending.has(p.compaction_response_id)) {
            events.push(pending.get(p.compaction_response_id));
            pending.delete(p.compaction_response_id);
          }
        }
        if (r.type !== 'event_msg' || p.type !== 'token_count' || !p.info) continue;
        const info = p.info,
          total = info.total_token_usage && rawCodex(info.total_token_usage);
        const advanced = !total || !previous || rawSignature(total) !== rawSignature(previous);
        let raw;
        if (advanced && info.last_token_usage) raw = rawCodex(info.last_token_usage);
        else if (total)
          raw = Object.fromEntries(
            RAW_KEYS.map((k) => [k, Math.max(0, total[k] - (previous?.[k] ?? 0))]),
          );
        if (total) previous = total;
        if (!raw || !RAW_KEYS.some((k) => raw[k] > 0)) continue;
        const candidate = requests.get(latest);
        if (
          advanced &&
          candidate &&
          (rawSignature(candidate.raw) === rawSignature(raw) ||
            (total && candidate.thread === rawSignature(total)))
        ) {
          pending.delete(latest);
          requests.delete(latest);
          const emitted = events.indexOf(candidate);
          if (emitted >= 0) events.splice(emitted, 1);
        }
        model = p.model ?? info.model ?? model;
        events.push({
          record: makeRecord('codex', model ?? 'unknown', r.timestamp, buckets(raw, 'codex')),
          raw,
        });
      } catch (e) {
        issue(ctx, 'invalid_usage', file, e.message);
      }
    }
    const session = sessions.get(id) ?? { parent, events: new Map(), file };
    for (const event of events) {
      const key = event.response
        ? `response:${event.response}`
        : JSON.stringify([event.record.timestamp, event.record.model, rawSignature(event.raw)]);
      session.events.set(key, event);
    }
    sessions.set(id, session);
  }
  const out = [],
    prefixes = new Map(),
    resolving = new Set();
  function visit(id) {
    if (prefixes.has(id)) return prefixes.get(id);
    if (resolving.has(id)) throw new Error('Codex 分支关系出现循环');
    resolving.add(id);
    const s = sessions.get(id);
    let parentEvents = [],
      skip = 0;
    if (s.parent) {
      if (sessions.has(s.parent)) parentEvents = visit(s.parent);
      else issue(ctx, 'missing_parent', s.file, 'Codex 分支父会话缺失，无法验证重放前缀');
    }
    const all = [...s.events.values()];
    const normal = all.filter((e) => !e.response);
    if (s.parent && parentEvents.length) {
      while (
        skip < normal.length &&
        skip < parentEvents.length &&
        rawSignature(normal[skip].raw) === rawSignature(parentEvents[skip].raw)
      )
        skip++;
    }
    let position = 0;
    for (const e of all) {
      if (e.response) {
        if (responses.has(e.response)) continue;
        responses.add(e.response);
      } else if (position++ < skip) continue;
      if (e.record.model === 'unknown')
        issue(ctx, 'unknown_model', s.file, 'Codex 用量缺少可确认的模型，归为 unknown');
      out.push(e.record);
    }
    resolving.delete(id);
    prefixes.set(id, normal);
    return normal;
  }
  for (const id of sessions.keys()) visit(id);
  return out;
}
