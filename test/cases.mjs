// 人工脱敏样本；预期输出由真实 ccusage 20.0.21 生成，不由 usagelet 自己推导。
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
export const TIME = '2026-05-10T18:00:00Z';
export const claude = (id = 'm', u = {}, extra = {}) => ({
  timestamp: TIME,
  sessionId: 's',
  requestId: 'req',
  message: {
    id,
    model: 'claude-sonnet-4-20250514',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 30,
      ...u,
    },
  },
  ...extra,
});
export const raw = (i = 100, o = 20, c = 30) => ({
  input_tokens: i,
  output_tokens: o,
  cached_input_tokens: c,
});
export const token = (total, last, time = TIME, info = {}) => ({
  type: 'event_msg',
  timestamp: time,
  payload: {
    type: 'token_count',
    info: { total_token_usage: total, last_token_usage: last, ...info },
  },
});
export const meta = (id, parent, time = '2026-05-10T17:00:00Z') => ({
  type: 'session_meta',
  timestamp: time,
  payload: { id, forked_from_id: parent },
});
export const context = (model) => ({ type: 'turn_context', payload: { model } });
const C = 'claude/projects/p/a.jsonl',
  X = 'codex/sessions/a.jsonl';
const withMessage = (r, changes) => ({ ...r, message: { ...r.message, ...changes } });
const cp = (rows) => ({ [C]: rows });
const xp = (rows) => ({ [X]: rows });
export const CASES = [
  { name: 'claude-basic', files: cp([claude()]) },
  {
    name: 'claude-largest-whole-snapshot',
    files: cp([
      claude('m', { input_tokens: 10, output_tokens: 20 }),
      claude('m', { input_tokens: 15, output_tokens: 10 }),
    ]),
  },
  {
    name: 'claude-session-and-missing-request',
    files: cp([
      claude(),
      claude('m', {}, { sessionId: 'other' }),
      claude('same', {}, { requestId: undefined }),
      claude('same', {}, { requestId: undefined, timestamp: '2026-05-10T19:00:00Z' }),
    ]),
  },
  {
    name: 'claude-no-id',
    files: cp([withMessage(claude(), { id: undefined }), withMessage(claude(), { id: undefined })]),
  },
  {
    name: 'claude-ttl-and-cache-default',
    files: cp([
      claude('a', {
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
      }),
      claude('b', { cache_creation_input_tokens: undefined, cache_read_input_tokens: undefined }),
    ]),
  },
  {
    name: 'claude-sidechain-rewrite',
    files: {
      'claude/projects/p/a.jsonl': [
        claude('m', { output_tokens: 999 }, { requestId: 'copy', isSidechain: true }),
      ],
      'claude/projects/p/b.jsonl': [claude()],
    },
  },
  {
    name: 'claude-advisor',
    files: cp([
      claude('m', {
        iterations: [
          { type: 'message', input_tokens: 999, output_tokens: 999 },
          {
            type: 'advisor_message',
            model: 'advisor',
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 2,
          },
          { type: 'advisor_message', model: null, input_tokens: 999, output_tokens: 999 },
        ],
      }),
    ]),
  },
  {
    name: 'claude-fast-and-alias',
    env: { CCUSAGE_MODEL_ALIASES: 'claude-sonnet-4-20250514=sonnet' },
    files: cp([claude('m', { speed: 'fast' })]),
  },
  {
    name: 'claude-agent-progress',
    files: cp([
      {
        type: 'progress',
        sessionId: 'parent',
        data: { message: { timestamp: TIME, requestId: 'req', message: claude().message } },
      },
    ]),
  },
  {
    name: 'claude-model-less-totals',
    files: cp([
      withMessage(claude('a'), { model: undefined }),
      withMessage(claude('b'), { model: '<synthetic>' }),
    ]),
  },
  {
    name: 'claude-invalid-known-fields',
    files: cp([
      claude('a', {}, { version: 'invalid' }),
      claude('bad-date', {}, { timestamp: '2026-02-30T12:00:00Z' }),
      claude('bad-precision', {}, { timestamp: '2026-05-10T18:00:00.1Z' }),
      claude('b', { cache_read_input_tokens: null }),
      withMessage(claude('c'), { id: '' }),
      claude('d', { input_tokens: -1 }),
      claude('e', {}, { requestId: '' }),
      claude('f', {}, { version: '2.0.1-extra' }),
    ]),
  },
  {
    name: 'claude-nested-path-session',
    files: {
      'claude/projects/p/s/chat.jsonl': [claude('m', {}, { sessionId: undefined })],
      'claude/projects/p/s/subagents/agent-a.jsonl': [
        claude('m', {}, { sessionId: undefined, isSidechain: true, requestId: 'side' }),
      ],
    },
  },
  {
    name: 'codex-cumulative',
    files: xp([
      context('gpt-5.4'),
      token(raw(100), raw(100)),
      token(raw(100), raw(100)),
      token(raw(150, 30, 40)),
    ]),
  },
  {
    name: 'codex-cumulative-reset',
    files: xp([context('gpt-5.4'), token(raw(100)), token(raw(30, 4, 5)), token(raw(60, 8, 10))]),
  },
  {
    name: 'codex-cache-aliases-and-clamp',
    files: xp([
      context('gpt-5'),
      token(undefined, {
        prompt_tokens: 20,
        completion_tokens: 4,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 15,
        reasoning_tokens: 2,
      }),
      token(undefined, { input: 30, output: 7, cached_tokens: 5, cache_write_input_tokens: 9 }),
    ]),
  },
  {
    name: 'codex-lossy-count-fields',
    files: xp([
      token(
        undefined,
        { input_tokens: '10', prompt_tokens: 12, output_tokens: -1, completion_tokens: ' 4 ' },
        TIME,
        { model: 'gpt-5' },
      ),
    ]),
  },
  { name: 'codex-no-model-fallback', files: xp([token(raw(100), raw(100))]) },
  {
    name: 'codex-model-name-metadata',
    files: xp([
      { type: 'turn_context', payload: { model_name: 'gpt-first' } },
      token(undefined, raw()),
      token(undefined, raw(150), TIME, { metadata: { model: 'gpt-second' } }),
    ]),
  },
  {
    name: 'codex-auto-review-dates',
    files: xp(
      ['2025-08-01', '2025-09-16', '2025-12-12', '2026-02-06', '2026-03-06', '2026-04-24'].flatMap(
        (d) => [context('codex-auto-review'), token(undefined, raw(), d + 'T23:00:00Z')],
      ),
    ),
  },
  {
    name: 'codex-headless-shapes',
    files: xp([
      { timestamp: TIME, model: 'gpt-5', usage: { prompt_tokens: 7, completion_tokens: 3 } },
      {
        result: {
          created_at: 1778436000,
          metadata: { model: 'gpt-5.4' },
          usage: { input: 20, output: 5, cached_tokens: 4 },
        },
      },
      {
        response: {
          createdAt: 1778436000000,
          model_name: 'gpt-5.5',
          usage: { input_tokens: 30, output_tokens: 6, cache_write_input_tokens: 4 },
        },
      },
    ]),
  },
  {
    name: 'codex-headless-mtime',
    files: xp([{ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 3 } }]),
  },
  {
    name: 'codex-global-event-dedupe',
    files: {
      [X]: [context('gpt-5'), token(undefined, raw())],
      'codex/sessions/b.jsonl': [
        context('gpt-5'),
        token(undefined, raw(), '2026-05-11T02:00:00+08:00'),
      ],
    },
  },
  {
    name: 'codex-active-over-archive',
    files: {
      [X]: [context('gpt-5'), token(undefined, raw(10))],
      'codex/archived_sessions/a.jsonl': [context('gpt-5'), token(undefined, raw(999))],
    },
  },
  {
    name: 'codex-fork-prefix',
    files: {
      [X]: [meta('p'), context('gpt-5'), token(undefined, raw(10))],
      'codex/sessions/b.jsonl': [
        meta('child', 'p', '2026-05-10T19:00:00Z'),
        context('gpt-5'),
        token(undefined, raw(10)),
        token(undefined, raw(20), '2026-05-10T20:00:00Z'),
      ],
    },
  },
  {
    name: 'codex-fork-missing-parent-burst',
    files: xp([
      meta('child', 'missing'),
      context('gpt-5'),
      token(undefined, raw(10), '2026-05-10T18:00:00Z'),
      token(undefined, raw(20), '2026-05-10T18:00:00.025Z'),
      token(undefined, raw(30), '2026-05-10T18:00:03Z'),
    ]),
  },
  {
    name: 'codex-fork-cutoff',
    files: {
      [X]: [
        meta('p'),
        context('gpt-5'),
        token(undefined, raw(10), '2026-05-10T17:00:00Z'),
        token(undefined, raw(20), '2026-05-10T19:00:00Z'),
      ],
      'codex/sessions/b.jsonl': [
        meta('c', 'p', '2026-05-10T18:00:00Z'),
        context('gpt-5'),
        token(undefined, raw(10), '2026-05-10T18:00:00Z'),
        token(undefined, raw(20), '2026-05-10T20:00:00Z'),
      ],
    },
  },
  {
    name: 'codex-compaction-and-compressed-excluded',
    files: {
      [X]: [
        context('gpt-5'),
        token(undefined, raw(10)),
        {
          type: 'token_usage_record',
          timestamp: TIME,
          payload: { response_id: 'c', usage: raw(999) },
        },
        { type: 'compacted', payload: { compaction_response_id: 'c' } },
      ],
      'codex/sessions/b.jsonl.zst': [context('gpt-5'), token(undefined, raw(9999))],
    },
  },
  { name: 'zcode-basic', db: true },
  { name: 'zcode-legacy-columns', db: 'legacy' },
  { name: 'zcode-total-output-fallback', db: 'fallback' },
  { name: 'zcode-total-extra', db: 'extra' },
  { name: 'zcode-numeric-normalization', db: 'numbers' },
  // 新装或结构变化：ZCode 库被跳过，其他来源照常统计。
  { name: 'zcode-missing-table-keeps-claude', files: cp([claude()]), db: 'no-model-usage' },
  { name: 'zcode-missing-column-keeps-claude', files: cp([claude()]), db: 'no-status' },
  {
    name: 'mixed-agents-and-alias',
    env: {
      CCUSAGE_MODEL_ALIASES: '{"gpt-5":"same","claude-sonnet-4-20250514":"same","zmodel":"same"}',
    },
    files: { ...cp([claude()]), ...xp([context('gpt-5'), token(undefined, raw())]) },
    db: true,
  },
  {
    name: 'multi-roots',
    roots: true,
    files: {
      'work-claude/projects/p/a.jsonl': [claude()],
      'personal-claude/projects/p/a.jsonl': [claude('b')],
      'work-codex/sessions/a.jsonl': [context('gpt-5'), token(undefined, raw(10))],
      'personal-codex/sessions/a.jsonl': [context('gpt-5'), token(undefined, raw(20))],
    },
  },
  {
    name: 'claude-advisor-invalid-envelope',
    files: cp([
      claude('m', {
        iterations: [
          { type: 'message' },
          { type: 'advisor_message', model: 'advisor', input_tokens: 7, output_tokens: 3 },
        ],
      }),
    ]),
  },
  {
    name: 'claude-numeric-literals-and-duplicate-fields',
    files: cp([
      JSON.stringify(claude('float')).replace('"input_tokens":100', '"input_tokens":100.0'),
      JSON.stringify(claude('duplicate')).replace(
        '"output_tokens":20',
        '"output_tokens":20,"output_tokens":30',
      ),
    ]),
  },
  {
    name: 'claude-unsupported-null-nested',
    files: cp([withMessage(claude(), { content: [{ model: null }] })]),
  },
  {
    name: 'codex-numeric-literals',
    files: xp([
      context('gpt-5'),
      JSON.stringify(
        token(undefined, { input_tokens: 10, prompt_tokens: 20, output_tokens: 3 }),
      ).replace('"input_tokens":10', '"input_tokens":10.0'),
      token(undefined, { input_tokens: ' +12 ', output_tokens: '4', cached_input_tokens: '2' }),
    ]),
  },
  {
    name: 'codex-alias-global-dedupe',
    env: { CCUSAGE_MODEL_ALIASES: 'a=same,b=same' },
    files: {
      [X]: [context('a'), token(undefined, raw())],
      'codex/sessions/b.jsonl': [context('b'), token(undefined, raw())],
    },
  },
  {
    name: 'codex-parent-mismatch-rewritten-burst',
    files: {
      [X]: [meta('p'), context('gpt-5'), token(undefined, raw(100))],
      'codex/sessions/c.jsonl': [
        meta('c', 'p', '2026-05-10T19:00:00Z'),
        context('gpt-5'),
        token(undefined, raw(10), '2026-05-10T19:00:00Z'),
        token(undefined, raw(20), '2026-05-10T19:00:00.050Z'),
        token(undefined, raw(30), '2026-05-10T19:00:05Z'),
      ],
    },
  },
];
export async function populate(root, c) {
  for (const [name, rows] of Object.entries(c.files ?? {})) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    const bytes = Buffer.from(
      rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n',
    );
    await writeFile(path, name.endsWith('.zst') ? zstdCompressSync(bytes) : bytes);
    await utimes(path, new Date(TIME), new Date(TIME));
  }
  if (c.db) {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(root, 'zcode/cli/db/db.sqlite');
    await mkdir(join(path, '..'), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY,directory TEXT); INSERT INTO session VALUES ('s','/project')",
    );
    if (c.db === 'no-model-usage') {
      db.close();
      return;
    }
    if (c.db === 'no-status') {
      db.exec(
        'CREATE TABLE model_usage (id TEXT,session_id TEXT,started_at INTEGER,model_id TEXT,input_tokens INTEGER,output_tokens INTEGER)',
      );
      db.prepare('INSERT INTO model_usage VALUES (?,?,?,?,?,?)').run(
        'u',
        's',
        Date.parse(TIME),
        'zmodel',
        100,
        20,
      );
      db.close();
      return;
    }
    const legacy = c.db === 'legacy';
    db.exec(
      `CREATE TABLE model_usage (id TEXT,session_id TEXT,started_at INTEGER,model_id TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER${legacy ? '' : ',cache_creation_input_tokens INTEGER,computed_total_tokens INTEGER'})`,
    );
    const q = db.prepare(
      `INSERT INTO model_usage VALUES (${Array(legacy ? 8 : 10)
        .fill('?')
        .join(',')})`,
    );
    const values =
      c.db === 'numbers'
        ? [-10, 4.6, 2.4, 5.5, 30]
        : c.db === 'fallback'
          ? [100, 0, 30, 10, 180]
          : c.db === 'extra'
            ? [100, 20, 30, 10, 180]
            : [100, 20, 30, 10, 120];
    q.run(
      'u',
      's',
      Date.parse(TIME),
      'zmodel',
      'completed',
      ...values.slice(0, 3),
      ...(legacy ? [] : values.slice(3)),
    );
    q.run('ignore', 's', Date.parse(TIME), 'zmodel', 'running', 1, 1, 0, ...(legacy ? [] : [0, 2]));
    db.close();
  }
}
export function environment(root, c = {}) {
  return {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    ZCODE_HOME: join(root, 'zcode'),
    DSH_HOME: join(root, 'dsh'),
    CCUSAGE_MODEL_ALIASES: '',
    ...(c.roots
      ? {
          CLAUDE_CONFIG_DIR: [join(root, 'work-claude'), join(root, 'personal-claude')].join(','),
          CODEX_HOME: [join(root, 'work-codex'), join(root, 'personal-codex')].join(','),
        }
      : {}),
    ...c.env,
  };
}
export function normalize(result) {
  const fields = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];
  const output = [];
  for (const d of result.daily) {
    output.push([d.period, 'all', null, ...fields.map((k) => d[k]), d.totalTokens]);
    for (const a of d.agents) {
      output.push([d.period, a.agent, null, ...fields.map((k) => a[k]), a.totalTokens]);
      for (const m of a.modelBreakdowns)
        output.push([d.period, a.agent, m.modelName, ...fields.map((k) => m[k])]);
    }
  }
  output.push([
    null,
    'all',
    null,
    ...fields.map((k) => result.totals[k]),
    result.totals.totalTokens,
  ]);
  return output.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
