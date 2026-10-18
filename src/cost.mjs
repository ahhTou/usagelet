// 各来源接入 ccusage 计费规则的薄层：Claude、ZCode、DSH 按条目算费用，Codex 按日分组后算。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  calculateCostForUsageAt,
  missingPricingModelForUsage,
  missingPricingModelForCandidates,
  totalUsageTokens,
  newCodexGroup,
  accumulateCodexEvent,
  recordCodexServiceTier,
  nonCachedInputTokens,
  resolveCodexSpeed,
  calculateCodexModelCost,
  calculateGroupCost,
  codexModelMissingPricing,
  sortedModels,
  parseTsTimestamp,
} from './pricing.mjs';
import { totalCmp } from './report/float.mjs';

const modeOf = (ctx) => ctx.costMode ?? 'auto';

// Claude（rust/adapters/claude/src/daily.rs）：显示模式不查价；auto 模式有 costUSD 就用记录值。
export function usageCost(ctx, { model, usage, costUSD, timestamp }) {
  const mode = modeOf(ctx),
    pricing = mode === 'display' ? null : ctx.pricing;
  return {
    cost: calculateCostForUsageAt({ model, usage, costUSD, timestampMs: timestamp, mode, pricing }),
    missingPricing: missingPricingModelForUsage({ model, usage, costUSD, mode, pricing }) !== null,
  };
}

// ZCode（rust/adapters/zcode/src/parser.rs）：provider 不是 Z.ai 时不查价；Z.ai 的缓存写入按输入价计费。
const ZAI_PROVIDERS = new Set([
  'zai',
  'z.ai',
  'zai-coding-plan',
  'builtin:zai-coding-plan',
  'builtin:bigmodel-coding-plan',
]);
const isZaiProvider = (provider) =>
  typeof provider === 'string' && ZAI_PROVIDERS.has(provider.trim().toLowerCase());
const isZaiModel = (lower) => lower.startsWith('glm-') || lower.startsWith('glm/');
const dedupConsecutive = (list) => list.filter((x, i) => i === 0 || x !== list[i - 1]);
function zcodePricingModel(raw, provider, pricing) {
  const lower = raw.toLowerCase();
  const candidates = [raw, lower];
  if (isZaiProvider(provider) || (provider === null && isZaiModel(lower)))
    candidates.push(`zai/${raw}`, `zai/${lower}`);
  const list = dedupConsecutive(candidates);
  if (provider !== null && !isZaiProvider(provider)) return null;
  return (
    list.find((c) => c.startsWith('zai/') && pricing.find(c)) ??
    list.find((c) => !c.startsWith('zai/') && pricing.find(c)) ??
    null
  );
}
export function zcodeCost(ctx, { model, providerId, usage, timestamp }) {
  const mode = modeOf(ctx);
  const costModel = zcodePricingModel(model, providerId, ctx.pricing);
  const zai = isZaiProvider(providerId) || (providerId === null && isZaiModel(model.toLowerCase()));
  const extra = usage.extraTotalTokens ?? 0;
  const raw = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationTokens,
    cache_read_input_tokens: usage.cacheReadTokens,
  };
  const costUsage = zai
    ? {
        ...raw,
        input_tokens: raw.input_tokens + raw.cache_creation_input_tokens,
        cache_creation_input_tokens: 0,
        output_tokens: raw.output_tokens + extra,
      }
    : { ...raw, output_tokens: raw.output_tokens + extra };
  return {
    cost:
      mode === 'display'
        ? 0
        : calculateCostForUsageAt({
            model: costModel,
            usage: costUsage,
            timestampMs: timestamp,
            mode: 'calculate',
            pricing: ctx.pricing,
          }),
    missingPricing: mode !== 'display' && costModel === null && totalUsageTokens(raw) + extra > 0,
  };
}

