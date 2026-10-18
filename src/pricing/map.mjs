// 价格表与模型查找，移植自 ccusage 20.0.21 rust/crates/ccusage-core/src/pricing.rs（MIT）。
// 只保留离线路径（等同 `ccusage -O`）：内置 LiteLLM 快照 + 内置价格 + models.dev 嵌入快照回退；
// 不联网刷新、不读配置文件里的价格覆盖。HashMap 迭代顺序会影响结果的地方（模糊匹配取最长键、
// models.dev 认领顺序）都已按上游的确定性规则实现。
import { parseSerdeJson, de, tryDecode } from './serde-json.mjs';
import { resolveModelName, toAliasMap } from './aliases.mjs';
import {
  normalizedPricingKey,
  pricingKeyMatches,
  modelWithoutDateSuffix,
  pricingAlias,
  matchesModelSuffix,
  normalizedModelsDevModelId,
  isUnversionedModelsDevModelId,
} from './keys.mjs';
import { deepseekV4ModelIdentity, applyDeepseekV4Schedule } from './deepseek.mjs';
import { compareUtf8, utf8Length } from './util.mjs';
import { snapshotText } from './snapshot.mjs';

export const DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;
const TRUST_OWNER = 3,
  TRUST_PLATFORM = 2,
  TRUST_RESELLER = 1;

const pricing = (fields) => ({
  input: 0,
  output: 0,
  cache_create: 0,
  cache_read: 0,
  cache_read_explicit: false,
  cache_create_explicit: false,
  input_above_200k: null,
  output_above_200k: null,
  cache_create_above_200k: null,
  cache_read_above_200k: null,
  long_context_threshold: null,
  fast_multiplier: 1,
  ...fields,
});

// ——— serde 解码器（字段顺序即 Rust 声明顺序；Option 字段缺失为 null）———
const f64 = de.option(de.f64),
  u64 = de.option(de.u64);
const decodeLiteLlm = de.struct([
  ['input_cost_per_token', f64, true],
  ['output_cost_per_token', f64, true],
  ['cache_creation_input_token_cost', f64, true],
  ['cache_read_input_token_cost', f64, true],
  ['input_cost_per_token_above_200k_tokens', f64, true],
  ['output_cost_per_token_above_200k_tokens', f64, true],
  ['cache_creation_input_token_cost_above_200k_tokens', f64, true],
  ['cache_read_input_token_cost_above_200k_tokens', f64, true],
  ['max_input_tokens', u64, true],
  ['provider_specific_entry', de.option(de.struct([['fast', f64, true]])), true],
]);
const decodeCompact = de.struct([
  ['i', de.f64, false],
  ['o', de.f64, false],
  ['cc', f64, true],
  ['cr', f64, true],
  ['ia', f64, true],
  ['oa', f64, true],
  ['cca', f64, true],
  ['cra', f64, true],
  ['ctx', u64, true],
  ['fast', f64, true],
]);
const decodeTierBound = de.struct([
  ['type', de.option(de.string), true],
  ['size', u64, true],
]);
const decodeCost = de.struct([
  ['input', f64, true],
  ['output', f64, true],
  ['cache_read', f64, true],
  ['cache_write', f64, true],
  [
    'tiers',
    de.option(
      de.vec(
        de.struct([
          ['input', f64, true],
          ['output', f64, true],
          ['cache_read', f64, true],
          ['cache_write', f64, true],
          ['tier', de.option(decodeTierBound), true],
        ]),
      ),
    ),
    true,
  ],
]);
const decodeModelsDevModel = de.struct([
  ['id', de.option(de.string), true],
  ['cost', de.option(decodeCost), true],
  ['limit', de.option(de.struct([['context', u64, true]])), true],
  [
    'modalities',
    de.option(
      de.struct([
        ['input', de.option(de.vec(de.string)), true],
        ['output', de.option(de.vec(de.string)), true],
      ]),
    ),
    true,
  ],
  ['exactOnly', de.option(de.bool), true],
]);

