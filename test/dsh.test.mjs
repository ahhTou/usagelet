// DeepSeek Harness 采集器：样本预期值由 DSH 自己的代码算出（见 test/fixtures/dsh/README.md）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync, constants } from 'node:zlib';
import { readDshSession, foldDshSession, dshFiles, dsh } from '../src/adapters/dsh.mjs';

const FIXTURES = new URL('./fixtures/dsh/', import.meta.url);
const expected = JSON.parse(await readFile(new URL('expected.json', FIXTURES), 'utf8')).fixtures;
const fixture = (name) => new URL(`${name}.jsonl`, FIXTURES).pathname;
const zstd = (text) =>
  zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
// 按 DSH 的写法：首帧只有会话头，之后每批若干行一帧。
const framed = (text, batch = 2) => {
  const lines = text.split('\n').filter(Boolean);
  const frames = [zstd(lines[0] + '\n')];
  for (let i = 1; i < lines.length; i += batch)
    frames.push(zstd(lines.slice(i, i + batch).join('\n') + '\n'));
  return Buffer.concat(frames);
};
const own = (rows) => {
  const t = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const r of rows) {
    t.uncachedInputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheWriteTokens += r.cacheCreationTokens;
  }
  return t;
};
const codes = (ctx) => [...ctx.issues.values()].map((w) => w.code).sort();
async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'usagelet-dsh-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function session(dir, rows, name = 'session.v4.jsonl') {
  const file = join(dir, name);
  const text = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  await writeFile(file, name.endsWith('.zstd') ? framed(text) : text);
  return file;
}
async function fold(file, options) {
  const ctx = { issues: new Map() };
  const s = await readDshSession(file, ctx, options);
  return { ctx, s, rows: s ? foldDshSession(s, ctx) : [] };
}

const T = 1_790_000_000_000;
const header = (extra = {}) => ({
  type: 'session',
  version: 4,
  id: 's',
  createdAt: T,
  isSeeded: false,
  delegationDepth: 0,
  ...extra,
});
const usage = (input, output = 1, read = 0, write = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});
const message = (seq, turn, step, u, extra = {}) => ({
  type: 'assistant/message',
  seq,
  time: T + seq,
  data: {
    turn,
    step,
    message: {
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [],
    ...(u === undefined ? {} : { usage: u }),
    ...extra,
  },
});
const attempt = (seq, turn, step, u) => ({
  type: 'assistant/attempt',
  seq,
  time: T + seq,
  data: {
    turn,
    step,
    stream: u ? [{ type: 'chunk', time: T, chunk: { type: 'usage', usage: u } }] : [],
  },
});
const retry = (seq, turn, step) => ({
  type: 'llm/retry-started',
  seq,
  time: T + seq,
  data: { turn, step, retryId: 'r', attempt: 2 },
});

for (const [name, meta] of Object.entries(expected))
  test(`DSH 官方口径：${name}（v${meta.version}）`, async () => {
    const { s, rows, ctx } = await fold(fixture(name), { extended: true });
    assert.deepEqual(own(rows), meta.own);
    const compactions = s.compactions.filter((c) => c.seq >= s.cut);
    assert.equal(compactions.length, meta.compaction.count);
    assert.deepEqual(codes(ctx), []);
    // 同一份日志按 DSH 的拼接帧写成 .zstd，结果相同。
    await withDir(async (dir) => {
      const text = await readFile(fixture(name), 'utf8');
      const file = await session(dir, [text.trimEnd()], `session.v${meta.version}.jsonl.zstd`);
      assert.deepEqual(own((await fold(file)).rows), meta.own);
    });
  });

test('分叉子会话只计继承截点之后的自有用量', async () => {
  for (const v of ['v2', 'v4']) {
    const child = expected[`${v}-fork-child`];
    assert.equal(child.isSeeded, true);
    assert.notDeepEqual(child.own, child.all);
    const { rows } = await fold(fixture(`${v}-fork-child`));
    assert.deepEqual(own(rows), child.own);
  }
});

test('目录发现：每个会话目录取最高代际，跨根目录同一会话只算一份，父子会话各计自有部分', () =>
  withDir(async (dir) => {
    const put = async (root, project, id, name, source, compress = false) => {
      const target = join(dir, root, 'sessions', project, id);
      await mkdir(target, { recursive: true });
      const text = await readFile(fixture(source), 'utf8');
      await writeFile(
        join(target, name + (compress ? '.zstd' : '')),
        compress ? framed(text) : text,
      );
    };
    // 同一会话的两代：只取 v4。
    await put('a', '--workspace--', 'switch', 'session.v2.jsonl', 'v2-model-switch');
    await put('a', '--workspace--', 'switch', 'session.v4.jsonl', 'v4-model-switch', true);
    // 父会话与分叉子会话。
    await put('a', '--workspace--', 'parent', 'session.v4.jsonl', 'v4-fork-parent');
    await put('a', '--workspace--', 'child', 'session.v4.jsonl', 'v4-fork-child', true);
    // v0 与另一个 DSH_HOME 里的副本（同一会话 id）。
    await put('a', '--workspace--', 'packed', 'session.jsonl', 'v0-packed-chunks');
    await put('b', '--elsewhere--', 'packed', 'session.jsonl', 'v0-packed-chunks');
    // 非规范文件名不读。
    await writeFile(
      join(dir, 'a', 'sessions', '--workspace--', 'switch', 'session.v04.jsonl'),
      '{}',
    );
    const ctx = { issues: new Map() };
    const files = await dshFiles([join(dir, 'a', 'sessions'), join(dir, 'b', 'sessions')], ctx);
    assert.equal(files.length, 5);
    assert.ok(files.some((f) => f.endsWith('switch/session.v4.jsonl.zstd')));
    const rows = await dsh(files, ctx);
    const want = own([]);
    for (const name of ['v4-model-switch', 'v4-fork-parent', 'v4-fork-child', 'v0-packed-chunks']) {
      want.uncachedInputTokens += expected[name].own.uncachedInputTokens;
      want.outputTokens += expected[name].own.outputTokens;
      want.cacheReadTokens += expected[name].own.cacheReadTokens;
      want.cacheWriteTokens += expected[name].own.cacheWriteTokens;
    }
    assert.deepEqual(own(rows), want);
    assert.deepEqual(codes(ctx), ['dsh_duplicate_session']);
    assert.ok(rows.every((r) => r.agent === 'dsh' && typeof r.timestamp === 'number'));
    assert.deepEqual([...new Set(rows.map((r) => `${r.provider}/${r.model}`))].sort(), [
      'deepseek-official/deepseek-v4-flash',
      'deepseek-official/deepseek-v4-pro',
    ]);
    // 稳定顺序：按时间、会话、条目 id。
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].timestamp <= rows[i].timestamp);
  }));

