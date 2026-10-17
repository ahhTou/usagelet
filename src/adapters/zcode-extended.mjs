import { basename, dirname } from 'node:path';
import { records } from '../io.mjs';
import { BUCKETS, buckets, makeRecord, issue, sum, count } from '../shared.mjs';
export async function zcode(paths, ctx) {
  const { DatabaseSync } = await import('node:sqlite');
  const seen = new Set(),
    out = [];
  for (const path of paths) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(model_usage)')
          .all()
          .map((r) => r.name),
      );
      for (const k of ['id', 'model_id', 'started_at', 'input_tokens', 'output_tokens', 'status'])
        if (!columns.has(k)) throw new Error(`ZCode model_usage 缺少 ${k}`);
      const fields = [
        'id',
        'model_id',
        'started_at',
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
      ]
        .map((k) => (columns.has(k) ? k : `NULL AS ${k}`))
        .join(', ');
      for (const r of db
        .prepare(`SELECT ${fields} FROM model_usage WHERE status = 'completed'`)
        .iterate()) {
        if (seen.has(r.id)) continue;
        try {
          const next = makeRecord('zcode', r.model_id, r.started_at, buckets(r, 'zcode'));
          seen.add(r.id);
          out.push(next);
        } catch (e) {
          issue(ctx, 'invalid_usage', path, e.message);
        }
      }
    } finally {
      db.close();
    }
  }
  return out;
}
