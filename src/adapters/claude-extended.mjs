import { basename, dirname } from 'node:path';
import { records } from '../io.mjs';
import { BUCKETS, buckets, makeRecord, issue, sum, count } from '../shared.mjs';
export async function claude(files, ctx) {
  const seen = new Map(),
    routes = new Map();
  for (const file of files) {
    for await (const r of records(file, ctx, (l) => /"usage"\s*:/.test(l))) {
      const m = r.message;
      if (!m?.usage || (m.role && m.role !== 'assistant') || r.isApiErrorMessage) continue;
      if (m.model === '<synthetic>') continue;
      try {
        if (!m.id) throw new Error('用量记录缺少 message.id，无法可靠去重');
        const session = r.sessionId ?? basename(file).replace(/\.jsonl(?:\.(?:zst|zstd))?$/, '');
        const route = JSON.stringify([session, m.id]);
        const candidate = JSON.stringify([
          session,
          m.id,
          r.requestId ?? m.usage.request_id ?? r.timestamp,
        ]);
        const previousKey = routes.get(route);
        const key =
          previousKey && (r.isSidechain || seen.get(previousKey)?.sidechain)
            ? previousKey
            : candidate;
        const next = {
          ...makeRecord('claude', m.model, r.timestamp, buckets(m.usage)),
          sidechain: !!r.isSidechain,
        };
        const prev = seen.get(key);
        if (!prev) seen.set(key, next);
        else {
          // 保留完整快照，避免拼出不存在的逐字段最大值；主线优先于重放侧链。
          if (prev.model !== next.model) throw new Error('重复请求出现不同模型');
          const total = (row) => sum(BUCKETS.map((k) => row[k] ?? 0));
          if (prev.sidechain !== next.sidechain ? prev.sidechain : total(next) > total(prev))
            seen.set(key, next);
        }
        routes.set(route, key);
        for (const [index, u] of (m.usage.iterations ?? []).entries()) {
          if (u.type !== 'advisor_message') continue;
          const advisorKey = `${key}:advisor:${index}`;
          const advisor = makeRecord('claude', u.model, r.timestamp, buckets(u));
          const prevAdvisor = seen.get(advisorKey);
          if (
            !prevAdvisor ||
            sum(BUCKETS.map((k) => advisor[k] ?? 0)) > sum(BUCKETS.map((k) => prevAdvisor[k] ?? 0))
          )
            seen.set(advisorKey, advisor);
        }
      } catch (e) {
        issue(ctx, 'invalid_usage', file, e.message);
      }
    }
  }
  return [...seen.values()];
}