// parse_litellm_pricing：带 i / o 的紧凑条目先按紧凑结构解码，失败再按完整字段名解码。
function parseLiteLlmPricing(value) {
  if (value instanceof Map && value.has('i') && value.has('o')) {
    const compact = tryDecode(decodeCompact, value);
    if (compact)
      return {
        input_cost_per_token: compact.i,
        output_cost_per_token: compact.o,
        cache_creation_input_token_cost: compact.cc,
        cache_read_input_token_cost: compact.cr,
        input_cost_per_token_above_200k_tokens: compact.ia,
        output_cost_per_token_above_200k_tokens: compact.oa,
        cache_creation_input_token_cost_above_200k_tokens: compact.cca,
        cache_read_input_token_cost_above_200k_tokens: compact.cra,
        max_input_tokens: compact.ctx,
        provider_specific_entry: compact.fast === null ? null : { fast: compact.fast },
      };
  }
  const full = tryDecode(decodeLiteLlm, value);
  return full && full.input_cost_per_token !== null && full.output_cost_per_token !== null
    ? full
    : null;
}

// ——— models.dev 目录规则 ———
class CatalogRules {
  constructor(value) {
    const strings = (key) => new Set(de.vec(de.string)(value.get(key)));
    this.owners = strings('owners');
    this.platforms = strings('platforms');
    this.authoredModelIds = strings('authoredModelIds');
    this.assetPricedModelIds = strings('assetPricedModelIds');
    this.normalizedAuthored = [...this.authoredModelIds]
      .map(normalizedModelsDevModelId)
      .sort(compareUtf8);
  }
  rank(providerId) {
    if (this.owners.has(providerId)) return TRUST_OWNER;
    if (this.platforms.has(providerId)) return TRUST_PLATFORM;
    return TRUST_RESELLER;
  }
  isExactOnly(sourceModelId, pricingKey) {
    return (
      this.isTierVariantOfAuthoredModel(sourceModelId) || isUnversionedModelsDevModelId(pricingKey)
    );
  }
  isTierVariantOfAuthoredModel(sourceModelId) {
    if (sourceModelId.includes('/')) return false;
    const normalized = normalizedModelsDevModelId(sourceModelId);
    return this.normalizedAuthored.some(
      (authored) =>
        normalized.startsWith(authored) && normalized.slice(authored.length).startsWith('-'),
    );
  }
  isTokenPriced(sourceModelId, modalities) {
    const normalized = normalizedModelsDevModelId(sourceModelId);
    if (this.assetPricedModelIds.has(normalized)) return false;
    if (this.authoredModelIds.has(normalized)) return true;
    if (!modalities) return true;
    const output = modalities.output,
      input = modalities.input;
    const textOnlyOutput = output === null || (output.length === 1 && output[0] === 'text');
    const acceptsText = input === null || input.includes('text');
    return textOnlyOutput && acceptsText;
  }
}

// models_dev_usable_cost：按 token 计价、且 input / output 不同时为 0。
function usableCost(rules, sourceModelId, model) {
  if (!rules.isTokenPriced(sourceModelId, model.modalities)) return null;
  const cost = model.cost;
  if (!cost || cost.input === null || cost.output === null) return null;
  return cost.input !== 0 || cost.output !== 0 ? cost : null;
}

// ModelsDevCost::long_context_tier：只认按上下文分档的最低门槛那一档，单位换算成每 token。
function longContextTier(cost) {
  let best = null;
  for (const tier of cost.tiers ?? []) {
    const bound = tier.tier;
    if (!bound || bound.type !== 'context') continue;
    const threshold = bound.size;
    if (threshold === null || !(threshold > 0)) continue;
    if (best && best.threshold <= threshold) continue;
    best = {
      threshold,
      input: tier.input === null ? null : tier.input / 1_000_000,
      output: tier.output === null ? null : tier.output / 1_000_000,
      cache_create: tier.cache_write === null ? null : tier.cache_write / 1_000_000,
      cache_read: tier.cache_read === null ? null : tier.cache_read / 1_000_000,
    };
  }
  return best;
}

