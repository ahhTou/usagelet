// 用真实 ccusage 20.0.21 生成并核对固定样本的完整输出（JSON 与表格文本逐字节比较）。
//   CCUSAGE_BIN=/path/to/ccusage node scripts/oracle.mjs            # 只比较
//   CCUSAGE_BIN=/path/to/ccusage node scripts/oracle.mjs --record   # 重写 test/golden.json
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { CASES, populate, environment, outputs } from '../test/cases.mjs';
import * as usagelet from '../src/index.mjs';

const bin = process.env.CCUSAGE_BIN ?? 'ccusage';
assert.match(execFileSync(bin, ['--version'], { encoding: 'utf8' }), /^ccusage 20\.0\.21\s*$/);
const TIMEZONES = ['UTC', 'Asia/Shanghai', 'America/New_York'];
const golden = {
  reference: 'ccusage@20.0.21',
  commit: '3c5556a775ebcf1e59844d4283c8c5b30529c290',
  columns: 120,
  cases: [],
};

let mismatches = 0;
for (const c of CASES) {
  const root = await mkdtemp(join(tmpdir(), 'usagelet-oracle-'));
  try {
    await populate(root, c);
    const env = { ...environment(root, c), COLUMNS: '120', NO_COLOR: '1' };
    // ccusage 要求 Claude 配置目录至少包含 projects，即使本例只测试其他来源。
    for (const dir of env.CLAUDE_CONFIG_DIR.split(','))
      await mkdir(join(dir, 'projects'), { recursive: true });
    for (const timezone of TIMEZONES) {
      const run = (args) => {
        const r = spawnSync(bin, ['daily', '-O', '--timezone', timezone, ...args], {
          env,
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        });
        return { stdout: r.stdout, stderr: r.stderr };
      };
      const expected = {
        byAgent: run(['--json', '--by-agent']).stdout,
        plain: run(['--json']).stdout,
        table: run(['--no-color']),
        modes: Object.fromEntries(
          (c.costModes ?? []).map((m) => [m, run(['--mode', m, '--json', '--by-agent']).stdout]),
        ),
      };
      const actual = await outputs(usagelet, root, c, timezone);
      golden.cases.push({ name: c.name, timezone, expected });
      try {
        assert.equal(actual.byAgent, expected.byAgent);
        assert.equal(actual.plain, expected.plain);
        assert.deepEqual(actual.table, expected.table);
        assert.deepEqual(actual.modes, expected.modes);
        console.log('通过', c.name, timezone);
      } catch (e) {
        mismatches++;
        console.error('差异', c.name, timezone, e.message.slice(0, 2000));
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv.includes('--record'))
  await writeFile(
    new URL('../test/golden.json.gz', import.meta.url),
    gzipSync(JSON.stringify(golden) + '\n', { level: 9 }),
  );
console.log(`${golden.cases.length} 项直接对比（每项含两份 JSON 与表格），${mismatches} 项差异`);
if (mismatches) process.exitCode = 1;
