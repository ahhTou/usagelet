// 用本机真实日志对照 ccusage 20.0.21：JSON（普通 / --by-agent / --no-cost）与表格（多种宽度、
// --compact / --no-cost / --breakdown）逐字节比较。只比较 ccusage 也支持的三个来源，不改写、不过滤结果。
//   node scripts/compare.mjs [--bundle] [--tz A,B] [--since X] [--until Y] [--widths 80,120]
import { spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const args = process.argv.slice(2),
  get = (key, fallback) => {
    const i = args.indexOf(key);
    return i < 0 ? fallback : args[i + 1];
  };
const bin = process.env.CCUSAGE_BIN ?? 'ccusage';
assert.match(execFileSync(bin, ['--version'], { encoding: 'utf8' }), /^ccusage 20\.0\.21\s*$/);
const lib = args.includes('--bundle')
  ? await import('../dist/usagelet.mjs')
  : await import('../src/index.mjs');
const timezones = get('--tz', 'Asia/Shanghai,UTC,America/New_York').split(',');
const widths = get('--widths', '60,80,99,100,120,160,220').split(',').map(Number);
const since = get('--since'),
  until = get('--until');
const range = [...(since ? ['--since', since] : []), ...(until ? ['--until', until] : [])];
const AGENTS = ['claude', 'codex', 'zcode'];

let compared = 0,
  differences = 0;
const check = (label, actual, expected) => {
  compared++;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    differences++;
    console.error('差异', label);
  }
};
const ccusage = (extra, env = {}) => {
  const r = spawnSync(bin, ['daily', '-O', ...range, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  return { stdout: r.stdout, stderr: r.stderr };
};

const timings = [];
for (const timezone of timezones) {
  const start = performance.now();
  const result = await lib.collect({ timezone, since, until, agents: AGENTS });
  timings.push({ timezone, seconds: Math.round(performance.now() - start) / 1000 });
  for (const [flags, options] of [
    [['--json'], {}],
    [['--json', '--by-agent'], { byAgent: true }],
    [['--json', '--no-cost'], { noCost: true }],
  ])
    check(
      `${timezone} ${flags.join(' ')}`,
      lib.reportJson(result.rows, options),
      ccusage(['-z', timezone, ...flags]).stdout,
    );
  for (const width of widths)
    for (const [flags, options] of [
      [[], {}],
      [['--compact'], { compact: true }],
      [['--no-cost'], { noCost: true }],
      [['--breakdown'], { breakdown: true }],
    ]) {
      const actual = lib.renderTable(result.rows, {
        detectedAgents: result.detectedAgents,
        terminalWidth: width,
        isTTY: false,
        color: false,
        offline: true,
        env: {},
        ...options,
      });
      const expected = ccusage(['-z', timezone, '--no-color', ...flags], {
        COLUMNS: String(width),
      });
      check(`${timezone} 表格 ${width} 列 ${flags.join(' ')}`, actual, expected);
    }
}
// 命令行本身也走一遍（JSON，第一个时区）。
const cli = spawnSync(
  process.execPath,
  [
    '--no-warnings',
    new URL(
      args.includes('--bundle') ? '../dist/usagelet.mjs' : '../src/index.mjs',
      import.meta.url,
    ).pathname,
    'daily',
    '-O',
    '-z',
    timezones[0],
    '--json',
    '--by-agent',
    '--agent',
    AGENTS.join(','),
    ...range,
  ],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
check('命令行 JSON', cli.stdout, ccusage(['-z', timezones[0], '--json', '--by-agent']).stdout);
console.log(
  JSON.stringify({ reference: 'ccusage@20.0.21', since, until, compared, differences, timings }),
);
if (differences) process.exitCode = 1;
