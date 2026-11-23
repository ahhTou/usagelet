// 移植自 ccusage 4f1df4ed 的 Antigravity parser/sqlite.rs（MIT）。
import { basename } from 'node:path';
import { databaseEvents } from './events.mjs';
import { generationMetadata, stepMetadata, trajectoryTimestamp } from './proto.mjs';

export function readDatabase(DatabaseSync, file, ctx) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // 整个会话使用同一个只读快照，避免把运行中写入的不同代际混用。
    db.exec('BEGIN DEFERRED TRANSACTION');
    const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    const has = (name) => table.get(name) !== undefined;
    const hasSteps = has('steps');
    const hasTrajectory = has('trajectory_metadata_blob');
    if (!has('gen_metadata')) {
      if (hasSteps || hasTrajectory) throw Error('会话数据库缺少 gen_metadata 表');
      return [];
    }
    const session = basename(file, '.db');
    const trajectory = hasTrajectory
      ? db.prepare('SELECT data FROM trajectory_metadata_blob ORDER BY rowid ASC').iterate()
      : [];
    let timestamp;
    for (const { data } of trajectory) {
      const candidate = trajectoryTimestamp(data);
      timestamp ??= candidate;
    }
    const generations = readRows(
      db,
      'SELECT idx, data FROM gen_metadata ORDER BY idx ASC',
      generationMetadata,
      (idx, row) =>
        row.stepIndices.length
          ? row.stepIndices.map((step) => `step:${session}:${step}`)
          : [`gen:${session}:${idx}`],
    );
    const steps = hasSteps
      ? readRows(
          db,
          'SELECT idx, metadata AS data FROM steps WHERE metadata IS NOT NULL ORDER BY idx ASC',
          stepMetadata,
          (idx) => [`step:${session}:${idx}`],
        )
      : [];
    return databaseEvents(generations, steps, timestamp, ctx, file);
  } finally {
    db.close();
  }
}

function readRows(db, sql, parse, identities) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return Array.from(statement.iterate(), ({ idx, data }) => {
    if (typeof idx !== 'bigint') throw Error('元数据索引必须为 SQLite 整数');
    const row = parse(data);
    return { ...row, identities: identities(idx, row) };
  });
}