test('message 没有 data.usage 时取内嵌流的最后一个 usage 块', () =>
  withDir(async (dir) => {
    const m = message(0, 1, 1, undefined, {
      stream: [
        { type: 'chunk', time: T, chunk: { type: 'usage', usage: usage(5) } },
        { type: 'text-chunks', time0: T, index: 0, dt: [], texts: ['x'] },
        { type: 'chunk', time: T, chunk: { type: 'usage', usage: usage(7, 2, 3) } },
      ],
    });
    const { rows } = await fold(await session(dir, [header(), m]));
    assert.deepEqual(own(rows), {
      uncachedInputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  }));

test('同一 (turn, step) 后来的样本替换前一个；llm/retry-started 之后的重试另算', () =>
  withDir(async (dir) => {
    const replaced = await fold(
      await session(dir, [header(), attempt(0, 1, 1, usage(10)), message(1, 1, 1, usage(30))]),
    );
    assert.equal(own(replaced.rows).uncachedInputTokens, 30);
    const retried = await fold(
      await session(
        dir,
        [header(), attempt(0, 1, 1, usage(10)), retry(1, 1, 1), message(2, 1, 1, usage(30))],
        'b.jsonl',
      ),
    );
    assert.equal(own(retried.rows).uncachedInputTokens, 40);
    assert.deepEqual(
      retried.rows.map((r) => r.ordinal),
      [0, 1],
    );
    // 其他 step 的 retry-started 不关闭当前替换槽。
    const other = await fold(
      await session(
        dir,
        [header(), attempt(0, 1, 1, usage(10)), retry(1, 1, 2), message(2, 1, 1, usage(30))],
        'c.jsonl',
      ),
    );
    assert.equal(own(other.rows).uncachedInputTokens, 30);
    // 相同的替换保持原样本（包括时间）。
    const same = await fold(
      await session(
        dir,
        [header(), message(0, 1, 1, usage(9)), message(5, 1, 1, usage(9))],
        'd.jsonl',
      ),
    );
    assert.deepEqual(
      same.rows.map((r) => r.time),
      [T],
    );
  }));

test('缓存桶缺省为 0；无效用量跳过并告警', () =>
  withDir(async (dir) => {
    const { rows, ctx } = await fold(
      await session(dir, [
        header(),
        message(0, 1, 1, { inputTokens: 4, outputTokens: 1 }),
        message(1, 1, 2, { inputTokens: -1, outputTokens: 1 }),
        message(2, 1, 3, { inputTokens: 1.5, outputTokens: 1 }),
        message(3, 1, 4, { inputTokens: 1, outputTokens: 1, cacheReadTokens: '3' }),
      ]),
    );
    assert.deepEqual(own(rows), {
      uncachedInputTokens: 4,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.deepEqual(codes(ctx), ['dsh_invalid_usage']);
    assert.equal([...ctx.issues.values()][0].count, 3);
  }));

test('模型归属：message 用来源，attempt 用最近的请求路由，v0 旧结构用 provenance', () =>
  withDir(async (dir) => {
    const file = await session(dir, [
      header(),
      {
        type: 'request/header',
        seq: 0,
        time: T,
        data: {
          header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } },
          reason: 'initial',
        },
      },
      attempt(1, 1, 1, usage(1)),
      {
        type: 'request/context',
        seq: 2,
        time: T,
        data: { provider: 'xiaomi', model: 'mimo-v2.5' },
      },
      attempt(3, 1, 2, usage(1)),
      message(4, 1, 3, usage(1)),
    ]);
    const ctx = { issues: new Map() };
    const rows = await dsh([file], ctx);
    assert.deepEqual(
      rows.map((r) => [r.provider, r.model]),
      [
        ['deepseek-account', 'deepseek-flash'],
        ['xiaomi', 'mimo-v2.5'],
        ['p', 'm'],
      ],
    );
    const legacy = await session(
      dir,
      [
        { type: 'session', version: 0, id: 'old', createdAt: T, delegationDepth: 0 },
        {
          type: 'assistant/message',
          seq: 0,
          time: T,
          data: {
            turn: 1,
            step: 1,
            content: [],
            provenance: { provider: 'deepseek', model: 'deepseek-chat' },
            usage: usage(2),
          },
        },
      ],
      'session.jsonl',
    );
    const [old] = await dsh([legacy], { issues: new Map() });
    assert.equal(old.model, 'deepseek-chat');
  }));

test('残缺末行 / 截断末帧按 DSH 规则丢弃，不告警；完整帧损坏时保留之前的记录并告警', () =>
  withDir(async (dir) => {
    const lines = [
      header(),
      message(0, 1, 1, usage(10)),
      message(1, 1, 2, usage(20)),
      message(2, 1, 3, usage(30)),
    ].map((r) => JSON.stringify(r));
    const raw = join(dir, 'raw.jsonl');
    await writeFile(raw, lines.join('\n'));
    let r = await fold(raw);
    assert.deepEqual(
      r.rows.map((x) => x.inputTokens),
      [10, 20],
    );
    assert.deepEqual(codes(r.ctx), []);
    const frames = lines.map((l) => zstd(l + '\n'));
    const torn = join(dir, 'torn.jsonl.zstd');
    await writeFile(torn, Buffer.concat([...frames.slice(0, -1), frames.at(-1).subarray(0, 10)]));
    r = await fold(torn);
    assert.deepEqual(
      r.rows.map((x) => x.inputTokens),
      [10, 20],
    );
    assert.deepEqual(codes(r.ctx), []);
    const broken = Buffer.from(frames[2]);
    broken[broken.length - 2] ^= 0xff;
    const corrupt = join(dir, 'corrupt.jsonl.zstd');
    await writeFile(corrupt, Buffer.concat([frames[0], frames[1], broken, frames[3]]));
    r = await fold(corrupt);
    assert.deepEqual(
      r.rows.map((x) => x.inputTokens),
      [10],
    );
    assert.deepEqual(codes(r.ctx), ['dsh_corrupt']);
  }));

test('未知新版本尽力统计并告警；分叉会话缺截点标记时不计且告警', () =>
  withDir(async (dir) => {
    let r = await fold(await session(dir, [header({ version: 5 }), message(0, 1, 1, usage(3))]));
    assert.equal(own(r.rows).uncachedInputTokens, 3);
    assert.deepEqual(codes(r.ctx), ['dsh_untested_version']);
    r = await fold(
      await session(dir, [header({ isSeeded: true }), message(0, 1, 1, usage(3))], 'b.jsonl'),
    );
    assert.deepEqual(r.rows, []);
    assert.deepEqual(codes(r.ctx), ['dsh_seed_cut']);
    r = await fold(
      await session(
        dir,
        [
          header({ isSeeded: true, parentSession: 'p' }),
          message(0, 1, 1, usage(3)),
          { type: 'session/end-seed', seq: 1, time: T, data: {} },
          { type: 'session/end-seed', seq: 2, time: T, data: { inherited: true } },
          message(3, 2, 1, usage(4)),
        ],
        'c.jsonl',
      ),
    );
    assert.equal(own(r.rows).uncachedInputTokens, 4);
    assert.equal(r.s.cut, 2);
  }));

test('压缩摘要用量只在扩展模式计入', () =>
  withDir(async (dir) => {
    const rows = [
      header(),
      message(0, 1, 1, usage(3)),
      {
        type: 'compaction/summary',
        seq: 1,
        time: T,
        data: {
          compactionId: 'c1',
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          usage: usage(100, 10),
        },
      },
    ];
    const file = await session(dir, rows);
    assert.equal(own(await dsh([file], { issues: new Map() })).uncachedInputTokens, 3);
    const extended = await dsh([file], { issues: new Map() }, { extended: true });
    assert.equal(own(extended).uncachedInputTokens, 103);
    assert.ok(extended.some((r) => r.id === 'dsh:s:compaction:c1'));
  }));
