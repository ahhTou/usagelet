import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { zstdCompressSync } from 'node:zlib';
import { collect, VERSION } from '../src/index.mjs';
import { summarizeDaily, dayFormatter } from '../src/rows.mjs';
const script = fileURLToPath(new URL('../dist/usagelet.mjs', import.meta.url));
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'usagelet-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env: {}, mode: 'extended', timezone: 'Asia/Shanghai' };
}
async function log(path, records, zip = false) {
  await mkdir(join(path, '..'), { recursive: true });
  const text =
    records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  await writeFile(path, zip ? zstdCompressSync(Buffer.from(text)) : text);
}
const timestamp = '2026-10-17T18:00:00Z';
function claude(id, input = 10, output = 2, extra = {}) {
  return {
    timestamp,
    sessionId: 'session-a',
    requestId: 'req-' + id,
    message: {
      id,
      role: 'assistant',
      model: 'claude-test',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
      },
    },
    ...extra,
  };
}
const meta = (id, parent) => ({ type: 'session_meta', payload: { id, forked_from_id: parent } });
const context = (model) => ({ type: 'turn_context', payload: { model } });
function token(total, last, time = timestamp) {
  return {
    type: 'event_msg',
    timestamp: time,
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  };
}
const raw = (i, o = 2, cached = 4) => ({
  input_tokens: i,
  output_tokens: o,
  cached_input_tokens: cached,
});
const breakdown = (data) => data.daily.flatMap((d) => d.agents.flatMap((a) => a.modelBreakdowns));
const records = (data) => data.metadata.sources.reduce((n, s) => n + s.records, 0);

