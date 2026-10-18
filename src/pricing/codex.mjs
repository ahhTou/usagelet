// Codex 的分组与计费，移植自 ccusage 20.0.21 rust/adapters/codex/src（aggregate.rs、report.rs、
// speed.rs，MIT）。Codex 先把事件按日、按模型累加成整数，再按模型计价：每个请求按自身输入量判定
// 是否长上下文，时间相关定价（DeepSeek V4）按事件时间戳分桶，服务档位（fast / priority）只影响
// 已记录档位的那部分用量。
import { longContextSplitThreshold } from './map.mjs';
import { hasTimeDependentPricing } from './deepseek.mjs';
import { missingPricingModelForTokenTotal } from './cost.mjs';
import { compareUtf8, saturatingSub } from './util.mjs';

const bucket = () => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_tokens: 0,
  output_tokens: 0,
  long_context_input_tokens: 0,
  long_context_cached_input_tokens: 0,
  long_context_cache_creation_tokens: 0,
  long_context_output_tokens: 0,
});

/** Rust 的 f64 Iterator::sum 以 -0.0 起算；空和得到 -0.0。 */
const sumF64 = (values) => values.reduce((a, b) => a + b, -0);

export const newCodexGroup = () => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
  models: new Map(),
  last_activity: null,
});

const newModelUsage = () => ({
  ...bucket(),
  reasoning_output_tokens: 0,
  total_tokens: 0,
  recorded_standard_usage: bucket(),
  recorded_fast_usage: bucket(),
  timestamped_usage: new Map(),
  is_fallback: false,
});

function addToBucket(target, event, long) {
  target.input_tokens += event.input_tokens;
  target.cached_input_tokens += event.cached_input_tokens;
  target.cache_creation_tokens += event.cache_creation_tokens;
  target.output_tokens += event.output_tokens;
  if (long) {
    target.long_context_input_tokens += event.input_tokens;
    target.long_context_cached_input_tokens += event.cached_input_tokens;
    target.long_context_cache_creation_tokens += event.cache_creation_tokens;
    target.long_context_output_tokens += event.output_tokens;
  }
}

const timestamped = (usage, timestampMs) => {
  let t = usage.timestamped_usage.get(timestampMs);
  if (!t) {
    t = { usage: bucket(), recorded_standard_usage: bucket(), recorded_fast_usage: bucket() };
    usage.timestamped_usage.set(timestampMs, t);
  }
  return t;
};

/**
 * accumulate_codex_event_into_group（record_service_tier = false）。
 * event：{ timestamp（原始字符串）, input_tokens（含缓存）, cached_input_tokens, cache_creation_tokens,
 * output_tokens, reasoning_output_tokens, total_tokens, is_fallback_model }；model 已解析别名。
 */
export function accumulateCodexEvent(group, event, model, timestampMs, aliases) {
  group.input_tokens += event.input_tokens;
  group.cached_input_tokens += event.cached_input_tokens;
  group.cache_creation_tokens += event.cache_creation_tokens;
  group.output_tokens += event.output_tokens;
  group.reasoning_output_tokens += event.reasoning_output_tokens;
  group.total_tokens += event.total_tokens;
  if (group.last_activity === null || compareUtf8(event.timestamp, group.last_activity) > 0)
    group.last_activity = event.timestamp;
  let usage = group.models.get(model);
  if (!usage) group.models.set(model, (usage = newModelUsage()));
  usage.input_tokens += event.input_tokens;
  usage.cached_input_tokens += event.cached_input_tokens;
  usage.cache_creation_tokens += event.cache_creation_tokens;
  usage.output_tokens += event.output_tokens;
  usage.reasoning_output_tokens += event.reasoning_output_tokens;
  usage.total_tokens += event.total_tokens;
  const long = event.input_tokens > longContextSplitThreshold(model);
  if (long) {
    usage.long_context_input_tokens += event.input_tokens;
    usage.long_context_cached_input_tokens += event.cached_input_tokens;
    usage.long_context_cache_creation_tokens += event.cache_creation_tokens;
    usage.long_context_output_tokens += event.output_tokens;
  }
  if (hasTimeDependentPricing(model, aliases))
    addToBucket(timestamped(usage, timestampMs).usage, event, long);
  usage.is_fallback ||= event.is_fallback_model;
}

/** apply_recorded_usage_entries 的单条：去重后的事件带着合并后的服务档位补进已记录用量。 */
export function recordCodexServiceTier(group, event, model, timestampMs, serviceTier, aliases) {
  if (serviceTier !== 'standard' && serviceTier !== 'fast') return;
  const usage = group?.models.get(model);
  if (!usage) return;
  const long = event.input_tokens > longContextSplitThreshold(model);
  const key = serviceTier === 'standard' ? 'recorded_standard_usage' : 'recorded_fast_usage';
  addToBucket(usage[key], event, long);
  if (hasTimeDependentPricing(model, aliases))
    addToBucket(timestamped(usage, timestampMs)[key], event, long);
}

/** non_cached_input_tokens */
export const nonCachedInputTokens = (input, cached, creation) =>
  saturatingSub(input, cached + creation);

