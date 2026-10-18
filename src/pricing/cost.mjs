// 费用公式，移植自 ccusage 20.0.21 rust/crates/ccusage-core/src/cost.rs（MIT）。
// TokenUsageRaw 沿用 Rust 字段名：{ input_tokens, output_tokens, cache_creation_input_tokens,
// cache_read_input_tokens, speed?: 'fast'|'standard', cache_creation?: { ephemeral_5m_input_tokens,
// ephemeral_1h_input_tokens } }。浮点运算顺序与 Rust 一致（逐项左结合相加），结果逐位相同。
import { resolveModelName } from './aliases.mjs';
import { DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS } from './map.mjs';

const CACHE_CREATE_1H_INPUT_MULTIPLIER = 2.0;
export const COST_MODES = ['auto', 'calculate', 'display'];

const n = (value) => value ?? 0;

/** TokenUsageRaw::cache_creation_token_count */
export const cacheCreationTokenCount = (usage) =>
  usage.cache_creation
    ? n(usage.cache_creation.ephemeral_5m_input_tokens) +
      n(usage.cache_creation.ephemeral_1h_input_tokens)
    : n(usage.cache_creation_input_tokens);

/** total_usage_tokens */
export const totalUsageTokens = (usage) =>
  n(usage.input_tokens) +
  n(usage.output_tokens) +
  cacheCreationTokenCount(usage) +
  n(usage.cache_read_input_tokens);

/** tiered_cost：LiteLLM *_above_200k 的边际分档。 */
export function tieredCost(tokens, base, above, threshold) {
  if (tokens === 0) return 0;
  if (above !== null && above !== undefined && tokens > threshold)
    return threshold * base + (tokens - threshold) * above;
  return tokens * base;
}

/** calculate_cost_from_pricing */
export function calculateCostFromPricing(usage, pricing) {
  const [create5m, create1h] = usage.cache_creation
    ? [
        n(usage.cache_creation.ephemeral_5m_input_tokens),
        n(usage.cache_creation.ephemeral_1h_input_tokens),
      ]
    : [n(usage.cache_creation_input_tokens), 0];
  const input = n(usage.input_tokens),
    output = n(usage.output_tokens),
    cacheRead = n(usage.cache_read_input_tokens);
  const create1hCost = pricing.input * CACHE_CREATE_1H_INPUT_MULTIPLIER;
  const create1hCostAbove =
    pricing.input_above_200k === null
      ? null
      : pricing.input_above_200k * CACHE_CREATE_1H_INPUT_MULTIPLIER;
  // 两段式：上下文超过模型自己的门槛时，整个请求按长上下文档计价（不是边际分档）。
  if (pricing.long_context_threshold !== null) {
    const context = input + cacheRead + create5m + create1h;
    const long = context > pricing.long_context_threshold;
    const rate = (base, above) => (long ? (above ?? base) : base);
    return (
      input * rate(pricing.input, pricing.input_above_200k) +
      output * rate(pricing.output, pricing.output_above_200k) +
      create5m * rate(pricing.cache_create, pricing.cache_create_above_200k) +
      create1h * rate(create1hCost, create1hCostAbove) +
      cacheRead * rate(pricing.cache_read, pricing.cache_read_above_200k)
    );
  }
  const threshold = DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS;
  return (
    tieredCost(input, pricing.input, pricing.input_above_200k, threshold) +
    tieredCost(output, pricing.output, pricing.output_above_200k, threshold) +
    tieredCost(create5m, pricing.cache_create, pricing.cache_create_above_200k, threshold) +
    tieredCost(create1h, create1hCost, create1hCostAbove, threshold) +
    tieredCost(cacheRead, pricing.cache_read, pricing.cache_read_above_200k, threshold)
  );
}

function costFromTokens(model, usage, timestampMs, pricing) {
  if (!model) return 0;
  const p =
    timestampMs === null || timestampMs === undefined
      ? pricing?.find(model)
      : pricing?.findAt(model, timestampMs);
  if (!p) return 0;
  const multiplier = usage.speed === 'fast' ? p.fast_multiplier : 1.0;
  return calculateCostFromPricing(usage, p) * multiplier;
}

/** calculate_cost_for_usage_at：mode 为 auto（有记录费用用记录值）、calculate、display。 */
export function calculateCostForUsageAt({
  model,
  usage,
  costUSD,
  timestampMs,
  mode = 'auto',
  pricing,
}) {
  const recorded = costUSD === undefined ? null : costUSD;
  if (mode === 'display') return recorded ?? 0;
  if (mode === 'auto' && recorded !== null) return recorded;
  return costFromTokens(model, usage, timestampMs, pricing);
}

/** missing_pricing_model_for_token_total：有 token、有模型且查不到价时返回解析别名后的模型名。 */
export function missingPricingModelForTokenTotal(model, totalTokens, pricing) {
  if (totalTokens === 0 || !model || !pricing) return null;
  return pricing.find(model) ? null : resolveModelName(model, pricing.aliases);
}

/** missing_pricing_model_for_usage */
export function missingPricingModelForUsage({ model, usage, costUSD, mode = 'auto', pricing }) {
  if (mode === 'display' || (mode === 'auto' && costUSD !== undefined && costUSD !== null))
    return null;
  return missingPricingModelForTokenTotal(model, totalUsageTokens(usage), pricing);
}

/** missing_pricing_model_for_candidates */
export function missingPricingModelForCandidates(model, candidates, totalTokens, pricing) {
  if (totalTokens === 0 || !pricing) return null;
  return candidates.every((candidate) => !pricing.find(candidate))
    ? resolveModelName(model, pricing.aliases)
    : null;
}