test('Claude 流式快照、跨文件重复和跨时区日期只计一次', async (t) => {
  const options = await fixture(t),
    base = join(options.home, '.claude/projects');
  await log(join(base, 'one.jsonl'), [claude('m', 10, 1), claude('m', 10, 8)]);
  await log(join(base, 'two.jsonl'), [claude('m', 10, 8), claude('n', 20, 3)]);
  const data = await collect(options);
  assert.equal(data.daily[0].period, '2026-10-18');
  assert.equal(data.totals.inputTokens, 30);
  assert.equal(data.totals.outputTokens, 11);
  assert.equal(records(data), 2);
  assert.equal(data.metadata.complete, true);
});
test('Codex 累计差分、重复快照、模型切换与缓存互斥', async (t) => {
  const options = await fixture(t),
    file = join(options.home, '.codex/sessions/a.jsonl');
  await log(file, [
    meta('a'),
    context('gpt-a'),
    token(raw(10), raw(10)),
    token(raw(10), raw(10)),
    context('gpt-b'),
    token(raw(30, 7, 12)),
  ]);
  const data = await collect(options),
    m = breakdown(data);
  assert.equal(m.length, 2);
  assert.equal(data.totals.inputTokens, 18);
  assert.equal(data.totals.cacheReadTokens, 12);
  assert.equal(data.totals.outputTokens, 7);
});
test('普通和压缩日志副本不双算，压缩归档正常读取', async (t) => {
  const options = await fixture(t),
    base = join(options.home, '.codex/sessions');
  const rows = [meta('a'), context('gpt-a'), token(raw(10), raw(10))];
  await log(join(base, 'a.jsonl'), rows);
  await log(join(base, 'a.jsonl.zst'), rows, true);
  await log(
    join(base, 'b.jsonl.zst'),
    [meta('b'), context('gpt-b'), token(raw(20), raw(20))],
    true,
  );
  const data = await collect(options);
  assert.equal(data.totals.inputTokens, 22);
  assert.equal(records(data), 2);
});
test('Codex 同身份归档、分支重放历史不重复累计', async (t) => {
  const options = await fixture(t),
    base = join(options.home, '.codex');
  const rows = [meta('parent'), context('gpt-a'), token(raw(10), raw(10))];
  await log(join(base, 'sessions/parent.jsonl'), rows);
  await log(join(base, 'archived_sessions/copy.jsonl.zst'), rows, true);
  await log(join(base, 'sessions/child.jsonl'), [
    meta('child', 'parent'),
    context('gpt-a'),
    token(raw(10), raw(10)),
    token(raw(30, 5), raw(20, 3), '2026-10-17T18:02:00Z'),
  ]);
  const data = await collect(options);
  assert.equal(data.totals.inputTokens, 22);
  assert.equal(records(data), 2);
});
test('Codex remote compaction 计入，已被累计快照覆盖的 local compaction 不重复计入', async (t) => {
  const options = await fixture(t),
    file = join(options.home, '.codex/sessions/a.jsonl');
  const request = (id, i) => ({
    type: 'token_usage_record',
    timestamp,
    payload: { response_id: id, usage: raw(i), model: 'gpt-compact' },
  });
  const marker = (id) => ({ type: 'compacted', payload: { compaction_response_id: id } });
  await log(file, [
    meta('a'),
    context('gpt-a'),
    token(raw(10), raw(10)),
    request('local', 20),
    token(raw(30, 4, 8), raw(20)),
    marker('local'),
    request('remote', 50),
    marker('remote'),
  ]);
  const data = await collect(options);
  assert.equal(records(data), 3);
  assert.equal(data.totals.inputTokens, 68);
});
test('ZCode 只读 SQLite，过滤未完成请求并移除重复缓存计数', async (t) => {
  const options = await fixture(t),
    file = join(options.home, '.zcode/cli/db/db.sqlite');
  await mkdir(join(file, '..'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE model_usage (id TEXT, model_id TEXT, started_at INTEGER, status TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER)',
  );
  const q = db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  q.run('a', 'zmodel', Date.parse(timestamp), 'completed', 100, 10, 20, 30);
  q.run('b', 'zmodel', Date.parse(timestamp), 'running', 999, 999, 0, 0);
  db.close();
  const before = await readFile(file),
    data = await collect(options);
  assert.deepEqual(await readFile(file), before);
  assert.equal(data.totals.inputTokens, 50);
  assert.equal(data.totals.totalTokens, 110);
});
test('DeepSeek v4 压缩、最高代际、stream usage、同一步替换、重试及模型归属', async (t) => {
  const options = await fixture(t),
    base = join(options.home, '.dsh/sessions/project/session-a');
  const header = { type: 'session', version: 4, id: 'a' };
  const route = {
    type: 'request/header',
    data: { header: { config: { provider: 'p', model: 'deepseek-test' } } },
  };
  const settle = (seq, n, type = 'assistant/message') => ({
    type,
    seq,
    time: Date.parse(timestamp),
    data: {
      turn: 1,
      step: 0,
      usage:
        type === 'assistant/message'
          ? { inputTokens: n, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
          : undefined,
      stream: [
        {
          type: 'chunk',
          chunk: {
            type: 'usage',
            usage: { inputTokens: n, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
          },
        },
      ],
    },
  });
  await log(join(base, 'session.v3.jsonl'), [{ ...header, version: 3 }, route, settle(1, 999)]);
  await log(
    join(base, 'session.v4.jsonl.zstd'),
    [
      header,
      route,
      settle(1, 10, 'assistant/attempt'),
      settle(2, 20),
      { type: 'llm/retry-started', data: { turn: 1, step: 0 } },
      settle(3, 30),
    ],
    true,
  );
  const data = await collect(options);
  assert.equal(data.totals.inputTokens, 50);
  assert.equal(data.totals.cacheReadTokens, 6);
  assert.equal(records(data), 2);
  assert.equal(data.metadata.complete, true);
});
test('扩展口径下未报告的计数按 0 计入并告警；坏 JSON 显式警告', async (t) => {
  const options = await fixture(t),
    row = claude('a');
  delete row.message.usage.cache_creation_input_tokens;
  await log(join(options.home, '.claude/projects/a.jsonl'), [row, '{"usage": nope']);
  const data = await collect(options);
  assert.equal(data.totals.cacheCreationTokens, 0);
  assert.equal(data.totals.inputTokens, 10);
  assert.equal(data.metadata.complete, false);
  assert.deepEqual(data.metadata.warnings.map((w) => w.code).sort(), [
    'extended_missing_fields',
    'invalid_json',
  ]);
});
test('日期过滤不改变前置累计基线', async (t) => {
  const options = await fixture(t),
    file = join(options.home, '.codex/sessions/a.jsonl');
  await log(file, [
    meta('a'),
    context('gpt-a'),
    token(raw(10), undefined, '2026-10-16T00:00:00Z'),
    token(raw(30), undefined),
  ]);
  const data = await collect({ ...options, since: '2026-10-18', until: '2026-10-18' });
  assert.equal(data.totals.inputTokens, 20);
  assert.equal(data.daily.length, 1);
});
test('明确错误路径、未知来源报错；未知 DSH 版本告警而不是静默成功', async (t) => {
  const options = await fixture(t);
  await assert.rejects(collect({ ...options, sources: { claude: ['/does-not-exist'] } }), /不存在/);
  await assert.rejects(collect({ ...options, agents: ['qoder'] }), /暂缓/);
  await log(join(options.home, '.dsh/sessions/p/s/session.v99.jsonl'), [
    { type: 'session', version: 99, id: 'future' },
  ]);
  const data = await collect(options);
  assert.equal(data.metadata.complete, false);
  assert.ok(data.metadata.warnings.some((w) => w.code === 'dsh_untested_version'));
});
test('单个文件在干净目录运行，无 package.json 或 node_modules', async (t) => {
  const options = await fixture(t),
    target = join(options.home, 'usagelet.mjs');
  await copyFile(script, target);
  const env = {
    ...process.env,
    HOME: options.home,
    CLAUDE_CONFIG_DIR: join(options.home, '.claude'),
    CODEX_HOME: join(options.home, '.codex'),
    ZCODE_HOME: join(options.home, '.zcode'),
    DSH_HOME: join(options.home, '.dsh'),
  };
  const result = JSON.parse(
    execFileSync(process.execPath, [target, 'daily', '--json', '--by-agent', '-O'], {
      env,
      cwd: options.home,
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(result.daily, []);
  assert.equal(result.totals.totalTokens, 0);
  assert.equal(
    execFileSync(process.execPath, [target, '--version'], { encoding: 'utf8' }).trim(),
    VERSION,
  );
  assert.equal(spawnSync(process.execPath, [target, '--since', '2026-02-30']).status, 1);
});
test('汇总拒绝安全整数溢出', () => {
  const row = {
    model: 'x',
    timestamp,
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  };
  assert.throws(
    () => summarizeDaily([row, row], { day: dayFormatter('UTC'), aliases: {} }),
    /安全整数/,
  );
});

test('DeepSeek 多 Zstd 帧完整解码；截断末帧按 DSH 规则忽略，损坏文件告警', async (t) => {
  const options = await fixture(t),
    file = join(options.home, '.dsh/sessions/p/dsh-a/session.v4.jsonl.zstd');
  await mkdir(join(file, '..'), { recursive: true });
  const header = { type: 'session', id: 'dsh-a', version: 4, createdAt: 1, isSeeded: false };
  const message = (seq, n) => ({
    type: 'assistant/message',
    seq,
    time: Date.parse(timestamp),
    data: {
      turn: 1,
      step: seq + 1,
      message: { source: { provider: 'p', model: 'dsh-test' } },
      usage: { inputTokens: n, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  });
  const frames = [header, message(0, 7), message(1, 9)].map((x) =>
    zstdCompressSync(Buffer.from(JSON.stringify(x) + '\n')),
  );
  await writeFile(file, Buffer.concat(frames));
  assert.equal((await collect(options)).totals.totalTokens, 22);
  await writeFile(file, Buffer.concat([frames[0], frames[1], frames[2].subarray(0, 5)]));
  let data = await collect(options);
  assert.equal(data.totals.totalTokens, 10);
  assert.equal(data.metadata.complete, true);
  await writeFile(file, Buffer.from('invalid compressed file'));
  data = await collect(options);
  assert.equal(data.metadata.complete, false);
  assert.ok(data.metadata.warnings.some((w) => /^dsh_/.test(w.code)));
});

test('Claude 详细 TTL 写缓存优先，advisor 单独归属，侧链重放不重复', async (t) => {
  const options = await fixture(t),
    row = claude('a');
  row.message.usage.cache_creation = {
    ephemeral_5m_input_tokens: 10,
    ephemeral_1h_input_tokens: 20,
  };
  row.message.usage.iterations = [
    {
      type: 'advisor_message',
      model: 'advisor-test',
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  ];
  const sidechain = structuredClone(row);
  sidechain.requestId = 'rewritten';
  sidechain.isSidechain = true;
  await log(join(options.home, '.claude/projects/a.jsonl'), [sidechain, row]);
  const data = await collect(options);
  assert.equal(data.totals.cacheCreationTokens, 30);
  assert.equal(records(data), 2);
  assert.equal(breakdown(data).find((x) => x.modelName === 'advisor-test').outputTokens, 2);
});
test('不同会话复用同一 Claude message id 时保持隔离', async (t) => {
  const options = await fixture(t),
    a = claude('a'),
    b = claude('a');
  b.sessionId = 'other';
  await log(join(options.home, '.claude/projects/a.jsonl'), [a, b]);
  assert.equal(records(await collect(options)), 2);
});
test('Codex compaction 标记先出现时，随后覆盖它的累计事件也不重复', async (t) => {
  const options = await fixture(t);
  await log(join(options.home, '.codex/sessions/a.jsonl'), [
    meta('a'),
    context('gpt-a'),
    {
      type: 'token_usage_record',
      timestamp,
      payload: { response_id: 'c', usage: raw(10), model: 'gpt-a' },
    },
    { type: 'compacted', payload: { compaction_response_id: 'c' } },
    token(raw(10), raw(10)),
  ]);
  assert.equal(records(await collect(options)), 1);
});
test('缺失 Codex 父会话标记不完整，未确认的模型不会猜测为某个 GPT 版本', async (t) => {
  const options = await fixture(t);
  await log(join(options.home, '.codex/sessions/a.jsonl'), [
    meta('a', 'missing'),
    token(raw(10), raw(10)),
  ]);
  const data = await collect(options);
  assert.equal(data.metadata.complete, false);
  assert.equal(breakdown(data)[0].modelName, 'unknown');
  assert.deepEqual(
    new Set(data.metadata.warnings.map((w) => w.code)),
    new Set(['missing_parent', 'unknown_model']),
  );
});
test('DeepSeek 种子历史不可静默当作完整数据', async (t) => {
  const options = await fixture(t);
  await log(join(options.home, '.dsh/sessions/p/seed/session.v4.jsonl'), [
    { type: 'session', id: 'seed', version: 4, isSeeded: true },
  ]);
  assert.equal((await collect(options)).metadata.complete, false);
});
