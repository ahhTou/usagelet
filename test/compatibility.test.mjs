// 默认口径与 ccusage 20.0.21 逐字节一致：预期文本由真实 ccusage 生成（scripts/oracle.mjs --record）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import * as source from '../src/index.mjs';
import * as bundle from '../dist/usagelet.mjs';
import { CASES, populate, outputs } from './cases.mjs';

const golden = JSON.parse(
  gunzipSync(await readFile(new URL('./golden.json.gz', import.meta.url))).toString('utf8'),
);
assert.equal(golden.reference, 'ccusage@20.0.21');
for (const sample of golden.cases)
  test(`ccusage 20.0.21 原始输出：${sample.name} / ${sample.timezone}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'usagelet-compat-'));
    try {
      const c = CASES.find((c) => c.name === sample.name);
      assert.ok(c);
      await populate(root, c);
      for (const lib of [source, bundle]) {
        const actual = await outputs(lib, root, c, sample.timezone);
        assert.equal(actual.byAgent, sample.expected.byAgent);
        assert.equal(actual.plain, sample.expected.plain);
        assert.deepEqual(actual.table, sample.expected.table);
        assert.deepEqual(actual.modes, sample.expected.modes);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