/** CodexSpeedPolicy：{ kind: 'auto' | 'forced', tier: 'standard' | 'fast' }。 */
export function resolveCodexSpeed(configTomlContents = []) {
  const fast = configTomlContents.some((content) =>
    content.split(/\r?\n/).some((line) => {
      const setting = line.split('#')[0].trim();
      const at = setting.indexOf('=');
      if (at < 0 || setting.slice(0, at).trim() !== 'service_tier') return false;
      const value = setting
        .slice(at + 1)
        .trim()
        .replace(/^["']+|["']+$/g, '');
      return value === 'fast' || value === 'priority';
    }),
  );
  return { kind: 'auto', tier: fast ? 'fast' : 'standard' };
}

const subtractBucket = (total, excluded) =>
  Object.fromEntries(Object.keys(total).map((k) => [k, saturatingSub(total[k], excluded[k])]));

// calculate_codex_bucket_cost：长上下文请求整单按长上下文价，短请求按平价，两部分分开算。
function bucketCost(u, p) {
  const cacheRead = p.cache_read_explicit ? p.cache_read : p.input;
  const cacheCreation = p.cache_create;
  const longInputRate = p.input_above_200k ?? p.input;
  const longOutputRate = p.output_above_200k ?? p.output;
  const longCacheRead = p.cache_read_explicit
    ? (p.cache_read_above_200k ?? cacheRead)
    : longInputRate;
  const longCacheCreationRate = p.cache_create_above_200k ?? cacheCreation;
  const longInput = Math.min(u.long_context_input_tokens, u.input_tokens);
  const longCached = Math.min(u.long_context_cached_input_tokens, u.cached_input_tokens, longInput);
  const longCacheCreation = Math.min(
    u.long_context_cache_creation_tokens,
    u.cache_creation_tokens,
    saturatingSub(longInput, longCached),
  );
  const longOutput = Math.min(u.long_context_output_tokens, u.output_tokens);
  const shortCached = saturatingSub(u.cached_input_tokens, longCached);
  const shortCacheCreation = saturatingSub(u.cache_creation_tokens, longCacheCreation);
  const shortNonCached = saturatingSub(
    saturatingSub(u.input_tokens, longInput),
    shortCached + shortCacheCreation,
  );
  const longNonCached = saturatingSub(longInput, longCached + longCacheCreation);
  return (
    shortNonCached * p.input +
    shortCached * cacheRead +
    shortCacheCreation * cacheCreation +
    (u.output_tokens - longOutput) * p.output +
    longNonCached * longInputRate +
    longCached * longCacheRead +
    longCacheCreation * longCacheCreationRate +
    longOutput * longOutputRate
  );
}

function usageCost(total, recordedStandard, recordedFast, p, speed) {
  const standard = bucketCost(total, p);
  let fast;
  if (speed.kind === 'forced') {
    if (speed.tier === 'standard') return standard;
    fast = total;
  } else fast = speed.tier === 'standard' ? recordedFast : subtractBucket(total, recordedStandard);
  return standard + bucketCost(fast, p) * (p.fast_multiplier - 1.0);
}

const modelBucket = (usage) => ({
  input_tokens: usage.input_tokens,
  cached_input_tokens: usage.cached_input_tokens,
  cache_creation_tokens: usage.cache_creation_tokens,
  output_tokens: usage.output_tokens,
  long_context_input_tokens: usage.long_context_input_tokens,
  long_context_cached_input_tokens: usage.long_context_cached_input_tokens,
  long_context_cache_creation_tokens: usage.long_context_cache_creation_tokens,
  long_context_output_tokens: usage.long_context_output_tokens,
});

/** calculate_codex_model_cost */
export function calculateCodexModelCost(model, usage, pricing, speed) {
  if (usage.timestamped_usage.size > 0) {
    const costs = [];
    for (const ts of [...usage.timestamped_usage.keys()].sort((a, b) => a - b)) {
      const p = pricing.findAt(model, ts);
      if (!p) continue;
      const t = usage.timestamped_usage.get(ts);
      costs.push(usageCost(t.usage, t.recorded_standard_usage, t.recorded_fast_usage, p, speed));
    }
    return sumF64(costs);
  }
  const p = pricing.find(model);
  if (!p) return 0;
  return usageCost(
    modelBucket(usage),
    usage.recorded_standard_usage,
    usage.recorded_fast_usage,
    p,
    speed,
  );
}

/** calculate_group_cost：按模型名字节序（BTreeMap）逐个求和。 */
export const sortedModels = (group) => [...group.models.keys()].sort(compareUtf8);
export const calculateGroupCost = (group, pricing, speed) =>
  sumF64(
    sortedModels(group).map((model) =>
      calculateCodexModelCost(model, group.models.get(model), pricing, speed),
    ),
  );

/** codex_model_missing_pricing */
export const codexModelMissingPricing = (model, usage, pricing) =>
  missingPricingModelForTokenTotal(
    model,
    Math.max(usage.total_tokens, usage.input_tokens + usage.output_tokens),
    pricing,
  ) !== null;