// ModelsDevClaim 的比较：trust、长上下文档、cache_read、cache_write、上下文上限，依次比较。
const claimKey = (c) => [
  c.trust,
  c.hasLongContextTier ? 1 : 0,
  c.hasCacheRead ? 1 : 0,
  c.hasCacheWrite ? 1 : 0,
  c.hasContextLimit ? 1 : 0,
];
function compareClaims(a, b) {
  const x = claimKey(a),
    y = claimKey(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// ——— fast 倍率覆盖 ———
class FastMultiplierOverrides {
  constructor(value) {
    const map = (key) => {
      const m = value.get(key);
      return m instanceof Map ? new Map([...m].map(([k, v]) => [k, de.f64(v)])) : new Map();
    };
    this.exact = map('exact');
    this.normalizedPrefix = map('normalized_prefix');
  }
  multiplierFor(model) {
    if (this.exact.has(model)) return this.exact.get(model);
    const alias = pricingAlias(model);
    if (alias && this.exact.has(alias)) return this.exact.get(alias);
    for (const part of model.split(/[/:]/)) {
      if (this.exact.has(part)) return this.exact.get(part);
      const partAlias = pricingAlias(part);
      if (partAlias && this.exact.has(partAlias)) return this.exact.get(partAlias);
      const normalized = part.replace(/[.@]/g, '-');
      for (const [base, multiplier] of this.normalizedPrefix)
        if (matchesModelSuffix(normalized, base)) return multiplier;
    }
    return null;
  }
}

// ——— 只允许精确请求使用的条目 ———
class ExactOnlyKeys {
  constructor() {
    this.raw = new Set();
    this.normalized = new Map();
  }
  insert(key) {
    const normalized = normalizedPricingKey(key);
    if (this.normalized.has(normalized)) {
      if (this.normalized.get(normalized) !== key) this.normalized.set(normalized, null);
    } else this.normalized.set(normalized, key);
    this.raw.add(key);
  }
  remove(key) {
    if (!this.raw.delete(key)) return;
    const normalized = normalizedPricingKey(key);
    const sharing = [...this.raw].filter((other) => normalizedPricingKey(other) === normalized);
    if (sharing.length === 0) this.normalized.delete(normalized);
    else this.normalized.set(normalized, sharing.length === 1 ? sharing[0] : null);
  }
  contains(key) {
    return this.raw.has(key);
  }
  containsAnySpelling(key) {
    return this.raw.has(key) || this.normalized.has(normalizedPricingKey(key));
  }
  idSpelledBy(key) {
    return this.normalized.get(normalizedPricingKey(key)) ?? null;
  }
}

export class PricingMap {
  constructor({ aliases } = {}) {
    this.entries = new Map();
    this.exactOnly = new ExactOnlyKeys();
    this.aliases = toAliasMap(aliases);
    this.embeddedModelsDev = null;
    this.findCache = new Map();
  }

  // load_with_overrides(offline = true, _, 无覆盖) 的最终状态。
  static loadEmbedded({ aliases } = {}) {
    const map = new PricingMap({ aliases });
    const fast = fastOverrides();
    map.loadJsonWithOverrides(snapshotText('litellm'), fast);
    map.putBuiltinPricing(fast);
    map.embeddedModelsDev = embeddedModelsDevPricing();
    map.fillLongContextRatesFromModelsDev();
    map.fillLongContextRatesFromModelsDev();
    return map;
  }

  loadJson(text) {
    return this.loadJsonWithOverrides(text, fastOverrides());
  }

  loadJsonWithOverrides(text, fast) {
    let raw;
    try {
      raw = parseSerdeJson(text);
    } catch {
      return 0;
    }
    if (!(raw instanceof Map)) return 0;
    let loaded = 0;
    for (const [model, value] of raw) {
      const p = parseLiteLlmPricing(value);
      if (!p) continue;
      const input = p.input_cost_per_token,
        output = p.output_cost_per_token;
      this.entries.set(
        model,
        pricing({
          input,
          output,
          cache_create: p.cache_creation_input_token_cost ?? input * 1.25,
          cache_read: p.cache_read_input_token_cost ?? input * 0.1,
          cache_read_explicit: p.cache_read_input_token_cost !== null,
          cache_create_explicit: p.cache_creation_input_token_cost !== null,
          input_above_200k: p.input_cost_per_token_above_200k_tokens,
          output_above_200k: p.output_cost_per_token_above_200k_tokens,
          cache_create_above_200k: p.cache_creation_input_token_cost_above_200k_tokens,
          cache_read_above_200k: p.cache_read_input_token_cost_above_200k_tokens,
          fast_multiplier: p.provider_specific_entry?.fast ?? fast.multiplierFor(model) ?? 1,
        }),
      );
      loaded++;
    }
    this.findCache.clear();
    return loaded;
  }

  // load_models_dev_json_missing 的扁平快照分支（嵌入快照自带 exactOnly 结论）。
  loadModelsDevJson(text) {
    const raw = parseSerdeJson(text);
    if (!(raw instanceof Map)) throw new Error('models.dev 快照必须是对象');
    const models = new Map();
    for (const [key, value] of raw) {
      const model = tryDecode(decodeModelsDevModel, value);
      if (!model) throw new Error(`models.dev 快照条目 ${key} 结构无效`);
      models.set(key, model);
    }
    return this.loadModelsDevModels(models, '', TRUST_OWNER, false, fastOverrides(), new Map());
  }

  loadModelsDevModels(models, providerId, trust, deriveExactOnly, fast, claims) {
    const rules = catalogRules();
    let loaded = 0;
    const sources = [...models].sort(([a], [b]) => compareUtf8(a, b));
    for (const [sourceKey, model] of sources) {
      const cost = usableCost(rules, sourceKey, model);
      if (!cost) continue;
      const declaredId = model.id ? model.id : null;
      const exactOnly =
        model.exactOnly ??
        (deriveExactOnly && rules.isExactOnly(sourceKey, declaredId ?? sourceKey));
      const modelId = declaredId ?? sourceKey;
      const normalizedId = normalizedModelsDevModelId(modelId);
      const claimed = claims.get(normalizedId) ?? null;
      if (!claimed && this.entries.has(modelId)) continue;
      const contextLimit = model.limit?.context ?? null;
      const longContext = longContextTier(cost);
      const claim = {
        trust,
        hasLongContextTier: longContext !== null,
        hasCacheRead: cost.cache_read !== null,
        hasCacheWrite: cost.cache_write !== null,
        hasContextLimit: contextLimit !== null,
      };
      if (claimed) {
        const order = compareClaims(claimed.claim, claim);
        const replacesEqual =
          order === 0 &&
          claimed.providerId === providerId &&
          compareUtf8(sourceKey, claimed.sourceKey) < 0;
        if (order > 0 || (order === 0 && !replacesEqual)) continue;
        if (claimed.storedId !== modelId) {
          this.entries.delete(claimed.storedId);
          this.exactOnly.remove(claimed.storedId);
        }
      }
      const input = cost.input / 1_000_000,
        output = cost.output / 1_000_000;
      this.entries.set(
        modelId,
        pricing({
          input,
          output,
          cache_create: cost.cache_write !== null ? cost.cache_write / 1_000_000 : input * 1.25,
          cache_read: cost.cache_read !== null ? cost.cache_read / 1_000_000 : input * 0.1,
          cache_read_explicit: cost.cache_read !== null,
          cache_create_explicit: cost.cache_write !== null,
          input_above_200k: longContext?.input ?? null,
          output_above_200k: longContext?.output ?? null,
          cache_create_above_200k: longContext?.cache_create ?? null,
          cache_read_above_200k: longContext?.cache_read ?? null,
          long_context_threshold: longContext?.threshold ?? null,
          fast_multiplier: fast.multiplierFor(modelId) ?? 1,
        }),
      );
      if (exactOnly) this.exactOnly.insert(modelId);
      else this.exactOnly.remove(modelId);
      const isNew = !claims.has(normalizedId);
      claims.set(normalizedId, { claim, storedId: modelId, providerId, sourceKey });
      if (isNew) loaded++;
    }
    this.findCache.clear();
    return loaded;
  }

  find(model) {
    if (this.findCache.has(model)) return this.findCache.get(model);
    const resolved = resolveModelName(model, this.aliases);
    const fuzzy = this.allowsFuzzyLookup(model, resolved);
    const result =
      this.findEntryOrAlias(model, fuzzy) ??
      (resolved !== model ? this.findEntryOrAlias(resolved, true) : null) ??
      (this.embeddedModelsDev ? this.embeddedModelsDev.findEntryOrAlias(resolved, true) : null);
    this.findCache.set(model, result);
    return result;
  }

  // find_at：DeepSeek V4 两个直连模型（含解析到它们的别名）按事件时间套用价格表。
  findAt(model, timestampMs) {
    const resolved = resolveModelName(model, this.aliases);
    const scheduled = deepseekV4ModelIdentity(model) ?? deepseekV4ModelIdentity(resolved);
    if (!scheduled) return this.find(model);
    const base = this.find(model);
    return base ? applyDeepseekV4Schedule(scheduled, timestampMs, base) : null;
  }

  findExact(model) {
    return this.entries.get(model) ?? null;
  }

  findEntryOrAlias(model, fuzzy) {
    const direct = this.entries.get(model);
    if (direct) return direct;
    const alias = pricingAlias(model);
    return (alias ? this.findEntry(alias, fuzzy) : null) ?? this.findEntry(model, fuzzy);
  }

  findEntry(model, fuzzy) {
    const direct = this.entries.get(model);
    if (direct) return direct;
    const spelled = this.exactOnly.idSpelledBy(model);
    if (spelled !== null) return this.entries.get(spelled) ?? null;
    if (!fuzzy || this.isExactOnlyLookup(model)) return null;
    const normalizedModel = normalizedPricingKey(model);
    // max_by(len，再按字典序倒序)：最长的键胜出，等长时取字典序最小的。
    let best = null,
      bestLength = -1;
    for (const [candidate, value] of this.entries) {
      if (this.exactOnly.contains(candidate)) continue;
      if (!pricingKeyMatches(candidate, model, normalizedModel)) continue;
      const length = utf8Length(candidate);
      if (
        best === null ||
        length > bestLength ||
        (length === bestLength && compareUtf8(candidate, best[0]) <= 0)
      ) {
        best = [candidate, value];
        bestLength = length;
      }
    }
    return best ? best[1] : null;
  }

  isExactOnlyLookup(model) {
    return (
      this.exactOnly.containsAnySpelling(model) ||
      (this.embeddedModelsDev !== null &&
        this.embeddedModelsDev.exactOnly.containsAnySpelling(model))
    );
  }

  allowsFuzzyLookup(model, resolved) {
    return !(resolved !== model && this.isExactOnlyLookup(resolved));
  }

  // 上游数据只有平价时，从 models.dev 嵌入快照补长上下文档（只认精确 id）。
  fillLongContextRatesFromModelsDev() {
    const tiers = this.embeddedModelsDev ?? embeddedModelsDevPricing();
    for (const [model, p] of this.entries) {
      if (
        p.input_above_200k !== null ||
        p.output_above_200k !== null ||
        p.cache_create_above_200k !== null ||
        p.cache_read_above_200k !== null
      )
        continue;
      const base = modelWithoutDateSuffix(model);
      const resolved = pricingAlias(base) ?? base;
      const source = tiers.entries.get(resolved) ?? tiers.entries.get(base);
      if (!source || source.long_context_threshold === null) continue;
      this.entries.set(model, {
        ...p,
        input_above_200k: source.input_above_200k,
        output_above_200k: source.output_above_200k,
        cache_create_above_200k: source.cache_create_above_200k,
        cache_read_above_200k: source.cache_read_above_200k,
        long_context_threshold: source.long_context_threshold,
      });
    }
    this.findCache.clear();
  }

  putBuiltinEntry(model, value) {
    if (!this.entries.has(model)) this.entries.set(model, value);
  }

  // GLM 不收缓存写入、缓存读取另有价：只在快照没写明时补缓存字段，基础价以快照为准。
  putBuiltinGlm(model, value) {
    const existing = this.entries.get(model);
    if (!existing) {
      this.entries.set(model, value);
      return;
    }
    const next = { ...existing };
    if (!next.cache_read_explicit) {
      next.cache_read = value.cache_read;
      next.cache_read_explicit = true;
    }
    if (!next.cache_create_explicit) {
      next.cache_create = value.cache_create;
      next.cache_create_explicit = true;
    }
    this.entries.set(model, next);
  }

  // 只在快照缺这些键时兜底的内置价格，顺序与上游 put_builtin_pricing 相同。
  putBuiltinPricing(fast) {
    const explicit = { cache_read_explicit: true, cache_create_explicit: true };
    const mult = (model) => fast.multiplierFor(model) ?? 1;
    const opus45 = { input: 5e-6, output: 25e-6, cache_create: 6.25e-6, cache_read: 0.5e-6 };
    this.putBuiltinEntry('claude-opus-4-5', pricing({ ...opus45, ...explicit }));
    for (const model of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8'])
      this.putBuiltinEntry(
        model,
        pricing({ ...opus45, ...explicit, fast_multiplier: mult(model) }),
      );
    this.putBuiltinEntry(
      'claude-haiku-4-5',
      pricing({
        input: 1e-6,
        output: 5e-6,
        cache_create: 1.25e-6,
        cache_read: 0.1e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'claude-opus-4',
      pricing({
        input: 15e-6,
        output: 75e-6,
        cache_create: 18.75e-6,
        cache_read: 1.5e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'claude-sonnet-4-6',
      pricing({
        input: 3e-6,
        output: 15e-6,
        cache_create: 3.75e-6,
        cache_read: 0.3e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'claude-sonnet-4',
      pricing({
        input: 3e-6,
        output: 15e-6,
        cache_create: 3.75e-6,
        cache_read: 0.3e-6,
        ...explicit,
        input_above_200k: 6e-6,
        output_above_200k: 22.5e-6,
        cache_create_above_200k: 7.5e-6,
        cache_read_above_200k: 0.6e-6,
      }),
    );
    const haiku35 = pricing({
      input: 0.8e-6,
      output: 4e-6,
      cache_create: 1.0e-6,
      cache_read: 0.08e-6,
      ...explicit,
    });
    this.putBuiltinEntry('claude-3-5-haiku', haiku35);
    this.putBuiltinEntry('claude-3-5-haiku-20241022', haiku35);
    this.putBuiltinEntry(
      'claude-3-opus',
      pricing({
        input: 15e-6,
        output: 75e-6,
        cache_create: 18.75e-6,
        cache_read: 1.5e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'claude-3-sonnet',
      pricing({
        input: 3e-6,
        output: 15e-6,
        cache_create: 3.75e-6,
        cache_read: 0.3e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'claude-3-haiku',
      pricing({
        input: 0.25e-6,
        output: 1.25e-6,
        cache_create: 0.3e-6,
        cache_read: 0.03e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'gpt-5',
      pricing({
        input: 1.25e-6,
        output: 10e-6,
        cache_create: 1.25e-6,
        cache_read: 0.125e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'gpt-5.5',
      pricing({
        input: 5e-6,
        output: 30e-6,
        cache_create: 5e-6,
        cache_read: 0.5e-6,
        ...explicit,
        fast_multiplier: mult('gpt-5.5'),
      }),
    );
    this.putBuiltinEntry(
      'grok-4.3',
      pricing({ input: 1.25e-6, output: 2.5e-6, cache_create: 1.25e-6, cache_read: 0.125e-6 }),
    );
    this.putBuiltinEntry(
      'moonshot/kimi-k2.5',
      pricing({
        input: 0.6e-6,
        output: 3e-6,
        cache_create: 0.75e-6,
        cache_read: 0.1e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'moonshot/kimi-k2.6',
      pricing({
        input: 0.95e-6,
        output: 4e-6,
        cache_create: 1.1875e-6,
        cache_read: 0.16e-6,
        ...explicit,
      }),
    );
    const gpt51 = pricing({
      input: 1.25e-6,
      output: 10e-6,
      cache_create: 1.25e-6,
      cache_read: 0.125e-6,
      ...explicit,
    });
    this.putBuiltinEntry('gpt-5.1', gpt51);
    this.entries.set('gpt-5.1-codex', gpt51);
    const gpt5Codex = pricing({
      input: 1.75e-6,
      output: 14e-6,
      cache_create: 1.75e-6,
      cache_read: 0.175e-6,
      ...explicit,
    });
    this.entries.set('gpt-5.2-codex', gpt5Codex);
    this.putBuiltinEntry('gpt-5.3-codex', { ...gpt5Codex, fast_multiplier: mult('gpt-5.3-codex') });
    this.entries.set('gpt-5.2', gpt5Codex);
    this.putBuiltinEntry(
      'gpt-5.4',
      pricing({
        input: 2.5e-6,
        output: 15e-6,
        cache_create: 2.5e-6,
        cache_read: 0.25e-6,
        ...explicit,
        fast_multiplier: mult('gpt-5.4'),
      }),
    );
    this.putBuiltinEntry(
      'gpt-5.4-mini',
      pricing({
        input: 0.75e-6,
        output: 4.5e-6,
        cache_create: 0.75e-6,
        cache_read: 0.075e-6,
        ...explicit,
      }),
    );
    this.putBuiltinEntry(
      'gpt-5.4-nano',
      pricing({
        input: 0.2e-6,
        output: 1.25e-6,
        cache_create: 0.2e-6,
        cache_read: 0.02e-6,
        ...explicit,
      }),
    );
    for (const [model, input, output, cacheCreate, cacheRead] of [
      ['gpt-5.6-sol', 5e-6, 30e-6, 6.25e-6, 0.5e-6],
      ['gpt-5.6-terra', 2.5e-6, 15e-6, 3.125e-6, 0.25e-6],
      ['gpt-5.6-luna', 1e-6, 6e-6, 1.25e-6, 0.1e-6],
    ])
      this.putBuiltinEntry(
        model,
        pricing({
          input,
          output,
          cache_create: cacheCreate,
          cache_read: cacheRead,
          ...explicit,
          fast_multiplier: mult(model),
        }),
      );
    const glm = (input, output, cacheRead) =>
      pricing({ input, output, cache_create: 0, cache_read: cacheRead, ...explicit });
    const glmBase = glm(0.6e-6, 2.2e-6, 0.11e-6);
    this.putBuiltinGlm('glm-4.5', glmBase);
    this.putBuiltinGlm('zai/glm-4.5', glmBase);
    this.putBuiltinGlm('zai/glm-4.5-x', glm(2.2e-6, 8.9e-6, 0.45e-6));
    this.putBuiltinGlm('zai/glm-4.5-air', glm(0.2e-6, 1.1e-6, 0.03e-6));
    this.putBuiltinGlm('zai/glm-4.5-airx', glm(1.1e-6, 4.5e-6, 0.22e-6));
    this.putBuiltinGlm('zai/glm-4.5v', glm(0.6e-6, 1.8e-6, 0.11e-6));
    this.putBuiltinGlm('zai/glm-4-32b-0414-128k', glm(0.1e-6, 0.1e-6, 0.0));
    this.putBuiltinGlm('zai/glm-4.5-flash', glm(0.0, 0.0, 0.0));
    this.putBuiltinGlm('glm-4.6', glmBase);
    this.putBuiltinGlm('glm-4.7', glmBase);
    this.putBuiltinEntry('glm-5', {
      ...glmBase,
      input: 1.0e-6,
      output: 3.2e-6,
      cache_read: 0.2e-6,
    });
    this.putBuiltinEntry('glm-5-turbo', {
      ...glmBase,
      input: 1.2e-6,
      output: 4.0e-6,
      cache_read: 0.24e-6,
    });
    this.putBuiltinEntry('glm-5.1', {
      ...glmBase,
      input: 1.4e-6,
      output: 4.4e-6,
      cache_read: 0.26e-6,
    });
  }
}

let rulesCache, fastCache, embeddedCache;
function catalogRules() {
  return (rulesCache ??= new CatalogRules(parseSerdeJson(snapshotText('catalogRules'))));
}
function fastOverrides() {
  return (fastCache ??= new FastMultiplierOverrides(
    parseSerdeJson(snapshotText('fastMultipliers')),
  ));
}
// embedded_models_dev_pricing：独立的一张表，只在主表查不到时回退，不参与主表的模糊匹配。
export function embeddedModelsDevPricing() {
  if (!embeddedCache) {
    embeddedCache = new PricingMap();
    embeddedCache.loadModelsDevJson(snapshotText('modelsDev'));
  }
  return embeddedCache;
}

// long_context_split_threshold：Codex 按请求判定长上下文档的门槛（models.dev 精确 id，否则 200K）。
export function longContextSplitThreshold(model) {
  const tiers = embeddedModelsDevPricing();
  const base = modelWithoutDateSuffix(model);
  const resolved = pricingAlias(base) ?? base;
  const source = tiers.entries.get(resolved) ?? tiers.entries.get(base);
  return source?.long_context_threshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD_TOKENS;
}
