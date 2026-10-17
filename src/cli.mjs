import { resolve } from 'node:path';
import { collect } from './collect.mjs';
import { VERSION, AGENTS, BUCKETS } from './shared.mjs';
const HELP = `usagelet ${VERSION} · 本机 Agent 用量统计（Node.js >= 22.16）
用法：node usagelet.mjs [daily] [选项]
  --json                  输出 JSON；默认显示终端汇总
  --mode <ccusage|extended> 默认 ccusage，对齐 20.0.21；extended 才补读压缩历史
  --agent <来源>          claude,codex,zcode,deepseek，可用逗号选择多个
  --source <来源=路径>    指定日志目录 / 文件；ZCode 指向 SQLite 文件，可重复
  --tz <时区>             默认系统时区，与 ccusage 相同
  --since <YYYY-MM-DD>    起始日期（包含）
  --until <YYYY-MM-DD>    结束日期（包含）
  --no-compressed         仅用于与旧工具对账；主动排除压缩日志
  --by-agent -O           兼容 ccusage 调用；离线采集本来就不请求定价
  --version               显示版本
Qoder 暂缓接入。只读取日志与用量表，不读取凭据、不上传任何数据。
JSON 中缺失的计数为 null，并附 knownTokens / missingFields。
退出码：0 完整统计；2 存在数据质量警告；1 无法完成采集。`;
function dateOption(value) {
  value = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error(`无效日期 ${value}`);
  return value;
}
export async function main(args = process.argv.slice(2)) {
  const options = { sources: {} };
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg =
      { '--timezone': '--tz', '-z': '--tz', '-j': '--json', '-s': '--since', '-u': '--until' }[
        args[i]
      ] ?? args[i];
    if (['--help', '-h'].includes(arg)) {
      console.log(HELP);
      return 0;
    }
    if (arg === '--version') {
      console.log(VERSION);
      return 0;
    }
    if ((arg === 'daily' && i === 0) || ['--by-agent', '-O', '--offline'].includes(arg)) continue;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-compressed') {
      options.noCompressed = true;
      continue;
    }
    if (!['--agent', '--source', '--tz', '--since', '--until', '--mode'].includes(arg))
      throw new Error(`未知参数 ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    if (arg === '--mode') options.mode = value;
    if (arg === '--agent') options.agents = [...new Set(value.split(','))];
    if (arg === '--tz') {
      new Intl.DateTimeFormat('en', { timeZone: value });
      options.timezone = value;
    }
    if (arg === '--since') options.since = dateOption(value);
    if (arg === '--until') options.until = dateOption(value);
    if (arg === '--source') {
      const at = value.indexOf('='),
        agent = value.slice(0, at);
      if (at < 1 || !AGENTS.includes(agent) || !value.slice(at + 1))
        throw new Error('--source 格式为 来源=路径（Qoder 暂缓）');
      (options.sources[agent] ??= []).push(resolve(value.slice(at + 1)));
    }
  }
  if (options.since && options.until && options.since > options.until)
    throw new Error('--since 不能晚于 --until');
  const result = await collect(options);
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`usagelet ${VERSION} · ${result.metadata.timezone}`);
    console.log(
      '日期        来源      模型                         输入         输出       缓存写入       缓存读取',
    );
    for (const d of result.daily)
      for (const a of d.agents)
        for (const m of a.modelBreakdowns)
          console.log(
            `${d.period}  ${a.agent.padEnd(9)} ${m.modelName.padEnd(28)} ${BUCKETS.map((k) => String(m[k] ?? '未知').padStart(12)).join(' ')}`,
          );
    console.log(
      `\n${result.daily.length} 天 · 总 token：${result.totals.totalTokens ?? '不完整，见 JSON 的已知计数'}`,
    );
    for (const source of result.metadata.sources)
      console.log(
        `${source.agent}: ${source.status} · ${source.files} 文件 · ${source.records} 条用量`,
      );
  }
  for (const w of result.metadata.warnings)
    console.error(`[${w.code}] ${w.source}: ${w.message}（${w.count} 次）`);
  if (!result.metadata.complete) console.error('统计存在缺失或未确认项；请勿直接替换云端历史。');
  return result.metadata.complete ? 0 : 2;
}
