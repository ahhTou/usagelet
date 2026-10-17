// 比较同一来源的原始统计，不执行别名重写、过滤差异或上传操作。
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { collect } from '../src/collect.mjs';
import { normalize } from '../test/cases.mjs';
const bin = process.env.CCUSAGE_BIN;
if (!bin) throw Error('需要 CCUSAGE_BIN');
assert.match(execFileSync(bin, ['--version'], { encoding: 'utf8' }), /^ccusage 20\.0\.21\s*$/);
const args = process.argv.slice(2),
  get = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
const timezone = get('--tz') ?? 'Asia/Shanghai',
  since = get('--since'),
  until = get('--until');
const flags = ['daily', '--json', '--by-agent', '-O', '--timezone', timezone];
if (since) flags.push('--since', since);
if (until) flags.push('--until', until);
const expected = normalize(
  JSON.parse(execFileSync(bin, flags, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })),
);
const collector = args.includes('--bundle')
  ? (await import('../dist/usagelet.mjs')).collect
  : collect;
const start = performance.now(),
  result = await collector({ timezone, since, until }),
  actual = normalize(result);
assert.deepEqual(actual, expected);
console.log(
  JSON.stringify({
    reference: 'ccusage@20.0.21',
    timezone,
    since,
    until,
    days: result.daily.length,
    comparedRows: actual.length,
    differences: 0,
    complete: result.metadata.complete,
    sources: result.metadata.sources,
    seconds: Math.round(performance.now() - start) / 1000,
  }),
);
