import { basename, dirname } from 'node:path';
import { records } from '../io.mjs';
import { BUCKETS, buckets, makeRecord, issue, sum, count } from '../shared.mjs';
export async function deepseek(files, ctx) {
  // 同一目录里的多个 format generation 是同一历史的迁移副本，只读最高版本。
  const selected = new Map(),
    other = [];
  for (const file of files) {
    const m = basename(file).match(/^session(?:\.v(\d+))?\.jsonl(?:\.(?:zst|zstd))?$/);
    if (!m) {
      other.push(file);
      continue;
    }
    const version = Number(m[1] ?? 0),
      key = dirname(file);
    if (!selected.has(key) || selected.get(key).version < version)
      selected.set(key, { file, version });
  }
  const settlements = new Map();
  for (const file of [...selected.values()].map((v) => v.file).concat(other)) {
    let id = file,
      model = null,
      epoch = 0;
    for await (const r of records(file, ctx)) {
      const d = r.data ?? {};
      if (r.type === 'session') {
        id = r.id ?? id;
        if (!Number.isInteger(r.version) || r.version < 0 || r.version > 4)
          throw new Error(`DeepSeek Harness 不支持的日志版本 ${r.version}`);
        if (r.isSeeded)
          issue(ctx, 'seeded_session', file, 'DeepSeek 会话带种子历史，当前尚未验证重放去重');
      }
      if (r.type === 'request/header') model = d.model ?? model;
      if (r.type === 'llm/retry-started') epoch++;
      if (!['assistant/message', 'assistant/attempt'].includes(r.type)) continue;
      const samples = (d.stream ?? []).filter(
        (x) => x.type === 'chunk' && x.chunk?.type === 'usage',
      );
      const usage = d.usage ?? samples.at(-1)?.chunk.usage;
      if (!usage) continue;
      try {
        if (!Number.isInteger(d.turn) || !Number.isInteger(d.step))
          throw new Error('DeepSeek 用量缺少 turn / step');
        const route = d.message?.source?.model ?? model;
        const record = makeRecord('deepseek', route, r.time, buckets(usage, 'deepseek'));
        // 同一步的快照是替换关系；明确重试边界后才叠加。
        settlements.set(JSON.stringify([id, d.turn, d.step, epoch]), record);
      } catch (e) {
        issue(ctx, 'invalid_usage', file, e.message);
      }
    }
  }
  return [...settlements.values()];
}
