// Antigravity 的离线价格候选与请求级计费，参考 ccusage 4f1df4ed（MIT）。
import { calculateCostFromPricing, resolveModelName, tieredCost } from '../../pricing.mjs';
import { deepseekV4Peak, deepseekV4Rates } from '../../pricing/deepseek.mjs';
import { normalizedPricingKey, pricingAlias } from '../../pricing/keys.mjs';
import { flashPricingAlias } from './model.mjs';
import { pricingTables } from './pricing-table.mjs';

const providerPrefixes = ['google', 'gemini', 'vertex_ai', 'openrouter/google'];
const plain = (name) => name.split('/').at(-1);
const spellings = (name) =>
  [
    name,
    name.startsWith('google/') ? 'gemini/' + name.slice(7) : undefined,
    pricingAlias(name),
  ].filter(Boolean);

const suffix =
  /^(?:(?:[-:](?:minimal|low|medium|high|xhigh|extra-low|extra-high|latest|default|beta|\d{8}|\d{4}-\d{2}-\d{2}))|\[1m\])*$/;
const familySuffix = (key, rest) => {
  if (/^(claude|gemini|deepseek|glm|kimi|mistral)-/.test(key))
    return suffix.test(rest.replaceAll(/-thinking(?=$|[-:\[])/g, ''));
  if (key.startsWith('grok-')) return suffix.test(rest.replace(/-(?:non-)?reasoning$/, ''));
  return suffix.test(rest);
};

function fuzzy(name, key) {
  const candidate = normalizedPricingKey(plain(name));
  const model = normalizedPricingKey(plain(key));
  if (candidate.startsWith(model)) return familySuffix(model, candidate.slice(model.length));
  return false;
}

function lookup(candidates, { paidOnly = false } = {}) {
  const [primary, catalog] = pricingTables();
  const allowed = (row) => !paidOnly || row.rates.input !== 0 || row.rates.output !== 0;
  const best = (rows, predicate) => rows.find((row) => allowed(row) && predicate(row));
  const same = (a, b, fold) => {
    const key = normalizedPricingKey(b);
    return fold ? a.toLowerCase() === key.toLowerCase() : a === key;
  };
  const exact = (rows, key, fold) =>
    best(rows, (r) => same(r.identity, key, fold)) ??
    best(rows, (r) => r.isDirect && same(normalizedPricingKey(r.vendorKey), key, fold));

  for (const fold of [false, true]) {
    // 日志明确记录的主机价格优先于厂商的直连价格。
    for (const [name, kind] of candidates) {
      if (kind === 'exact' && name.startsWith('vertex_ai/')) {
        const hit = best(primary, (r) => r.host === 3 && same(r.identity, name, fold));
        if (hit) return hit;
      }
    }
    for (const [name] of candidates) {
      for (const key of spellings(name)) {
        const hit = exact(primary, key, fold);
        if (hit) return hit;
      }
    }
    for (const [name] of candidates) {
      for (const key of spellings(name)) {
        const hit =
          best(
            primary,
            (r) =>
              !r.free && r.isDirect && same(normalizedPricingKey(r.vendorKey), plain(key), fold),
          ) ??
          exact(catalog, key, fold) ??
          exact(catalog, plain(key), fold);
        if (hit) return hit;
      }
    }
  }

  for (const [name, kind] of candidates) {
    if (kind === 'exact') continue;
    for (const rows of [primary, catalog]) {
      const eligible = rows.filter((r) => !r.exactOnly && allowed(r) && fuzzy(name, r.key));
      eligible.sort((a, b) => {
        const length = plain(b.key).length - plain(a.key).length;
        return (
          length ||
          Number(b.key === plain(b.key)) - Number(a.key === plain(a.key)) ||
          Number(b.isDirect) - Number(a.isDirect)
        );
      });
      if (eligible.length) return eligible[0];
    }
  }
}

const december = Date.UTC(2026, 11, 1);
const january = Date.UTC(2027, 0, 1);
const anthropicGA = Date.UTC(2026, 2, 13);
const googleFlash = (timestamp) =>
  timestamp < january
    ? rates(0.75e-6, 3.75e-6, 0.75e-6, 0.075e-6)
    : rates(1.5e-6, 7.5e-6, 1.5e-6, 0.15e-6);

function rates(input, output, cache_create, cache_read, long = null) {
  return {
    input,
    output,
    cache_create,
    cache_read,
    input_above_200k: long?.[0] ?? null,
    output_above_200k: long?.[1] ?? null,
    cache_create_above_200k: long?.[2] ?? null,
    cache_read_above_200k: long?.[3] ?? null,
    long_context_threshold: long ? 200000 : null,
  };
}

function scheduledRates(schedule, timestamp) {
  // 编号与上游 SCHEDULES 中的排序一致（0 表示没有时间调价）。
  switch (schedule) {
    case 1: {
      const peak = timestamp < 1789012800000 || deepseekV4Peak(timestamp);
      const input = peak ? 0.3e-6 : 0.15e-6;
      return rates(input, peak ? 1.2e-6 : 0.6e-6, input, peak ? 0.006e-6 : 0.003e-6);
    }
    case 2:
    case 3:
    case 4: {
      if (schedule !== 4 && timestamp >= 1789012800000) return scheduledRates(1, timestamp);
      const p = deepseekV4Rates(
        schedule === 4 ? 'deepseek-v4-pro' : 'deepseek-v4-flash',
        timestamp,
      );
      return rates(p.input, p.output, p.cache_create, p.cache_read);
    }
    case 5:
      return rates(
        3e-6,
        15e-6,
        3e-6 * 1.25,
        3e-6 * 0.1,
        timestamp < anthropicGA ? [6e-6, 22.5e-6, 7.5e-6, 0.6e-6] : null,
      );
    case 6:
      return rates(
        5e-6,
        25e-6,
        5e-6 * 1.25,
        5e-6 * 0.1,
        timestamp < anthropicGA ? [10e-6, 37.5e-6, 12.5e-6, 1e-6] : null,
      );
    case 7:
    case 8:
    case 9:
      return timestamp < 1778857152000
        ? rates(0.2e-6, 1.5e-6, 0.2e-6, 0.02e-6)
        : {
            ...rates(1e-6, 2e-6, 1e-6, 0.2e-6, [2e-6, 4e-6, 2e-6, 0.4e-6]),
            long_context_threshold: 199999,
          };
    case 10:
    case 11:
      return timestamp < december
        ? rates(2e-6, 10e-6, 2e-6, 0.1e-6)
        : rates(4e-6, 20e-6, 4e-6, 0.2e-6);
    case 12:
    case 13:
    case 14:
      return googleFlash(timestamp);
    case 15:
      return timestamp < december
        ? rates(1.25e-6, 10e-6, 1.25e-6, 0.125e-6, [2.5e-6, 15e-6, 2.5e-6, 0.25e-6])
        : googleFlash(timestamp);
    case 16:
      return rates(0.3e-6, 2.5e-6, 0.3e-6, 0.03e-6);
    case 17:
      return timestamp < january
        ? rates(0.5e-6, 9e-6, 0.5e-6, 0.05e-6)
        : rates(1e-6, 18e-6, 1e-6, 0.1e-6);
    case 18:
      return timestamp < january
        ? rates(0.5e-6, 6e-6, 0.5e-6, 0.05e-6)
        : rates(1e-6, 12e-6, 1e-6, 0.1e-6);
    case 19:
    case 20:
      return timestamp < january
        ? rates(1e-6, 5e-6, 1e-6, 0.1e-6)
        : rates(2e-6, 10e-6, 2e-6, 0.2e-6);
  }
}

function candidates(model, provider, aliases, kind) {
  const names = [model];
  const base = flashPricingAlias(model);
  if (base) names.push(base);
  const result = new Map();
  for (const name of names) {
    const options = [name];
    if (provider === 3n) options.unshift('vertex_ai/' + name);
    if (provider === 24n || provider === 30n)
      options.push(...providerPrefixes.map((prefix) => prefix + '/' + name));
    for (const option of options) {
      result.set(option, option.startsWith('vertex_ai/') && provider === 3n ? 'exact' : kind);
      const alias = resolveModelName(option, aliases);
      if (alias !== option) result.set(alias, kind);
    }
  }
  return [...result];
}

export function antigravityCost({ aliases, costMode }) {
  const prices = new Map();
  return (row) => {
    if (costMode === 'display') return { cost: 0, missingPricing: false };
    const { model, provider, loggedModel, timestamp } = row;
    const key = JSON.stringify([model, String(provider), loggedModel]);
    if (!prices.has(key)) {
      const names = candidates(
        model,
        provider,
        aliases,
        flashPricingAlias(model) ? 'exact' : 'fuzzy',
      );
      if (loggedModel) names.unshift([loggedModel, 'exact']);
      const alias = resolveModelName(model, aliases);
      if (alias !== model) names.unshift([alias, 'exact']);
      const base = model.endsWith('-thinking') ? model.slice(0, -9) : null;
      let matched = lookup(names);
      if (matched?.free && (provider === 3n || loggedModel?.includes('/')))
        matched = lookup(names, { paidOnly: true });
      prices.set(key, matched ?? (base && lookup(candidates(base, provider, aliases, 'fuzzy'))));
    }
    const match = prices.get(key);
    if (!match) return { cost: 0, missingPricing: true };
    const { rates: price, schedule, isDirect } = match;
    const scheduled =
      schedule && (provider !== 3n || (isDirect && schedule >= 10))
        ? scheduledRates(schedule, timestamp)
        : null;
    const billed = scheduled ?? price;
    const usage = {
      input_tokens: row.inputTokens,
      output_tokens: row.totalOutputTokens,
      cache_creation_input_tokens: row.cacheCreationTokens,
      cache_read_input_tokens: row.cacheReadTokens,
    };
    const threshold = billed.marginal_threshold;
    const cost =
      threshold === null || threshold === undefined
        ? calculateCostFromPricing(usage, billed)
        : tieredCost(row.inputTokens, billed.input, billed.input_above_200k, threshold) +
          tieredCost(row.totalOutputTokens, billed.output, billed.output_above_200k, threshold) +
          tieredCost(
            row.cacheCreationTokens,
            billed.cache_create,
            billed.cache_create_above_200k,
            threshold,
          ) +
          tieredCost(
            row.cacheReadTokens,
            billed.cache_read,
            billed.cache_read_above_200k,
            threshold,
          );
    return { cost, missingPricing: false };
  };
}
