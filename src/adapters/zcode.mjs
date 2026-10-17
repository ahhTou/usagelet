import { alias, totalFallback } from '../compat.mjs';
import { buckets, issue } from '../shared.mjs';
const REQUIRED_MODEL_COLUMNS = [
  'id',
  'session_id',
  'started_at',
  'model_id',
  'status',
  'input_tokens',
  'output_tokens',
];
const REQUIRED_SESSION_COLUMNS = ['id', 'directory'];
// 表不存在时 PRAGMA table_info 返回空集，按缺少全部必需列处理。
export const tableColumns = (db, table) =>
  new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name),
  );
const missingColumns = (table, columns, required) => {
  if (!columns.size) return [`${table} 表`];
  const missing = required.filter((k) => !columns.has(k));
  return missing.length ? [`${table}: ${missing.join(', ')}`] : [];
};
export async function zcode(paths, ctx) {
  const { DatabaseSync } = await import('node:sqlite'),
    seen = new Set(),
    out = [];
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  for (const path of paths) {
    // 与上游 loader.rs 一致：单个数据库打不开、结构不符或中途读失败，只跳过这一个库，
    // 不影响其他来源；上游只写调试日志，这里额外记警告，避免静默漏掉数据源。
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
      const columns = tableColumns(db, 'model_usage'),
        sessionColumns = tableColumns(db, 'session');
      const missing = [
        ...missingColumns('model_usage', columns, REQUIRED_MODEL_COLUMNS),
        ...missingColumns('session', sessionColumns, REQUIRED_SESSION_COLUMNS),
      ];
      if (missing.length) {
        issue(
          ctx,
          'zcode_schema',
          path,
          `ZCode 数据库结构不兼容 ccusage 20.0.21（缺少 ${missing.join('；')}），已跳过`,
        );
        continue;
      }
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
    } catch (e) {
      // 上游查询失败返回空，逐行读取失败则保留已读到的部分；这里同样保留已收集的行。
      issue(ctx, 'zcode_unreadable', path, `读取 ZCode 数据库失败：${e.message}`);
    } finally {
      db?.close();
    }
  }
  return out;
}
