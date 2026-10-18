// ccusage 20.0.21 统一日报（`ccusage daily`）的 JSON 与表格输出，
// 移植自 rust/crates/ccusage-adapter-all/src/report.rs 与 ccusage-core/src/output.rs（MIT）。
import { aggregateRows, sortRows } from './report/aggregate.mjs';
import { toPrettyJson, f64, floatOrInteger, stripCostJson } from './report/json.mjs';
import { formatCurrency, jsonFloatAsF64 } from './report/float.mjs';
import { formatNumber, sumU64 } from './report/integer.mjs';
import {
  formatModelsMultiline,
  formatBreakdownModelLabel,
  agentLabel,
  sortedUnique,
} from './report/text.mjs';
import { SimpleTable, LEFT, RIGHT } from './report/table.mjs';
import { boxTitleLines, useColor, paint, logLevel, terminalWidth } from './report/terminal.mjs';

export { aggregateRows, sortRows, terminalWidth };

const USAGE_COMPACT_WIDTH_THRESHOLD = 100;
// Rust 的 f64 Iterator::sum 以 -0.0 起算。
const sumF64 = (values) => values.reduce((a, b) => a + b, -0);

const modelBreakdownJson = (b) => ({
  modelName: b.modelName,
  inputTokens: b.inputTokens,
  outputTokens: b.outputTokens,
  cacheCreationTokens: b.cacheCreationTokens,
  cacheReadTokens: b.cacheReadTokens,
  cost: f64(b.cost),
  ...(b.missingPricing ? { missingPricing: true } : {}),
});

const agentJson = (row) => ({
  agent: row.agent,
  modelsUsed: row.modelsUsed,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheCreationTokens: row.cacheCreationTokens,
  cacheReadTokens: row.cacheReadTokens,
  totalTokens: row.totalTokens,
  totalCost: floatOrInteger(row.totalCost),
  modelBreakdowns: row.modelBreakdowns.map(modelBreakdownJson),
});

function rowJson(row, includeAgents) {
  const value = { ...agentJson(row), period: row.period };
  if (row.metadataAgents) value.metadata = row.metadata ?? { agents: row.metadataAgents };
  else if (row.metadata) value.metadata = row.metadata;
  if (includeAgents && row.agentBreakdowns) value.agents = row.agentBreakdowns.map(agentJson);
  return value;
}

/** unpriced_models：至少有一条用量没查到价的模型，排序去重。 */
const unpricedModels = (rows) =>
  sortedUnique(
    rows.flatMap((row) =>
      row.modelBreakdowns.filter((b) => b.missingPricing).map((b) => b.modelName),
    ),
  );

function totalsJson(rows) {
  const totals = {
    inputTokens: sumU64(rows.map((r) => r.inputTokens)),
    outputTokens: sumU64(rows.map((r) => r.outputTokens)),
    cacheCreationTokens: sumU64(rows.map((r) => r.cacheCreationTokens)),
    cacheReadTokens: sumU64(rows.map((r) => r.cacheReadTokens)),
    totalTokens: sumU64(rows.map((r) => r.totalTokens)),
    totalCostValue: sumF64(rows.map((r) => r.totalCost)),
  };
  const unpriced = unpricedModels(rows);
  return { totals, unpriced };
}

/** 与 `ccusage daily --json [--by-agent] [--no-cost]` 的 stdout 相同（含末尾换行）。 */
export function reportJson(rows, { byAgent = false, noCost = false } = {}) {
  const { totals, unpriced } = totalsJson(rows);
  const value = {
    daily: rows.map((row) => rowJson(row, byAgent)),
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      cacheReadTokens: totals.cacheReadTokens,
      totalTokens: totals.totalTokens,
      totalCost: floatOrInteger(totals.totalCostValue),
      ...(unpriced.length ? { unpricedModels: unpriced } : {}),
    },
  };
  if (noCost) stripCostJson(value);
  return toPrettyJson(value) + '\n';
}

/** 同一份数据的普通 JS 对象形式（库接口用），数值即 JSON 里的值。 */
export const reportObject = (rows, options) => JSON.parse(reportJson(rows, options));

function detectedAgentLabels(rows, detectedAgents) {
  const agents = new Set();
  if (!detectedAgents || detectedAgents.length === 0)
    for (const row of rows) {
      if (row.metadataAgents) for (const a of row.metadataAgents) agents.add(a);
      else if (row.agent !== 'all') agents.add(row.agent);
      for (const b of row.agentBreakdowns ?? []) agents.add(b.agent);
    }
  else for (const a of detectedAgents) agents.add(a);
  if (agents.size === 0) return 'None';
  return sortedUnique([...agents])
    .map(agentLabel)
    .join(', ');
}

function tableColumns(compact, noCost) {
  const headers = compact
    ? ['Date', 'Agent', 'Models', 'Input', 'Output', 'Cost (USD)']
    : [
        'Date',
        'Agent',
        'Models',
        'Input',
        'Output',
        'Cache Create',
        'Cache Read',
        'Total Tokens',
        'Cost (USD)',
      ];
  const aligns = headers.map((_, i) => (i < 3 ? LEFT : RIGHT));
  if (noCost) {
    headers.pop();
    aligns.pop();
  }
  return { headers, aligns };
}

