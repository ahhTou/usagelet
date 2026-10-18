// 采集与汇总：各来源 → 每个 agent 每天一行 → 按 ccusage 统一日报规则聚合。
// 来源顺序固定为 claude、codex、zcode、dsh（前三个与 ccusage 的加载顺序一致），浮点费用的累加顺序随之确定。
import { realpath, stat } from 'node:fs/promises';
import { join, basename, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { exists, walk } from './io.mjs';
import { VERSION, AGENTS, BUCKETS } from './shared.mjs';
import { BASE_AGENTS, aliases } from './compat.mjs';
import { PricingMap, SNAPSHOT } from './pricing.mjs';
import { dayFormatter, summarizeDaily, agentRows } from './rows.mjs';
import { aggregateRows, reportObject } from './report.mjs';
import { compareBytes } from './report/text.mjs';
import { genericCost, codexRows, codexSpeed } from './cost.mjs';
import { claude } from './adapters/claude.mjs';
import { codex } from './adapters/codex.mjs';
import { zcode } from './adapters/zcode.mjs';
import { dsh, dshFiles } from './adapters/dsh.mjs';
import { claude as extendedClaude } from './adapters/claude-extended.mjs';
import { codex as extendedCodex } from './adapters/codex-extended.mjs';
import { zcode as extendedZcode } from './adapters/zcode-extended.mjs';

export const CCUSAGE_VERSION = '20.0.21';
const list = (raw) =>
  raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const normalizeAgent = (agent) => (agent === 'deepseek' ? 'dsh' : agent);

// 接受 YYYY-MM-DD 或 YYYYMMDD，统一成 YYYY-MM-DD；与 ccusage 的 --since / --until 写法一致。
function dateOption(name, value) {
  if (value === undefined || value === null) return undefined;
  const raw = value;
  if (typeof value === 'string' && /^\d{8}$/.test(value))
    value = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw Error(`${name} 无效日期 ${raw}，应为 YYYY-MM-DD 或 YYYYMMDD`);
  return value;
}

// --last N：今天（按时区）往前数 N 天，与 ccusage last_periods_since 相同。
function lastSince(last, day) {
  if (!Number.isSafeInteger(last) || last < 1) throw Error('last 应为 1 或更大的整数');
  const today = day(Date.now());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (last - 1));
  return date.toISOString().slice(0, 10);
}

// 扩展口径的记录可能有未报告的计数（null）：按 0 计入，并记下缺失字段。
function extendedEntries(records, ctx, agent) {
  const missing = new Set();
  const entries = records.map((r) => {
    for (const k of BUCKETS) if (r[k] === null || r[k] === undefined) missing.add(k);
    const row = { ...r };
    for (const k of BUCKETS) row[k] = r[k] ?? 0;
    row.extraTotalTokens = r.extraTotalTokens ?? 0;
    return { ...row, ...genericCost(ctx, row) };
  });
  if (missing.size)
    ctx.issues.set(`extended_missing:${agent}`, {
      code: 'extended_missing_fields',
      source: agent,
      message: `扩展口径下有记录未报告 ${[...missing].sort().join('、')}，按 0 计入`,
      count: 1,
    });
  return entries;
}

