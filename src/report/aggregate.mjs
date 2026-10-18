// ccusage 20.0.21 统一报表的聚合：summary_rows 的零行过滤、AllAccumulator.add / into_row、
// merge_agent_breakdown、merge_model_breakdowns / aggregate_model_breakdowns 与 sort_rows。
// 浮点累加的顺序与 Rust 实现一一对应，保证 totalCost / cost 逐位相同。
import { addU64, isZeroU64, toU64 } from './integer.mjs';
import { totalCmp } from './float.mjs';
import { compareBytes, sortedUnique } from './text.mjs';

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens'];

/** 规范化一个模型明细（ModelBreakdown），缺省值与 ModelBreakdown::default() 相同。 */
export function normalizeModelBreakdown(input) {
  if (typeof input?.modelName !== 'string')
    throw new TypeError('modelBreakdowns[].modelName 必须是字符串');
  const out = { modelName: input.modelName };
  for (const key of [...TOKEN_FIELDS, 'extraTotalTokens']) out[key] = toU64(input[key], key);
  out.cost = input.cost ?? 0;
  if (typeof out.cost !== 'number')
    throw new TypeError('modelBreakdowns[].cost 必须是 number（f64）');
  out.missingPricing = input.missingPricing === true;
  return out;
}

/** 规范化一个 Agent 行（AllRow 子集）。metadataAgents 缺省为 [agent]，与 summary_rows / codex_group_row 一致。 */
export function normalizeAgentRow(input) {
  if (typeof input?.period !== 'string') throw new TypeError('period 必须是字符串');
  if (typeof input.agent !== 'string') throw new TypeError('agent 必须是字符串');
  const row = {
    period: input.period,
    agent: input.agent,
    modelsUsed: [...(input.modelsUsed ?? [])],
  };
  for (const key of [...TOKEN_FIELDS, 'totalTokens']) row[key] = toU64(input[key], key);
  row.totalCost = input.totalCost ?? 0;
  if (typeof row.totalCost !== 'number') throw new TypeError('totalCost 必须是 number（f64）');
  row.metadata = input.metadata ?? null;
  row.metadataAgents =
    input.metadataAgents === undefined ? [input.agent] : (input.metadataAgents ?? null);
  row.agentBreakdowns = null;
  row.modelBreakdowns = (input.modelBreakdowns ?? []).map(normalizeModelBreakdown);
  return row;
}

const byCostDesc = (a, b) => totalCmp(b.cost, a.cost);

/** 按模型名合并明细：首次出现的顺序建桶，从默认值开始累加，最后按 cost 降序稳定排序。 */
function collectModelBreakdowns(items) {
  const indexes = new Map();
  const breakdowns = [];
  for (const item of items) {
    let b = breakdowns[indexes.get(item.modelName)];
    if (!b) {
      indexes.set(item.modelName, breakdowns.length);
      b = {
        modelName: item.modelName,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        extraTotalTokens: 0,
        cost: 0,
        missingPricing: false,
      };
      breakdowns.push(b);
    }
    for (const key of [...TOKEN_FIELDS, 'extraTotalTokens']) b[key] = addU64(b[key], item[key]);
    b.cost += item.cost;
    b.missingPricing ||= item.missingPricing;
  }
  return breakdowns;
}

/** merge_model_breakdowns：合并后按 cost 降序。 */
export const mergeModelBreakdowns = (existing, additional) =>
  collectModelBreakdowns([...existing, ...additional]).sort(byCostDesc);

/** aggregate_model_breakdowns：按行顺序合并（不排序，由 into_row 排序）。 */
export const aggregateModelBreakdowns = (rows) =>
  collectModelBreakdowns(rows.flatMap((row) => row.modelBreakdowns));

function mergeAgentBreakdown(target, source) {
  for (const key of [...TOKEN_FIELDS, 'totalTokens'])
    target[key] = addU64(target[key], source[key]);
  target.totalCost += source.totalCost;
  target.modelsUsed = sortedUnique([...target.modelsUsed, ...source.modelsUsed]);
  target.modelBreakdowns = mergeModelBreakdowns(target.modelBreakdowns, source.modelBreakdowns);
}

/** AllAccumulator */
export class AllAccumulator {
  constructor() {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheCreationTokens = 0;
    this.cacheReadTokens = 0;
    this.totalTokens = 0;
    this.totalCost = 0;
    this.models = new Set();
    this.agents = new Set();
    this.agentBreakdowns = [];
    this.agentIndexes = new Map();
  }

  add(row) {
    for (const key of [...TOKEN_FIELDS, 'totalTokens']) this[key] = addU64(this[key], row[key]);
    this.totalCost += row.totalCost;
    for (const model of row.modelsUsed) this.models.add(model);
    if (row.metadataAgents) for (const agent of row.metadataAgents) this.agents.add(agent);
    else if (row.agent !== 'all') this.agents.add(row.agent);
    const index = this.agentIndexes.get(row.agent);
    if (index !== undefined) mergeAgentBreakdown(this.agentBreakdowns[index], row);
    else {
      this.agentIndexes.set(row.agent, this.agentBreakdowns.length);
      this.agentBreakdowns.push({ ...row, metadataAgents: [row.agent], agentBreakdowns: null });
    }
  }

  intoRow(period) {
    const agentBreakdowns = this.agentBreakdowns;
    for (const breakdown of agentBreakdowns) breakdown.period = period;
    agentBreakdowns.sort((a, b) => compareBytes(a.agent, b.agent));
    const modelBreakdowns = aggregateModelBreakdowns(agentBreakdowns).sort(byCostDesc);
    return {
      period,
      agent: 'all',
      modelsUsed: [...this.models].sort(compareBytes),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      cacheReadTokens: this.cacheReadTokens,
      totalTokens: this.totalTokens,
      totalCost: this.totalCost,
      metadata: null,
      metadataAgents: [...this.agents].sort(compareBytes),
      agentBreakdowns,
      modelBreakdowns,
    };
  }
}

/** sort_rows：period 升序、同 period 再按 agent；desc 时整体反转。 */
export function sortRows(rows, order = 'asc') {
  rows.sort((a, b) => compareBytes(a.period, b.period) || compareBytes(a.agent, b.agent));
  if (order === 'desc') rows.reverse();
  return rows;
}

/**
 * 把每个 Agent 每天一行聚合成每天一个 "all" 行（ccusage 统一日报的 finish_rows）。
 * 输入顺序即 ccusage 的加载顺序；总 token 为 0 的行按 summary_rows 规则丢弃（codex 的行走
 * codex_group_row，不做此过滤）。
 * @param {object[]} agentRows
 * @param {{ order?: 'asc'|'desc', keepZeroTotals?: boolean }} [options]
 */
export function aggregateRows(agentRows, { order = 'asc', keepZeroTotals = false } = {}) {
  if (order !== 'asc' && order !== 'desc') throw new TypeError('order 只能是 asc 或 desc');
  const groups = new Map();
  for (const input of agentRows) {
    const row = normalizeAgentRow(input);
    if (!keepZeroTotals && row.agent !== 'codex' && isZeroU64(row.totalTokens)) continue;
    let group = groups.get(row.period);
    if (!group) groups.set(row.period, (group = new AllAccumulator()));
    group.add(row);
  }
  const rows = [...groups.keys()]
    .sort(compareBytes)
    .map((period) => groups.get(period).intoRow(period));
  return sortRows(rows, order);
}
