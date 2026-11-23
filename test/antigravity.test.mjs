import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { collect, reportJson } from '../src/index.mjs';

function varint(value) {
  let number = BigInt(value);
  const bytes = [];
  while (number >= 128n) {
    bytes.push(Number(number & 127n) | 128);
    number >>= 7n;
  }
  return Buffer.from([...bytes, Number(number)]);
}

function fields(...entries) {
  return Buffer.concat(
    entries.flatMap(([id, value]) => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      return Buffer.isBuffer(bytes)
        ? [varint(id * 8 + 2), varint(bytes.length), bytes]
        : [varint(id * 8), varint(value)];
    }),
  );
}

const stamp = (date) => fields([1, Date.parse(date) / 1000]);
const usage = (input, total, reasoning, id) =>
  fields([2, input], [3, total], [4, 20], [5, 40], [9, reasoning], [11, id]);

function generation({ model, date, primary, retries = [], steps }) {
  const chat = [];
  if (model) chat.push([19, model]);
  if (date) chat.push([9, fields([4, stamp(date)])]);
  if (primary) chat.push([4, primary]);
  chat.push(...retries.map((retry) => [17, fields([2, retry])]));
  return fields([1, fields(...chat)], ...(steps ? [[2, Buffer.concat(steps.map(varint))]] : []));
}

function seed(path, { generations, steps = [], trajectory }) {
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)');
    const insert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
    generations.forEach((row, index) => insert.run(index, row));
    if (steps.length) {
      db.exec('CREATE TABLE steps (idx INTEGER, metadata BLOB)');
      const addStep = db.prepare('INSERT INTO steps VALUES (?, ?)');
      steps.forEach(([index, row]) => addStep.run(index, row));
    }
    if (trajectory) {
      db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)');
      db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?)').run(
        fields([2, stamp(trajectory)]),
      );
    }
  } finally {
    db.close();
  }
}

test('Antigravity 自动发现、按请求身份合并、重试及推理费用与 ccusage 一致', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'usagelet-antigravity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = join(home, '.gemini', 'antigravity-cli');
  const dir = join(parent, 'conversations');
  const backup = join(home, '.gemini', 'antigravity-backup', 'conversations');
  await mkdir(dir, { recursive: true });
  await mkdir(backup, { recursive: true });
  const model = 'Gemini 3.8 Flash (High)';
  const primary = usage(300, 60, 10, 'primary');
  const retry = usage(100, 15, 5, 'retry');
  const at = '2026-12-31T20:00:00Z';
  seed(join(dir, 'session.db'), {
    generations: [
      generation({ model, primary, retries: [primary, retry], steps: [4] }),
      generation({ primary: usage(130, 30, 15, 'third') }),
      generation({
        model: 'gemini-4-neon',
        date: '2027-01-01T20:00:00Z',
        primary: usage(390, 20, 1, 'neon'),
      }),
    ],
    steps: [[4, fields([8, stamp(at)], [9, usage(350, 65, 11, 'primary')])]],
    trajectory: '2027-01-01T04:00:00Z',
  });
  seed(join(backup, 'mirror.db'), {
    generations: [generation({ model, date: at, primary })],
  });
  await symlink(dir, join(backup, 'alias'));
  // 根目录里会话摘要库不能干扰 conversations 的发现。
  seed(join(parent, 'conversation_summaries.db'), {
    generations: [generation({ date: at, primary: usage(999, 99, 30, 'summary') })],
  });
  const opts = { home, env: {}, agents: ['agy'], timezone: 'Asia/Shanghai' };
  const actual = await collect(opts);
  assert.equal(actual.metadata.complete, true);
  assert.equal(actual.metadata.sources[0].files, 2);
  assert.equal(actual.metadata.sources[0].records, 4);
  assert.deepEqual(actual.detectedAgents, ['antigravity']);
  assert.deepEqual(
    actual.daily.map((row) => [
      row.period,
      row.inputTokens,
      row.outputTokens,
      row.totalTokens,
      row.modelsUsed,
    ]),
    [
      ['2027-01-01', 580, 79, 870, ['gemini-3.8-flash-high']],
      ['2027-01-02', 390, 19, 470, ['gemini-4-neon']],
    ],
  );
  const cli = execFileSync(
    process.execPath,
    [
      '--no-warnings',
      new URL('../dist/usagelet.mjs', import.meta.url).pathname,
      'daily',
      '--agent',
      'antigravity',
      '--source',
      `agy=${parent}`,
      '--source',
      `antigravity=${backup}`,
      '-z',
      opts.timezone,
      '--json',
      '--by-agent',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli, reportJson(actual.rows, { byAgent: true }));
  const oracle = process.env.CCUSAGE_ANTIGRAVITY_BIN;
  if (oracle) {
    const expected = execFileSync(
      oracle,
      ['daily', '-O', '-z', opts.timezone, '--json', '--by-agent'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, ANTIGRAVITY_DATA_DIR: `${parent},${backup}` },
      },
    );
    assert.equal(cli, expected);
  }
});

test('Antigravity 会话库损坏时保留其余数据库的统计并告警', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'usagelet-antigravity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  seed(join(root, 'bad.db'), { generations: [Buffer.from([0])] });
  seed(join(root, 'ok.db'), {
    generations: [
      generation({
        model: 'gemini-4-neon',
        date: '2026-11-23T00:00:00Z',
        primary: usage(100, 20, 5, 'ok'),
      }),
    ],
  });
  const data = await collect({
    agents: ['antigravity'],
    env: { ANTIGRAVITY_DATA_DIR: root },
    costMode: 'display',
    timezone: 'UTC',
  });
  assert.equal(data.metadata.complete, false);
  assert.equal(data.metadata.warnings[0].code, 'invalid_database');
  assert.equal(data.totals.totalTokens, 180);
  assert.equal(data.totals.totalCost, 0);
});