export async function collect(options = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw Error('usagelet 需要 Node.js >= 22.16');
  const mode = options.mode ?? 'ccusage';
  if (!['ccusage', 'extended'].includes(mode)) throw Error('mode 必须为 ccusage 或 extended');
  const costMode = options.costMode ?? 'auto';
  if (!['auto', 'calculate', 'display'].includes(costMode))
    throw Error('costMode 必须为 auto、calculate 或 display');
  const order = options.order ?? 'asc';
  const env = options.env ?? process.env,
    home = options.home ?? homedir();
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = dayFormatter(timezone);
  let since = dateOption('since', options.since);
  const until = dateOption('until', options.until);
  if (options.last !== undefined) since = lastSince(options.last, day);
  if (since && until && since > until) throw Error('since 不能晚于 until');
  const aliasMap = aliases(env.CCUSAGE_MODEL_ALIASES);
  const ctx = {
    compat: mode === 'ccusage',
    issues: new Map(),
    noCompressed: mode === 'ccusage' || !!options.noCompressed,
    aliases: aliasMap,
    costMode,
    pricing: PricingMap.loadEmbedded({ aliases: aliasMap }),
  };
  const requested = (options.agents ?? AGENTS).map(normalizeAgent);
  for (const a of requested)
    if (!AGENTS.includes(a)) throw Error(a === 'qoder' ? 'Qoder 已暂缓接入' : `未知来源 ${a}`);
  const selected = AGENTS.filter((a) => requested.includes(a));
  const sourcesOption = Object.fromEntries(
    Object.entries(options.sources ?? {}).map(([k, v]) => [normalizeAgent(k), v]),
  );

  const claudeRoots = env.CLAUDE_CONFIG_DIR
    ? list(env.CLAUDE_CONFIG_DIR).map((p) => (basename(p) === 'projects' ? p : join(p, 'projects')))
    : [
        join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'claude/projects'),
        join(home, '.claude/projects'),
      ];
  const codexHomes = env.CODEX_HOME ? list(env.CODEX_HOME) : [join(home, '.codex')];
  const codexRoots = [];
  for (const base of codexHomes) {
    const dirs = [];
    for (const name of ['sessions', 'archived_sessions'])
      if (await exists(join(base, name))) dirs.push(join(base, name));
    codexRoots.push(...(dirs.length ? dirs : [base]));
  }
  // DSH_HOME 与 DSH 一致：空白视为未设置；也接受逗号分隔多个（与社区适配器一致）。
  const dshHomes = env.DSH_HOME?.trim() ? list(env.DSH_HOME) : [join(home, '.dsh')];
  const defaults = {
    claude: claudeRoots,
    codex: codexRoots,
    zcode: (env.ZCODE_HOME ? list(env.ZCODE_HOME) : [join(home, '.zcode')]).map((p) =>
      join(p, 'cli/db/db.sqlite'),
    ),
    dsh: dshHomes.map((p) => join(p.replace(/^~(?=$|\/)/, home), 'sessions')),
  };

  const sources = [],
    rowsByAgent = [],
    detectedAgents = [];
  for (const agent of selected) {
    const explicit = sourcesOption[agent],
      paths = explicit ?? defaults[agent],
      found = [];
    for (const path of paths) {
      if (!(await exists(path))) {
        if (explicit) throw Error(`指定的 ${agent} 数据源不存在：${path}`);
        continue;
      }
      // 上游只接受文件形式的 ZCode 数据库；默认位置不是文件时同样视为未找到。
      if (agent === 'zcode' && !(await stat(path)).isFile()) {
        if (explicit)
          throw Error(
            `指定的 zcode 数据源不是文件：${path}；--source zcode= 需要指向 SQLite 数据库文件，通常是 ~/.zcode/cli/db/db.sqlite`,
          );
        continue;
      }
      found.push(await realpath(path));
    }
    const roots = [...new Set(found)];
    let files = [];
    if (agent === 'zcode') files = roots;
    else if (agent === 'dsh') files = await dshFiles(roots, ctx);
    else {
      const seenFiles = new Set(),
        relativeKeys = new Set();
      for (const path of roots)
        for (const file of await walk(path, ctx)) {
          if (seenFiles.has(file)) continue;
          if (agent === 'codex' && mode === 'ccusage') {
            const key = JSON.stringify([
              ['sessions', 'archived_sessions'].includes(basename(path)) ? dirname(path) : path,
              relative(path, file),
            ]);
            if (relativeKeys.has(key)) continue;
            relativeKeys.add(key);
          }
          seenFiles.add(file);
          files.push(file);
        }
      // ccusage 把所有 Claude 根目录的日志合在一起按路径排序后读取。
      if (agent === 'claude') files.sort(compareBytes);
    }

    const inRange = (date) => !((since && date < since) || (until && date > until));
    let rows = [],
      detected = false,
      records = 0;
    if (files.length) {
      if (agent === 'codex' && mode === 'ccusage') {
        const events = await codex(files, ctx);
        records = events.length;
        detected = events.length > 0;
        rows = codexRows(ctx, events, { day, since, until, speed: await codexSpeed(codexHomes) });
      } else {
        let entries;
        if (mode === 'ccusage') {
          if (agent === 'claude') entries = await claude(files, ctx);
          else if (agent === 'zcode') entries = await zcode(files, ctx);
          else entries = await dsh(files, ctx);
        } else if (agent === 'dsh') entries = await dsh(files, ctx, { extended: true });
        else {
          const adapter = { claude: extendedClaude, codex: extendedCodex, zcode: extendedZcode }[
            agent
          ];
          entries = extendedEntries(await adapter(files, ctx), ctx, agent);
        }
        records = entries.length;
        // Claude 的“检测到”看日期过滤前是否有日汇总；其余来源看是否有条目。
        let summaries = summarizeDaily(
          agent === 'claude' ? entries : entries.filter((e) => inRange(day(e.timestamp))),
          { day, aliases: aliasMap, extraTotals: agent !== 'claude' },
        );
        detected = entries.length > 0;
        if (agent === 'claude') summaries = summaries.filter((s) => inRange(s.date));
        rows = agentRows(agent, summaries);
      }
    }
    if (detected) detectedAgents.push(agent);
    rowsByAgent.push(...rows);
    sources.push({
      agent,
      status: !found.length ? 'not_found' : records ? 'ok' : 'no_usage',
      files: files.length,
      records,
    });
  }

  const rows = aggregateRows(rowsByAgent, { order });
  const warnings = [...ctx.issues.values()];
  const report = reportObject(rows, { byAgent: true });
  return {
    metadata: {
      tool: 'usagelet',
      version: VERSION,
      mode,
      costMode,
      // 默认口径：Claude Code / Codex / ZCode 对齐 ccusage（含费用，等同 -O 内置价格快照），
      // DeepSeek Harness 对齐 DSH 自己的 tokenUsage（只计会话自有事件）。扩展口径不声明等价。
      compatibility:
        mode === 'ccusage'
          ? {
              ccusage: CCUSAGE_VERSION,
              agents: selected.filter((a) => BASE_AGENTS.includes(a)),
              dsh: selected.includes('dsh') ? 'deepseek-harness dsh-token-meter tokenUsage' : null,
              pricing: `ccusage@${CCUSAGE_VERSION} 内置快照`,
            }
          : null,
      pricing: SNAPSHOT,
      timezone,
      since: since ?? null,
      until: until ?? null,
      complete: warnings.length === 0,
      compressedLogs: mode === 'extended' && !options.noCompressed,
      sources,
      warnings,
    },
    detectedAgents,
    rows,
    daily: report.daily,
    totals: report.totals,
  };
}
