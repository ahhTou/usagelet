import { alias, totalFallback } from '../compat.mjs';
import { buckets } from '../shared.mjs';
export async function zcode(paths, ctx) {
  const { DatabaseSync } = await import('node:sqlite'),
    seen = new Set(),
    out = [];
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
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
      const sessionColumns = new Set(
        db
          .prepare('PRAGMA table_info(session)')
          .all()
          .map((r) => r.name),
      );
      if (
        ![
          'id',
          'session_id',
          'started_at',
          'model_id',
          'status',
          'input_tokens',
          'output_tokens',
        ].every((k) => columns.has(k)) ||
        !['id', 'directory'].every((k) => sessionColumns.has(k))
      )
        throw Error('ZCode 数据库结构不兼容 ccusage 20.0.21');
      const fields = [
        'id',
        'session_id',
        'started_at',
        'model_id',
        'input_tokens',
        'output_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'computed_total_tokens',
      ]
        .map((k) =>
          columns.has(k)
            ? k
            : k === 'computed_total_tokens'
              ? `input_tokens + output_tokens AS ${k}`
              : `0 AS ${k}`,
        )
        .join(', ');
      for (const r of db
        .prepare(`SELECT ${fields} FROM model_usage WHERE status = 'completed'`)
        .iterate()) {
        if (
          typeof r.id !== 'string' ||
          !r.id.trim() ||
          typeof r.session_id !== 'string' ||
          !r.session_id.trim() ||
          typeof r.model_id !== 'string' ||
          !r.model_id.trim() ||
          !Number.isFinite(r.started_at) ||
          r.started_at <= 0 ||
          seen.has(r.id)
        )
          continue;
        const u = Object.fromEntries(
          [
            'input_tokens',
            'output_tokens',
            'cache_creation_input_tokens',
            'cache_read_input_tokens',
          ].map((k) => [k, number(r[k])]),
        );
        const data = totalFallback(buckets(u, 'zcode'), number(r.computed_total_tokens));
        if (!Object.values(data).some((v) => v > 0)) continue;
        seen.add(r.id);
        out.push({
          agent: 'zcode',
          model: alias(r.model_id.trim(), ctx.aliases),
          timestamp: Math.trunc(r.started_at),
          ...data,
        });
      }
    } finally {
      db.close();
    }
  }
  return out;
}
