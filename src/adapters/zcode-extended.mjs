import { basename, dirname } from 'node:path';
import { records } from '../io.mjs';
import { BUCKETS, buckets, makeRecord, issue, sum, count } from '../shared.mjs';
import { tableColumns } from './zcode.mjs';
export async function zcode(paths, ctx) {
  const { DatabaseSync } = await import('node:sqlite');
  const seen = new Set(),
    out = [];
  for (const path of paths) {
    // 单个数据库不可读或结构不符时只跳过该库并警告，不让其他来源的结果一起丢失。
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000');
      const columns = tableColumns(db, 'model_usage');
      const missing = [
        'id',
        'model_id',
        'started_at',
        'input_tokens',
        'output_tokens',
        'status',
      ].filter((k) => !columns.has(k));
      if (missing.length) {
        issue(
          ctx,
          'zcode_schema',
          path,
          columns.size
            ? `ZCode model_usage 缺少 ${missing.join(', ')}，已跳过`
            : 'ZCode 数据库没有 model_usage 表，已跳过',
        );
        continue;
      }
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
    } catch (e) {
      issue(ctx, 'zcode_unreadable', path, `读取 ZCode 数据库失败：${e.message}`);
    } finally {
      db?.close();
    }
  }
  return out;
}