// DSH：与社区 DSH 适配器相同，先试 provider/model，再试 model。
export function dshCost(ctx, row) {
  const mode = modeOf(ctx),
    pricing = ctx.pricing;
  const usage = {
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_creation_input_tokens: row.cacheCreationTokens,
    cache_read_input_tokens: row.cacheReadTokens,
  };
  const candidates = dedupConsecutive(
    row.provider ? [`${row.provider}/${row.model}`, row.model] : [row.model],
  );
  let cost = 0;
  for (const candidate of candidates)
    if (mode === 'display' || pricing.find(candidate)) {
      cost = calculateCostForUsageAt({
        model: candidate,
        usage,
        timestampMs: row.timestamp,
        mode,
        pricing,
      });
      break;
    }
  return {
    cost,
    missingPricing:
      mode !== 'display' &&
      missingPricingModelForCandidates(row.model, candidates, totalUsageTokens(usage), pricing) !==
        null,
  };
}

// 扩展口径（不保证与 ccusage 相同）：按通用公式计价，缺失计数按 0。
export function genericCost(ctx, row) {
  const usage = {
    input_tokens: row.inputTokens ?? 0,
    output_tokens: row.outputTokens ?? 0,
    cache_creation_input_tokens: row.cacheCreationTokens ?? 0,
    cache_read_input_tokens: row.cacheReadTokens ?? 0,
  };
  const timestamp = typeof row.timestamp === 'number' ? row.timestamp : Date.parse(row.timestamp);
  return usageCost(ctx, { model: row.model, usage, costUSD: undefined, timestamp });
}

// Codex 服务档位：CODEX_HOME（可逗号分隔）或 ~/.codex 下 config.toml 的 service_tier。
export async function codexSpeed(homes) {
  const contents = [];
  for (const home of homes) {
    try {
      contents.push(await readFile(join(home, 'config.toml'), 'utf8'));
    } catch {
      // 没有配置文件就按标准档。
    }
  }
  return resolveCodexSpeed(contents);
}

// Codex 每日行（codex_group_row）：事件已去重（首次出现保留），重复事件只合并了服务档位。
export function codexRows(ctx, events, { day, since, until, speed }) {
  const groups = new Map(),
    placed = [];
  for (const e of events) {
    if (!e.model) continue;
    const ts = parseTsTimestamp(e.timestamp);
    if (ts === null) throw new Error(`Codex 时间戳无效：${e.timestamp}`);
    const date = day(ts);
    if ((since && date < since) || (until && date > until)) continue;
    let group = groups.get(date);
    if (!group) groups.set(date, (group = newCodexGroup()));
    const event = {
      timestamp: e.timestamp,
      input_tokens: e.raw.input_tokens,
      cached_input_tokens: e.raw.cached_input_tokens,
      cache_creation_tokens: e.raw.cache_write_input_tokens,
      output_tokens: e.raw.output_tokens,
      reasoning_output_tokens: e.raw.reasoning_output_tokens,
      total_tokens: e.raw.total_tokens,
      is_fallback_model: e.isFallbackModel,
    };
    accumulateCodexEvent(group, event, e.model, ts, ctx.aliases);
    placed.push([group, event, e.model, ts, e.serviceTier]);
  }
  for (const [group, event, model, ts, tier] of placed)
    recordCodexServiceTier(group, event, model, ts, tier, ctx.aliases);
  const mode = modeOf(ctx);
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, group]) => {
      const models = sortedModels(group);
      const modelBreakdowns = models
        .map((model) => {
          const usage = group.models.get(model);
          return {
            modelName: model,
            inputTokens: nonCachedInputTokens(
              usage.input_tokens,
              usage.cached_input_tokens,
              usage.cache_creation_tokens,
            ),
            outputTokens: usage.output_tokens,
            cacheCreationTokens: usage.cache_creation_tokens,
            cacheReadTokens: usage.cached_input_tokens,
            extraTotalTokens: 0,
            cost: calculateCodexModelCost(model, usage, ctx.pricing, speed),
            missingPricing:
              mode !== 'display' && codexModelMissingPricing(model, usage, ctx.pricing),
          };
        })
        .sort((a, b) => totalCmp(b.cost, a.cost));
      return {
        period,
        agent: 'codex',
        modelsUsed: models,
        inputTokens: nonCachedInputTokens(
          group.input_tokens,
          group.cached_input_tokens,
          group.cache_creation_tokens,
        ),
        outputTokens: group.output_tokens,
        cacheCreationTokens: group.cache_creation_tokens,
        cacheReadTokens: group.cached_input_tokens,
        totalTokens: group.total_tokens,
        totalCost: calculateGroupCost(group, ctx.pricing, speed),
        modelBreakdowns,
      };
    });
}
