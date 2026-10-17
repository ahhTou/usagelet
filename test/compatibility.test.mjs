import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect } from '../src/index.mjs';
import { collect as bundledCollect } from '../dist/usagelet.mjs';
import { CASES, populate, environment, normalize } from './cases.mjs';
const golden = JSON.parse(await readFile(new URL('./golden.json', import.meta.url), 'utf8'));
assert.equal(golden.reference, 'ccusage@20.0.21');
for (const sample of golden.cases)
  test(`ccusage 20.0.21 原始输出：${sample.name} / ${sample.timezone}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'usagelet-compat-'));
    try {
      const c = CASES.find((c) => c.name === sample.name);
      assert.ok(c);
      await populate(root, c);
      const env = environment(root, c);
      const result = await collect({ home: root, env, timezone: sample.timezone });
      assert.equal(result.metadata.compatibility, 'ccusage@20.0.21');
      assert.deepEqual(normalize(result), sample.expected);
      assert.deepEqual(
        normalize(await bundledCollect({ home: root, env, timezone: sample.timezone })),
        sample.expected,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
