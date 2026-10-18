// 条目 → 每个 agent 每天一行，口径照搬 ccusage 20.0.21：
// Claude 的 DailyAccumulator（rust/adapters/claude/src/daily.rs）与通用 UsageAccumulator
// （rust/crates/ccusage-core/src/summary.rs）都是“按日期分组、按条目顺序累加、模型首次出现的顺序”，
// 模型明细最后按费用降序做稳定排序；再由 summary_rows 转成统一报告的 agent 行（总 token 为 0 的行丢弃）。
// 浮点费用的累加顺序决定最后几位，所以条目必须保持 ccusage 加载器的顺序。
import { BUCKETS, sum } from './shared.mjs';
import { alias } from './compat.mjs';
import { totalCmp } from './report/float.mjs';

export function dayFormatter(timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return (timestamp) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map((x) => [x.type, x.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

// entries：{ model（展示名，别名在这里解析；null 表示不进模型明细）, timestamp, 四桶, extraTotalTokens?, cost, missingPricing }
export function summarizeDaily(entries, { day, aliases, extraTotals = true }) {
  const groups = new Map();
  for (const entry of entries) {
    const date = day(entry.timestamp);
    let g = groups.get(date);
    if (!g) {
      g = {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        extraTotalTokens: 0,
        cost: 0,
        models: [],
        breakdowns: [],
        indexes: new Map(),
      };
      groups.set(date, g);
    }
    for (const k of BUCKETS) g[k] = sum([g[k], entry[k]]);
    if (extraTotals) g.extraTotalTokens = sum([g.extraTotalTokens, entry.extraTotalTokens ?? 0]);
    g.cost += entry.cost;
    if (entry.model === null || entry.model === undefined) continue;
    const model = alias(entry.model, aliases);
    let index = g.indexes.get(model);
    if (index === undefined) {
      index = g.breakdowns.length;
      g.indexes.set(model, index);
      g.models.push(model);
      g.breakdowns.push({
        modelName: model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        extraTotalTokens: 0,
        cost: 0,
        missingPricing: false,
      });
    }
    const b = g.breakdowns[index];
    for (const k of BUCKETS) b[k] = sum([b[k], entry[k]]);
    if (extraTotals) b.extraTotalTokens = sum([b.extraTotalTokens, entry.extraTotalTokens ?? 0]);
    b.cost += entry.cost;
    if (entry.missingPricing) b.missingPricing = true;
  }
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, g]) => ({
      date,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      cacheCreationTokens: g.cacheCreationTokens,
      cacheReadTokens: g.cacheReadTokens,
      extraTotalTokens: g.extraTotalTokens,
      totalCost: g.cost,
      modelsUsed: g.models,
      // Array#sort 是稳定排序，与 Rust sort_by 一致；费用降序，相同费用保持首次出现顺序。
      modelBreakdowns: g.breakdowns.sort((a, b) => totalCmp(b.cost, a.cost)),
    }));
}

export { totalCmp };

// summary_rows：一行 summary → 统一报告的 agent 行；总 token 为 0 时丢弃。
export function agentRows(agent, summaries) {
  const rows = [];
  for (const s of summaries) {
    const totalTokens = sum([...BUCKETS.map((k) => s[k]), s.extraTotalTokens ?? 0]);
    if (totalTokens === 0) continue;
    rows.push({
      period: s.date,
      agent,
      modelsUsed: s.modelsUsed,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      cacheReadTokens: s.cacheReadTokens,
      totalTokens,
      totalCost: s.totalCost,
      modelBreakdowns: s.modelBreakdowns,
    });
  }
  return rows;
}
