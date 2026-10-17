// v0.2.0 回归测试发现的问题：每项对应一条修复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collect, VERSION } from '../src/index.mjs';
const script = fileURLToPath(new URL('../dist/usagelet.mjs', import.meta.url));
const timestamp = '2026-09-15T04:00:00Z';
const claudeRow = (id, time = timestamp) => ({
  timestamp: time,
  sessionId: 's',
  requestId: 'req-' + id,
  message: {
    id,
    model: 'claude-test',
    usage: { input_tokens: 10, output_tokens: 2 },
  },
});
async function fixture(t, { claude = [claudeRow('a')], zcode } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'usagelet-regression-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    ZCODE_HOME: join(home, '.zcode'),
    DSH_HOME: join(home, '.dsh'),
  };
  const file = join(home, '.claude/projects/p/a.jsonl');
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, claude.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const db = join(home, '.zcode/cli/db/db.sqlite');
  if (zcode) {
    await mkdir(join(db, '..'), { recursive: true });
    await zcode(db);
  }
  return { home, env, db, options: { home, env, timezone: 'Asia/Shanghai' } };
}
const sqlite = (sql) => async (path) => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
};
function cli(f, args) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, HOME: f.home, ...f.env },
    cwd: f.home,
    encoding: 'utf8',
  });
}

for (const mode of ['ccusage', 'extended'])
  test(`ZCode 缺少 model_usage 表时只跳过该库，Claude 结果保留（${mode}）`, async (t) => {
    const f = await fixture(t, {
      zcode: sqlite('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)'),
    });
    const data = await collect({ ...f.options, mode });
    assert.equal(data.totals.inputTokens, 10);
    assert.equal(data.metadata.complete, false);
    const warning = data.metadata.warnings.find((w) => w.code === 'zcode_schema');
    assert.ok(warning);
    assert.match(warning.source, /db\.sqlite$/);
    assert.match(warning.message, /model_usage/);
    assert.equal(data.metadata.sources.find((s) => s.agent === 'zcode').status, 'no_usage');
  });

test('ZCode 缺少必需列、文件不是数据库时同样只跳过该库并警告', async (t) => {
  const f = await fixture(t, {
    zcode: sqlite(
      'CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE model_usage (id TEXT, session_id TEXT, started_at INTEGER, model_id TEXT, input_tokens INTEGER, output_tokens INTEGER)',
    ),
  });
  let data = await collect(f.options);
  assert.equal(data.totals.inputTokens, 10);
  assert.match(data.metadata.warnings[0].message, /model_usage: status/);
  await writeFile(f.db, 'not a database');
  data = await collect(f.options);
  assert.equal(data.totals.inputTokens, 10);
  assert.equal(data.metadata.warnings[0].code, 'zcode_unreadable');
  // 命令行仍输出可解析的 JSON，以数据质量警告退出。
  const run = cli(f, ['daily', '--json', '--tz', 'Asia/Shanghai']);
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).totals.inputTokens, 10);
  assert.match(run.stderr, /zcode_unreadable/);
});

test('collect 规范化并校验 since / until', async (t) => {
  const f = await fixture(t, {
    claude: [claudeRow('a'), claudeRow('b', '2026-09-16T04:00:00Z')],
  });
  const data = await collect({ ...f.options, since: '20260915', until: '20260915' });
  assert.equal(data.daily.length, 1);
  assert.equal(data.daily[0].period, '2026-09-15');
  assert.equal(data.metadata.complete, true);
  await assert.rejects(collect({ ...f.options, since: '2026-02-30' }), /since 无效日期/);
  await assert.rejects(collect({ ...f.options, until: '2026/09/15' }), /until 无效日期/);
  await assert.rejects(collect({ ...f.options, since: 20260915 }), /since 无效日期/);
  await assert.rejects(
    collect({ ...f.options, since: '2026-09-16', until: '20260915' }),
    /since 不能晚于 until/,
  );
  assert.equal(cli(f, ['--since', '2026-02-30']).status, 1);
});

test('契约外来源不标注 ccusage 兼容', async (t) => {
  const f = await fixture(t);
  assert.equal((await collect(f.options)).metadata.compatibility, 'ccusage@20.0.21');
  assert.equal(
    (await collect({ ...f.options, agents: ['claude'] })).metadata.compatibility,
    'ccusage@20.0.21',
  );
  for (const agents of [['deepseek'], ['claude', 'deepseek']]) {
    const data = await collect({ ...f.options, agents });
    assert.equal(data.metadata.mode, 'ccusage');
    assert.equal(data.metadata.compatibility, null);
  }
});

test('--source zcode= 指向目录时报路径并提示需要数据库文件', async (t) => {
  const f = await fixture(t),
    dir = join(f.home, '.zcode');
  await mkdir(dir, { recursive: true });
  await assert.rejects(
    collect({ ...f.options, agents: ['zcode'], sources: { zcode: [dir] } }),
    (e) => e.message.includes(dir) && /db\.sqlite/.test(e.message),
  );
  const run = cli(f, ['--agent', 'zcode', '--source', `zcode=${dir}`]);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(dir));
  assert.match(run.stderr, /SQLite 数据库文件/);
  assert.doesNotMatch(run.stderr, /disk I\/O/);
});

test('--agent 去掉空白与空项', async (t) => {
  const f = await fixture(t);
  const run = cli(f, ['--agent', ' claude, ,', '--json']);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(
    result.metadata.sources.map((s) => s.agent),
    ['claude'],
  );
  assert.equal(result.metadata.version, VERSION);
  const empty = cli(f, ['--agent', ',']);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--agent 缺少值/);
});
