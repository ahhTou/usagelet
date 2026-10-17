import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { CASES, populate, environment, normalize } from '../test/cases.mjs';
import { collect } from '../src/collect.mjs';
const bin = process.env.CCUSAGE_BIN;
if (!bin) throw Error('请通过 CCUSAGE_BIN 指定 ccusage 20.0.21 的可执行文件');
assert.match(execFileSync(bin, ['--version'], { encoding: 'utf8' }), /^ccusage 20\.0\.21\s*$/);
const golden = {
  reference: 'ccusage@20.0.21',
  commit: '3c5556a775ebcf1e59844d4283c8c5b30529c290',
  cases: [],
};
let mismatches = 0;
for (const c of CASES) {
  const root = await mkdtemp(join(tmpdir(), 'usagelet-oracle-'));
  try {
    await populate(root, c);
    const env = environment(root, c);
    // ccusage 要求 Claude 配置目录至少包含 projects，即使本例只测试其他来源。
    const { mkdir } = await import('node:fs/promises');
    for (const dir of env.CLAUDE_CONFIG_DIR.split(','))
      await mkdir(join(dir, 'projects'), { recursive: true });
    for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      const expected = normalize(
        JSON.parse(
          execFileSync(bin, ['daily', '--json', '--by-agent', '-O', '--timezone', timezone], {
            env,
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
          }),
        ),
      );
      const actual = normalize(await collect({ home: root, env, timezone }));
      golden.cases.push({ name: c.name, timezone, expected });
      try {
        assert.deepEqual(actual, expected);
        console.log('通过', c.name, timezone);
      } catch {
        mismatches++;
        console.error('差异', c.name, timezone, JSON.stringify({ expected, actual }));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv.includes('--record'))
  await writeFile(
    new URL('../test/golden.json', import.meta.url),
    JSON.stringify(golden, null, 2) + '\n',
  );
console.log(`${golden.cases.length} 项直接对比，${mismatches} 项差异`);
if (mismatches) process.exitCode = 1;