function tableRow(row, compact, breakdown, noCost) {
  const period = breakdown ? '' : row.period;
  const agent = breakdown
    ? `- ${agentLabel(row.agent)}`
    : row.agentBreakdowns
      ? 'All'
      : agentLabel(row.agent);
  const models = row.agentBreakdowns ? '' : formatModelsMultiline(row.modelsUsed);
  const values = compact
    ? [
        period,
        agent,
        models,
        formatNumber(row.inputTokens),
        formatNumber(row.outputTokens),
        formatCurrency(row.totalCost),
      ]
    : [
        period,
        agent,
        models,
        formatNumber(row.inputTokens),
        formatNumber(row.outputTokens),
        formatNumber(row.cacheCreationTokens),
        formatNumber(row.cacheReadTokens),
        formatNumber(row.totalTokens),
        formatCurrency(row.totalCost),
      ];
  if (noCost) values.pop();
  return values;
}

function pushModelBreakdownRows(table, breakdowns, compact, noCost, color) {
  const grey = (v) => paint(color, v, 'grey');
  for (const b of breakdowns) {
    const total = sumU64([
      b.inputTokens,
      b.outputTokens,
      b.cacheCreationTokens,
      b.cacheReadTokens,
      b.extraTotalTokens ?? 0,
    ]);
    const model = grey(formatBreakdownModelLabel(b.modelName));
    const row = compact
      ? [
          '',
          '',
          model,
          grey(formatNumber(b.inputTokens)),
          grey(formatNumber(b.outputTokens)),
          grey(formatCurrency(b.cost)),
        ]
      : [
          '',
          '',
          model,
          grey(formatNumber(b.inputTokens)),
          grey(formatNumber(b.outputTokens)),
          grey(formatNumber(b.cacheCreationTokens)),
          grey(formatNumber(b.cacheReadTokens)),
          grey(formatNumber(total)),
          grey(formatCurrency(b.cost)),
        ];
    if (noCost) row.pop();
    table.push(row);
  }
}

/**
 * 与 `ccusage daily` 的表格输出相同，返回 { stdout, stderr }。
 * options：detectedAgents、compact、noCost、breakdown、color（true / false / undefined 表示按环境）、
 * terminalWidth、isTTY、offline、env。
 */
export function renderTable(rows, options = {}) {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const color = useColor({
    color: options.color === true,
    noColor: options.color === false,
    env,
    isTTY,
  });
  let stdout = '',
    stderr = '';
  const title = `Coding (Agent) CLI Usage Report - Daily\nDetected: ${detectedAgentLabels(rows, options.detectedAgents)}`;
  if (logLevel(env) !== 0)
    stdout += boxTitleLines(title, color)
      .map((l) => l + '\n')
      .join('');
  if (rows.length === 0) return { stdout, stderr: 'No usage data found.\n' };
  const width = options.terminalWidth ?? terminalWidth({ env });
  const compact = !!options.compact || (isTTY && width < USAGE_COMPACT_WIDTH_THRESHOLD);
  const noCost = !!options.noCost;
  const { headers, aligns } = tableColumns(compact, noCost);
  const table = new SimpleTable(headers, aligns, {
    color,
    terminalWidth: width,
    compactDates: true,
  });
  for (const row of rows) {
    table.push(tableRow(row, compact, false, noCost));
    if (row.agentBreakdowns)
      for (const b of row.agentBreakdowns) {
        table.push(tableRow(b, compact, true, noCost));
        if (options.breakdown && b.modelBreakdowns.length)
          pushModelBreakdownRows(table, b.modelBreakdowns, compact, noCost, color);
      }
    else if (options.breakdown && row.modelBreakdowns.length)
      pushModelBreakdownRows(table, row.modelBreakdowns, compact, noCost, color);
  }
  table.separator();
  const { totals } = totalsJson(rows);
  const yellow = (v) => paint(color, v, 'yellow');
  const totalCost = formatCurrency(jsonFloatAsF64(totals.totalCostValue));
  const totalRow = compact
    ? [
        yellow('Total'),
        '',
        '',
        yellow(formatNumber(totals.inputTokens)),
        yellow(formatNumber(totals.outputTokens)),
        yellow(totalCost),
      ]
    : [
        yellow('Total'),
        '',
        '',
        yellow(formatNumber(totals.inputTokens)),
        yellow(formatNumber(totals.outputTokens)),
        yellow(formatNumber(totals.cacheCreationTokens)),
        yellow(formatNumber(totals.cacheReadTokens)),
        yellow(formatNumber(totals.totalTokens)),
        yellow(totalCost),
      ];
  if (noCost) totalRow.pop();
  table.push(totalRow);
  stdout += table.render();
  for (const model of unpricedModels(rows))
    stderr += options.offline
      ? `WARN  Missing embedded pricing for ${model}; cost excludes this model. Run without --offline or update ccusage after pricing is added.\n`
      : `WARN  Missing pricing for ${model}; cost excludes this model. Update pricing or run again after LiteLLM has the model.\n`;
  if (compact)
    stderr +=
      '\nRunning in Compact Mode\nExpand terminal width to see cache metrics and total tokens\n';
  return { stdout, stderr };
}
