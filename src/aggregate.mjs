import { BUCKETS, ZERO, sum } from './shared.mjs';
function group() {
  return {
    knownTokens: ZERO(),
    missingFields: new Set(),
    records: 0,
    reportedTotal: 0,
    extraTotalTokens: 0,
  };
}
function add(g, row) {
  for (const k of BUCKETS) {
    g.knownTokens[k] = sum([g.knownTokens[k], row[k] ?? 0]);
    if (row[k] === null) g.missingFields.add(k);
  }
  g.extraTotalTokens = sum([g.extraTotalTokens, row.extraTotalTokens ?? 0]);
  g.reportedTotal = sum([
    g.reportedTotal,
    row.reportedTotalTokens ?? sum([...BUCKETS.map((k) => row[k] ?? 0), row.extraTotalTokens ?? 0]),
  ]);
  g.records++;
}
function finish(g) {
  return {
    ...Object.fromEntries(
      BUCKETS.map((k) => [k, g.missingFields.has(k) ? null : g.knownTokens[k]]),
    ),
    totalTokens: g.missingFields.size ? null : g.reportedTotal,
    extraTotalTokens: g.extraTotalTokens,
    knownTokens: g.knownTokens,
    missingFields: [...g.missingFields].sort(),
    records: g.records,
  };
}
export function aggregate(rows, options = {}) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dates = new Map(),
    totals = group();
  for (const row of rows) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(row.timestamp)).map((x) => [x.type, x.value]),
    );
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if ((options.since && day < options.since) || (options.until && day > options.until)) continue;
    if (BUCKETS.every((k) => row[k] === 0) && !row.extraTotalTokens && !row.reportedTotalTokens)
      continue;
    let d = dates.get(day);
    if (!d) {
      d = { ...group(), agents: new Map(), models: new Map() };
      dates.set(day, d);
    }
    let a = d.agents.get(row.agent);
    if (!a) {
      a = { ...group(), models: new Map() };
      d.agents.set(row.agent, a);
    }
    for (const g of [totals, d, a]) add(g, row);
    if (row.model !== null) {
      for (const map of [d.models, a.models]) {
        const g = map.get(row.model) ?? group();
        add(g, row);
        map.set(row.model, g);
      }
    }
  }
  const modelBreakdowns = (map) =>
    [...map]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([modelName, g]) => ({ modelName, ...finish(g), cost: null, missingPricing: true }));
  return {
    daily: [...dates]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, d]) => ({
        period,
        agent: 'all',
        ...finish(d),
        modelBreakdowns: modelBreakdowns(d.models),
        agents: [...d.agents]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([agent, a]) => ({
            agent,
            ...finish(a),
            modelBreakdowns: modelBreakdowns(a.models),
          })),
      })),
    totals: finish(totals),
  };
}
