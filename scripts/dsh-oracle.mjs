// 用 DeepSeek Harness 自己的代码核对 test/fixtures/dsh 的预期值（只在开发机运行，不进打包产物）。
//
//   node scripts/dsh-oracle.mjs            # 对比 expected.json，并对比 usagelet 的折叠结果
//   node scripts/dsh-oracle.mjs --record   # 重新生成 expected.json
//   DSH_TREE=/path/to/tree node scripts/dsh-oracle.mjs [日志…]   # 也可以直接核对任意日志
//
// 需要本机安装 DeepSeek Harness 桌面版（默认读 /Applications/DeepSeek Harness.app 的 app.asar），
// 或用 DSH_TREE 指向一个含 node_modules/@deepseek-ai/... 的目录。脚本只把会话格式与 token-meter
// 相关的包解到临时目录并调用其中的还原、折叠函数，不运行 DSH 的其他部分，不联网。
import {
  openSync,
  readSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { readDshSession, foldDshSession } from '../src/adapters/dsh.mjs';

const ASAR =
  process.env.DSH_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const fixtures = new URL('../test/fixtures/dsh/', import.meta.url);
const args = process.argv.slice(2),
  record = args.includes('--record'),
  files = args.filter((a) => !a.startsWith('--'));

// 从 asar 里按依赖闭包解出指定包（asar：4 字节对齐的 pickle 头 + JSON 目录 + 文件数据）。
function extractTree(asar, roots) {
  const out = mkdtempSync(join(tmpdir(), 'usagelet-dsh-tree-'));
  const fd = openSync(asar, 'r'),
    head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  const json = Buffer.alloc(head.readUInt32LE(12));
  readSync(fd, json, 0, json.length, 16);
  const base = 8 + head.readUInt32LE(4),
    entries = new Map();
  (function walk(node, path) {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = path ? `${path}/${name}` : name;
      if (child.files) walk(child, p);
      else entries.set(p, child);
    }
  })(JSON.parse(json.toString('utf8')), '');
  const done = new Set(),
    queue = [...roots],
    builtins = new Set(builtinModules);
  while (queue.length) {
    const pkg = queue.shift();
    if (done.has(pkg) || builtins.has(pkg) || pkg.startsWith('node:')) continue;
    done.add(pkg);
    const prefix = `dsh/node_modules/${pkg}/`;
    for (const [p, entry] of entries) {
      if (!p.startsWith(prefix) || entry.link || entry.unpacked) continue;
      const buf = Buffer.alloc(entry.size);
      readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
      const target = join(out, p.slice('dsh/'.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
      if (!/\.(m?js|cjs)$/.test(p) || p.slice(prefix.length).includes('node_modules/')) continue;
      for (const m of buf
        .toString('utf8')
        .matchAll(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"'./][^"']*)["']/g)) {
        const spec = m[1];
        queue.push(
          spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0],
        );
      }
    }
  }
  return out;
}

function decode(file) {
  let buf = readFileSync(file);
  if (!file.endsWith('.zstd')) return buf.toString('utf8');
  const parts = [];
  while (buf.length) {
    const d = buf[4],
      single = !!(d & 0x20),
      flag = d >>> 6,
      dict = d & 3;
    let offset =
      5 + (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
    for (;;) {
      const header = buf.readUIntLE(offset, 3),
        type = (header >>> 1) & 3;
      offset += 3 + (type === 1 ? 1 : header >>> 3);
      if (header & 1) break;
    }
    offset += d & 4 ? 4 : 0;
    parts.push(zlib.zstdDecompressSync(buf.subarray(0, offset)));
    buf = buf.subarray(offset);
  }
  return Buffer.concat(parts).toString('utf8');
}

const tree =
  process.env.DSH_TREE ??
  extractTree(ASAR, ['@deepseek-ai/dsh-session-format-catalog', '@deepseek-ai/dsh-token-meter']);
const load = (p) => import(pathToFileURL(join(tree, 'node_modules', p)).href);
const { createSessionFormatCatalogWithChildren } = await load(
  '@deepseek-ai/dsh-session-format-catalog/lib/index.js',
);
const { tokenUsageProjectionDefinition: def } = await load(
  '@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js',
);
const pkg = JSON.parse(
  readFileSync(join(tree, 'node_modules/@deepseek-ai/dsh-token-meter/package.json'), 'utf8'),
);

// DSH 官方口径：还原为当前格式后，用 tokenUsage 投影折叠全部事件与自有事件。
function official(file) {
  const rows = decode(file)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const restore = createSessionFormatCatalogWithChildren([]).createRestore(rows[0], {
    recovery: 'recoverable',
    validation: 'transformed',
  });
  for (const row of rows.slice(1)) restore.decodeRow(row);
  const artifact = restore.finish();
  const fold = (events) => events.reduce((s, e) => def.apply(s, e), def.init()).totals;
  const own = artifact.events.slice(artifact.inheritedEventCount);
  const compaction = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    count: 0,
  };
  for (const e of own)
    if (e.type === 'compaction/summary' && e.data.usage) {
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
        compaction[k] += e.data.usage[k] ?? 0;
      compaction.count++;
    }
  return {
    id: artifact.header.id,
    version: rows[0].version,
    isSeeded: artifact.header.isSeeded,
    all: fold(artifact.events),
    own: fold(own),
    compaction,
  };
}

async function ours(file) {
  const ctx = { issues: new Map() };
  const session = await readDshSession(file, ctx, { extended: true });
  const own = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const r of foldDshSession(session, ctx)) {
    own.uncachedInputTokens += r.inputTokens;
    own.outputTokens += r.outputTokens;
    own.cacheReadTokens += r.cacheReadTokens;
    own.cacheWriteTokens += r.cacheCreationTokens;
  }
  const compaction = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    count: 0,
  };
  for (const c of session.compactions.filter((c) => c.seq >= session.cut)) {
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
      compaction[k] += c.usage[k] ?? 0;
    compaction.count++;
  }
  return { own, compaction, warnings: [...ctx.issues.values()] };
}

let mismatches = 0;
if (files.length) {
  for (const file of files) {
    const o = official(file),
      u = await ours(file);
    const same =
      JSON.stringify(o.own) === JSON.stringify(u.own) &&
      JSON.stringify(o.compaction) === JSON.stringify(u.compaction);
    if (!same) mismatches++;
    console.log(same ? '一致' : '差异', file, same ? '' : JSON.stringify({ official: o, ours: u }));
  }
} else {
  const expectedFile = new URL('expected.json', fixtures);
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
  const next = { ...expected, dshVersion: pkg.version, fixtures: {} };
  for (const [name, meta] of Object.entries(expected.fixtures)) {
    const file = new URL(`${name}.jsonl`, fixtures).pathname;
    const o = official(file),
      u = await ours(file);
    next.fixtures[name] = { source: meta.source, ...o };
    try {
      if (!record) assert.deepEqual({ source: meta.source, ...o }, meta);
      assert.deepEqual(u.own, o.own);
      assert.deepEqual(u.compaction, o.compaction);
      console.log('一致', name);
    } catch (e) {
      mismatches++;
      console.error('差异', name, e.message);
    }
  }
  if (record) writeFileSync(expectedFile, JSON.stringify(next, null, 2) + '\n');
}
console.log(`DSH ${pkg.version} 官方口径核对：${mismatches} 项差异（${basename(tree)}）`);
if (!process.env.DSH_TREE) rmSync(tree, { recursive: true, force: true });
if (mismatches) process.exitCode = 1;
