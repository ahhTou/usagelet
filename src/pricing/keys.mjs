// 模型键的匹配与规整，移植自 ccusage 20.0.21 rust/crates/ccusage-core/src/pricing.rs（MIT）。
import { isAsciiAlphanumeric, isAsciiDigit } from './util.mjs';

// Anthropic 日期后缀为 YYYYMMDD；其它数字后缀视为不同的模型版本。
const MODEL_DATE_SUFFIX_DIGITS = 8;

/** `normalized_pricing_key`：把 `.` 与 `@` 统一成 `-`。 */
export function normalizedPricingKey(value) {
  return value.includes('.') || value.includes('@') ? value.replace(/[.@]/g, '-') : value;
}

/** `is_pricing_key_boundary`：非 ASCII 字母数字即为边界（多字节字符的各字节同样算边界）。 */
export const isPricingKeyBoundary = (code) => !isAsciiAlphanumeric(code);

/** `suffix_starts_with_numeric_model_version`。 */
export function suffixStartsWithNumericModelVersion(key, suffix) {
  if (key.length === 0 || !isAsciiDigit(key.charCodeAt(key.length - 1))) return false;
  const first = suffix.charCodeAt(0);
  if (first !== 0x2d && first !== 0x2e) return false;
  let digits = 0;
  while (isAsciiDigit(suffix.charCodeAt(1 + digits))) digits++;
  if (digits === 0) return false;
  const after = suffix.charCodeAt(1 + digits);
  const atEnd = 1 + digits >= suffix.length;
  return !(digits === MODEL_DATE_SUFFIX_DIGITS && (atEnd || isPricingKeyBoundary(after)));
}

/** `suffix_allows_pricing_key_match`。 */
export function suffixAllowsPricingKeyMatch(key, suffix) {
  if (suffix.length === 0) return true;
  if (!isPricingKeyBoundary(suffix.charCodeAt(0))) return false;
  return !suffixStartsWithNumericModelVersion(key, suffix);
}

function matchesAt(value, key, index) {
  const before = index > 0 ? value.charCodeAt(index - 1) : -1;
  return (
    (before < 0 || isPricingKeyBoundary(before)) &&
    suffixAllowsPricingKeyMatch(key, value.slice(index + key.length))
  );
}

/**
 * `contains_pricing_key`：Rust `match_indices` 只给出互不重叠的匹配，这里按同样方式推进；
 * 空键匹配每个字符边界（含末尾）。
 */
export function containsPricingKey(value, key) {
  if (key.length === 0) {
    for (let index = 0; index <= value.length; index++) {
      const code = value.charCodeAt(index);
      // 不在代理对中间切分，保持 Rust 字符边界语义。
      if (index > 0 && code >= 0xdc00 && code <= 0xdfff) {
        const prev = value.charCodeAt(index - 1);
        if (prev >= 0xd800 && prev <= 0xdbff) continue;
      }
      if (matchesAt(value, key, index)) return true;
    }
    return false;
  }
  let from = 0;
  for (;;) {
    const index = value.indexOf(key, from);
    if (index < 0) return false;
    if (matchesAt(value, key, index)) return true;
    from = index + key.length;
  }
}

/** `pricing_key_matches`：按原样或分隔符规整后，任一方向以键边界包含即匹配。 */
export function pricingKeyMatches(candidate, model, normalizedModel) {
  if (containsPricingKey(model, candidate) || containsPricingKey(candidate, model)) return true;
  const normalizedCandidate = normalizedPricingKey(candidate);
  return (
    containsPricingKey(normalizedModel, normalizedCandidate) ||
    containsPricingKey(normalizedCandidate, normalizedModel)
  );
}

const isDigitRun = (text, from, to) => {
  for (let i = from; i < to; i++) if (!isAsciiDigit(text.charCodeAt(i))) return false;
  return true;
};

/** `model_without_date_suffix`：去掉 `-YYYY-MM-DD` 或 `-YYYYMMDD` 结尾。 */
export function modelWithoutDateSuffix(model) {
  const n = model.length;
  if (n > 11) {
    const s = n - 11;
    if (
      model.charCodeAt(s) === 0x2d &&
      isDigitRun(model, s + 1, s + 5) &&
      model.charCodeAt(s + 5) === 0x2d &&
      isDigitRun(model, s + 6, s + 8) &&
      model.charCodeAt(s + 8) === 0x2d &&
      isDigitRun(model, s + 9, n)
    ) {
      return model.slice(0, s);
    }
  }
  if (n > 9) {
    const s = n - 9;
    if (model.charCodeAt(s) === 0x2d && isDigitRun(model, s + 1, n)) return model.slice(0, s);
  }
  return model;
}

/** `pricing_alias`：模糊匹配前先映射到规范定价键。 */
export function pricingAlias(model) {
  switch (model) {
    case 'gpt-reserve':
      return 'gpt-5.6-luna';
    case 'gpt-5.6':
      return 'gpt-5.6-sol';
    case 'gpt-5.3-spark':
      return 'gpt-5.3-codex-spark';
    default:
      return null;
  }
}

/** `matches_model_suffix`：取最后一次出现，要求恰好结尾或后接 `-`。 */
export function matchesModelSuffix(part, base) {
  const index = part.lastIndexOf(base);
  if (index < 0) return false;
  const suffix = part.slice(index);
  return suffix === base || suffix.charCodeAt(base.length) === 0x2d;
}

/** `normalized_models_dev_model_id`：含 `.`、`@` 或 ASCII 大写时转小写并把 `.`、`@` 换成 `-`。 */
export function normalizedModelsDevModelId(modelId) {
  return /[.@A-Z]/.test(modelId) ? modelId.toLowerCase().replace(/[.@]/g, '-') : modelId;
}

/** `is_unversioned_models_dev_model_id`：完全不含数字的 id 不指向具体模型。 */
export const isUnversionedModelsDevModelId = (modelId) => !/[0-9]/.test(modelId);
