import { stat } from 'node:fs/promises';
import { records } from '../io.mjs';
import { sum } from '../shared.mjs';
import {
  rawCodex,
  rawBuckets,
  rawSignature,
  rawNonzero,
  subtract,
  nonempty,
  timestamp,
  alias,
} from '../compat.mjs';
import fallbacks from './codex-auto-review-fallbacks.json' with { type: 'json' };
const modelFrom = (r) =>
  nonempty(r?.model) ?? nonempty(r?.model_name) ?? nonempty(r?.metadata?.model);
function modelFor(recorded, current, date) {
  const raw = recorded ?? current ?? 'gpt-5';
  return {
    current: raw,
    model:
      raw === 'codex-auto-review'
        ? (fallbacks.find((f) => String(date).slice(0, 10) >= f.releasedOn)?.model ?? 'gpt-5')
        : raw,
    fallback: (!recorded && !current) || raw === 'codex-auto-review',
  };
}
const SERVICE_TIERS = { default: 'standard', standard: 'standard', fast: 'fast', priority: 'fast' };
// 重复事件的档位合并：standard 优先于 fast（与 ccusage merge_codex_service_tiers 相同）。
const mergeTier = (a, b) =>
  a === 'standard' || b === 'standard' ? 'standard' : a === 'fast' || b === 'fast' ? 'fast' : null;
function resultFields(r) {
  return [r, r.data, r.result, r.response].filter((x) => x && typeof x === 'object');
}
function resultTime(fields) {
  for (const r of fields)
    for (const k of ['timestamp', 'created_at', 'createdAt']) {
      const t = timestamp(r[k]);
      if (t) return { value: t, raw: r[k] };
    }
  return null;
}
async function readSession(file, ctx) {
  let previous = null,
    model = null,
    meta = {},
    first = true,
    serviceTier = null;
  const events = [],
    mtime = (await stat(file)).mtime.toISOString();
  for await (const r of records(file, ctx)) {
    if (first) {
      if (r.type === 'session_meta')
        meta = {
          id: r.payload?.id,
          parent:
            r.payload?.forked_from_id ??
            r.payload?.source?.subagent?.thread_spawn?.parent_thread_id,
          time: timestamp(r.timestamp),
        };
      first = false;
    }
    const p = r.payload ?? {};
    if (r.type === 'turn_context') {
      model = modelFrom(p) ?? model;
      continue;
    }
    if (r.type === 'event_msg') {
      if (p.type !== 'token_count' && p.type !== 'thread_settings_applied') continue;
      const at = timestamp(r.timestamp);
      if (!at) continue;
      // 只影响费用：没有 service_tier 字段的设置事件不改变当前档位，无法识别的值清空档位。
      if (p.type === 'thread_settings_applied') {
        const tier = p.thread_settings?.service_tier;
        if (typeof tier === 'string')
          serviceTier = Object.hasOwn(SERVICE_TIERS, tier) ? SERVICE_TIERS[tier] : null;
        continue;
      }
      const info = p.info,
        total = rawCodex(info?.total_token_usage),
        last = rawCodex(info?.last_token_usage);
      const advanced = !total || !previous || rawSignature(total) !== rawSignature(previous);
      const raw = advanced && last ? last : total ? subtract(total, previous) : null;
      if (total) previous = total;
      if (!rawNonzero(raw)) continue;
      const resolved = modelFor(
        modelFrom(p) ?? modelFrom(info),
        model,
        typeof r.timestamp === 'string' ? r.timestamp : at,
      );
      model = resolved.current;
      events.push({
        raw,
        timestamp: at,
        model: resolved.model,
        fallback: resolved.fallback,
        serviceTier,
      });
      continue;
    }
    // session 专用事件不作为 headless usage 重读，尤其不额外计入 compaction。
    if (['turn_context', 'session_meta', 'token_usage_record', 'compacted'].includes(r.type))
      continue;
    const fields = resultFields(r),
      raw = fields.map((x) => rawCodex(x.usage)).find(Boolean);
    if (!raw || !Object.values(raw).some((x) => x > 0)) continue;
    const time = resultTime(fields) ?? { value: mtime, raw: mtime };
    const resolved = modelFor(
      fields.map(modelFrom).find(Boolean),
      model,
      typeof time.raw === 'string' ? time.raw : time.value,
    );
    model = resolved.current;
    events.push({
      raw,
      timestamp: time.value,
      model: resolved.model,
      fallback: resolved.fallback,
      serviceTier: null,
    });
  }
  return { file, meta, events };
}
function replayed(session, sessions) {
  const parentId = nonempty(session.meta.parent);
  if (!parentId) return session.events;
  const parent = sessions.find((s) => s !== session && s.meta.id === parentId);
  const prefix = parent
    ? parent.events.slice(
        0,
        session.meta.time
          ? parent.events.findIndex((e) => e.timestamp > session.meta.time) >= 0
            ? parent.events.findIndex((e) => e.timestamp > session.meta.time)
            : parent.events.length
          : parent.events.length,
      )
    : [];
  let matching = true,
    index = 0,
    burst = null;
  const events = session.events;
  const burstStart =
    events.length >= 2 &&
    Date.parse(events[1].timestamp) - Date.parse(events[0].timestamp) >= 0 &&
    Date.parse(events[1].timestamp) - Date.parse(events[0].timestamp) <= 1000
      ? Date.parse(events[0].timestamp)
      : null;
  return events.filter((e) => {
    if (matching) {
      if (prefix[index] && rawSignature(prefix[index].raw) === rawSignature(e.raw)) {
        index++;
        return false;
      }
      matching = false;
      if (index === 0) burst = burstStart;
    }
    if (burst !== null) {
      const ms = Date.parse(e.timestamp);
      if (ms - burst >= 0 && ms - burst <= 1000) {
        burst = ms;
        return false;
      }
      burst = null;
    }
    return true;
  });
}
// 返回去重后的事件（首次出现保留，重复事件只合并服务档位），由 cost.mjs 按 ccusage 的
// CodexGroup 规则按日聚合、计费。
export async function codex(files, ctx) {
  const sessions = [];
  for (const file of files) sessions.push(await readSession(file, ctx));
  const seen = new Map(),
    out = [];
  for (const session of sessions)
    for (const e of replayed(session, sessions)) {
      const model = alias(e.model, ctx.aliases),
        key = JSON.stringify([e.timestamp, model, rawSignature(e.raw)]);
      const existing = seen.get(key);
      if (existing) {
        existing.serviceTier = mergeTier(existing.serviceTier, e.serviceTier);
        continue;
      }
      const event = {
        agent: 'codex',
        model,
        timestamp: e.timestamp,
        raw: e.raw,
        ...rawBuckets(e.raw),
        reportedTotalTokens: e.raw.total_tokens,
        isFallbackModel: e.fallback,
        serviceTier: e.serviceTier,
      };
      seen.set(key, event);
      out.push(event);
    }
  return out;
}
