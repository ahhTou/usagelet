// DeepSeek V4 按时间生效的价格表，移植自 ccusage 20.0.21 pricing.rs（MIT）。
import { resolveModelName } from './aliases.mjs';
import { normalizedPricingKey } from './keys.mjs';
import { MILLIS_PER_DAY, MILLIS_PER_HOUR } from './time.mjs';

/** 2026-08-16T16:00:00Z 起执行新价格与高峰时段。 */
export const DEEPSEEK_V4_PRICING_CUTOFF_MS = 1_786_896_000_000;

// 与 Rust 字面量逐字相同，JS 与 rustc 对同一十进制字面量都正确舍入。
const RATES = {
  'deepseek-v4-flash': {
    old: { input: 0.14e-6, output: 0.28e-6, cache_create: 0.14e-6, cache_read: 0.0028e-6 },
    offPeak: { input: 0.22e-6, output: 0.66e-6, cache_create: 0.22e-6, cache_read: 0.007e-6 },
    peak: { input: 0.44e-6, output: 1.32e-6, cache_create: 0.44e-6, cache_read: 0.014e-6 },
  },
  'deepseek-v4-pro': {
    old: { input: 0.435e-6, output: 0.87e-6, cache_create: 0.435e-6, cache_read: 0.003625e-6 },
    offPeak: { input: 0.66e-6, output: 1.98e-6, cache_create: 0.66e-6, cache_read: 0.022e-6 },
    peak: { input: 1.32e-6, output: 3.96e-6, cache_create: 1.32e-6, cache_read: 0.044e-6 },
  },
};

/** `deepseek_v4_model_identity`：只认直连的两个模型（分隔符拼写等价），带提供商前缀的不算。 */
export function deepseekV4ModelIdentity(model) {
  const normalized = normalizedPricingKey(model);
  return normalized === 'deepseek-v4-flash' || normalized === 'deepseek-v4-pro' ? normalized : null;
}

/** `has_time_dependent_pricing`：模型本身或别名解析后是否走时间价格表。 */
export function hasTimeDependentPricing(model, aliases) {
  return (
    (deepseekV4ModelIdentity(model) ??
      deepseekV4ModelIdentity(resolveModelName(model, aliases))) !== null
  );
}

const euclidMod = (a, b) => ((a % b) + b) % b;

/** `deepseek_v4_peak`：按 UTC 计算，周一至周五的 [01,04) 与 [06,10) 点为高峰。 */
export function deepseekV4Peak(timestampMs) {
  // 整数运算实现 div_euclid / rem_euclid，避免浮点除法在日界附近取整出错。
  const msOfDay = euclidMod(timestampMs, MILLIS_PER_DAY);
  const days = (timestampMs - msOfDay) / MILLIS_PER_DAY;
  const weekdayFromSunday = euclidMod(days + 4, 7);
  if (weekdayFromSunday < 1 || weekdayFromSunday > 5) return false;
  const hour = (msOfDay - (msOfDay % MILLIS_PER_HOUR)) / MILLIS_PER_HOUR;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** `deepseek_v4_rates`。 */
export function deepseekV4Rates(model, timestampMs) {
  const table = RATES[model];
  if (!table) return null;
  if (timestampMs < DEEPSEEK_V4_PRICING_CUTOFF_MS) return table.old;
  return deepseekV4Peak(timestampMs) ? table.peak : table.offPeak;
}

/** `apply_deepseek_v4_schedule`：返回新的 Pricing，长上下文档位与基础档位同价。 */
export function applyDeepseekV4Schedule(model, timestampMs, pricing) {
  const rates = deepseekV4Rates(model, timestampMs);
  if (!rates) return pricing;
  return {
    ...pricing,
    input: rates.input,
    output: rates.output,
    cache_create: rates.cache_create,
    cache_read: rates.cache_read,
    input_above_200k: rates.input,
    output_above_200k: rates.output,
    cache_create_above_200k: rates.cache_create,
    cache_read_above_200k: rates.cache_read,
    cache_create_explicit: true,
    cache_read_explicit: true,
  };
}
