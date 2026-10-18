// 命令行：参数与输出对齐 ccusage 20.0.21 的 `ccusage daily`（统一日报）。
import { resolve } from 'node:path';
import { collect } from './collect.mjs';
import { VERSION, AGENTS } from './shared.mjs';
import { reportJson, renderTable } from './report.mjs';
import { terminalWidth } from './report/terminal.mjs';

const HELP = `usagelet ${VERSION} · 本机 Agent 用量统计（Node.js >= 22.16），输出格式与 ccusage 20.0.21 相同

用法：node usagelet.mjs [daily] [选项]

ccusage 同名选项：
  -j, --json                 输出 JSON
  -s, --since <日期>          起始日期（YYYY-MM-DD 或 YYYYMMDD，包含）
  -u, --until <日期>          结束日期（包含）
      --last <N>             只看最近 N 天（1 表示今天）
  -z, --timezone <时区>       按此 IANA 时区切日，默认系统时区（也可写 --tz）
      --by-agent             JSON 中附每个 Agent 的明细
  -m, --mode <模式>           费用模式：auto（默认，有记录费用用记录值）、calculate、display
  -o, --order <asc|desc>     日期排序，默认 asc
  -b, --breakdown            表格中列出每个模型
      --compact              紧凑表格
      --no-cost              不输出费用
      --color / --no-color   强制开关颜色（也认 FORCE_COLOR / NO_COLOR）
  -O, --offline              接受但无影响：usagelet 只用内置价格快照（等同 ccusage -O）
      --all                  接受但无影响：默认就统计所有检测到的来源

usagelet 选项：
      --agent <来源>          claude,codex,zcode,dsh，逗号分隔；默认全部（dsh 也可写 deepseek）
      --source <来源=路径>    指定日志目录 / 文件；ZCode 指向 SQLite 文件；可重复
      --extended             扩展口径：额外读 Codex 压缩归档与独立 compaction、DSH 压缩摘要等，
                             不保证与 ccusage 相同
      --no-compressed        扩展口径下排除压缩日志
  -v, --version              显示版本
  -h, --help                 显示帮助

只离线读取日志与用量表，不读取凭据、不联网、不上传。DeepSeek Harness 按 DSH 自身的 tokenUsage 口径统计。
退出码：0 完整统计；2 有数据质量警告（见 stderr）；1 无法完成。`;

const SHORT = {
  '-j': '--json',
  '-s': '--since',
  '-u': '--until',
  '-z': '--timezone',
  '--tz': '--timezone',
  '-m': '--mode',
  '-o': '--order',
  '-b': '--breakdown',
  '-O': '--offline',
  '-v': '--version',
  '-h': '--help',
};
const VALUE = new Set([
  '--since',
  '--until',
  '--last',
  '--timezone',
  '--mode',
  '--order',
  '--agent',
  '--source',
]);
const FLAGS = new Set([
  '--json',
  '--by-agent',
  '--breakdown',
  '--compact',
  '--no-cost',
  '--color',
  '--no-color',
  '--offline',
  '--no-offline',
  '--all',
  '--extended',
  '--no-compressed',
]);

export function parseArgs(args) {
  const options = { sources: {} },
    flags = {};
  let rest = [...args];
  if (rest[0] === 'daily') rest = rest.slice(1);
  for (let i = 0; i < rest.length; i++) {
    let arg = rest[i],
      inline;
    // 支持 --flag=value 写法。
    if (arg.startsWith('--') && arg.includes('='))
      [arg, inline] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
    arg = SHORT[arg] ?? arg;
    if (arg === '--help' || arg === '--version') return { [arg.slice(2)]: true };
    if (FLAGS.has(arg)) {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (!VALUE.has(arg)) throw new Error(`未知参数 ${rest[i]}`);
    const value = inline ?? rest[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--')))
      throw new Error(`${arg} 缺少值`);
    switch (arg) {
      case '--since':
      case '--until':
        options[arg.slice(2)] = value;
        break;
      case '--last':
        if (!/^\d+$/.test(value) || Number(value) < 1)
          throw new Error(`--last 的值 ${value} 无效，应为 1 或更大的整数`);
        options.last = Number(value);
        break;
      case '--timezone':
        new Intl.DateTimeFormat('en', { timeZone: value });
        options.timezone = value;
        break;
      case '--mode':
        // 兼容 v0.2 的 --mode ccusage|extended；ccusage 的 --mode 是费用模式。
        if (value === 'extended') flags.extended = true;
        else if (value !== 'ccusage') {
          if (!['auto', 'calculate', 'display'].includes(value))
            throw new Error(`费用模式 ${value} 无效，应为 auto、calculate 或 display`);
          options.costMode = value;
        }
        break;
      case '--order':
        if (!['asc', 'desc'].includes(value))
          throw new Error(`排序 ${value} 无效，应为 asc 或 desc`);
        options.order = value;
        break;
      case '--agent': {
        const agents = [
          ...new Set(
            value
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        ];
        if (!agents.length) throw new Error('--agent 缺少值');
        options.agents = agents;
        break;
      }
      case '--source': {
        const at = value.indexOf('='),
          agent = normalizeAgent(value.slice(0, at));
        if (at < 1 || !AGENTS.includes(agent) || !value.slice(at + 1))
          throw new Error('--source 格式为 来源=路径（来源：claude、codex、zcode、dsh）');
        (options.sources[agent] ??= []).push(resolve(value.slice(at + 1)));
        break;
      }
    }
  }
  if (flags.extended) options.mode = 'extended';
  if (flags['no-compressed']) options.noCompressed = true;
  return { options, flags };
}

export const normalizeAgent = (agent) => (agent === 'deepseek' ? 'dsh' : agent);

export async function main(args = process.argv.slice(2), io = process) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    io.stdout.write(HELP + '\n');
    return 0;
  }
  if (parsed.version) {
    io.stdout.write(VERSION + '\n');
    return 0;
  }
  const { options, flags } = parsed;
  const result = await collect(options);
  const noCost = !!flags['no-cost'];
  if (flags.json)
    io.stdout.write(reportJson(result.rows, { byAgent: !!flags['by-agent'], noCost }));
  else {
    const isTTY = !!io.stdout.isTTY;
    const out = renderTable(result.rows, {
      detectedAgents: result.detectedAgents,
      compact: !!flags.compact,
      noCost,
      breakdown: !!flags.breakdown,
      color: flags.color ? true : flags['no-color'] ? false : undefined,
      terminalWidth: terminalWidth(),
      isTTY,
      offline: !!flags.offline,
    });
    io.stdout.write(out.stdout);
    if (out.stderr) io.stderr.write(out.stderr);
  }
  for (const w of result.metadata.warnings)
    io.stderr.write(`[${w.code}] ${w.source}: ${w.message}（${w.count} 次）\n`);
  if (!result.metadata.complete)
    io.stderr.write('统计存在缺失或未确认项；请勿直接替换云端历史。\n');
  return result.metadata.complete ? 0 : 2;
}
