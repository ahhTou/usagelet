// 定价与输出格式的单元测试：断言值取自 ccusage 20.0.21 的 Rust 单测（pricing.rs、cost.rs），
// 浮点与货币写法另用真实 serde_json 1.0.151 / Rust format! 的输出核对过。
// 上下文上限（context_limit）、联网刷新与配置覆盖未移植，相关断言省略。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PricingMap,
  longContextSplitThreshold,
  calculateCostForUsageAt,
  hasTimeDependentPricing,
  parseTsTimestamp,
  SNAPSHOT,
} from '../src/pricing.mjs';
import { modelWithoutDateSuffix } from '../src/pricing/keys.mjs';
import { formatF64, formatCurrency, jsonFloat } from '../src/report/float.mjs';
import { visibleWidth } from '../src/report/terminal.mjs';

const embedded = PricingMap.loadEmbedded();
const entry = (input, extra = {}) => ({
  input,
  output: 0,
  cache_create: 0,
  cache_read: 0,
  cache_read_explicit: true,
  cache_create_explicit: true,
  input_above_200k: null,
  output_above_200k: null,
  cache_create_above_200k: null,
  cache_read_above_200k: null,
  long_context_threshold: null,
  fast_multiplier: 1,
  ...extra,
});
const close = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('内嵌快照与 ccusage 20.0.21 build.rs 产物一致', () => {
  assert.equal(
    SNAPSHOT.litellm.sha256,
    '2d71a4ba4a139cad10099fbe27f41936f1f912e0da4c067e16f841bb9a296994',
  );
  assert.equal(
    SNAPSHOT.modelsDev.sha256,
    'dc18d362ef349b26f1ba9ad927be294e7635b30025aa7781622cb9632a60e545',
  );
  assert.ok(embedded.entries.size > 500);
});

test('模糊匹配要求键边界，不跨数字版本回退', () => {
  const map = new PricingMap();
  map.entries.set('claude-opus-4-7', entry(5e-6));
  map.entries.set('claude-opus-4', entry(15e-6));
  assert.equal(map.find('claude-opus-4.70'), null);
  const only = new PricingMap();
  only.entries.set('claude-opus-4', entry(15e-6));
  for (const model of [
    'claude-opus-4.8-20260528',
    'claude-opus-4-9',
    'claude-opus-5',
    'claude-opus-4.70',
  ])
    assert.equal(only.find(model), null, model);
  assert.ok(only.find('claude-opus-4-20250514'));
  assert.ok(embedded.find('claude-opus-4-8-20270898'));
});

test('模糊匹配取最长的键', () => {
  const map = new PricingMap();
  map.entries.set('claude-sonnet-4', entry(1));
  map.entries.set('claude-sonnet-4-20250514', entry(2));
  assert.equal(map.find('claude-sonnet-4-20250514-via-bedrock').input, 2);
});

test('只允许精确请求的档位优先于主表模糊匹配，分隔符拼写等价', () => {
  const base = embedded.find('claude-opus-5');
  close(base.input * 1e6, 5, 1e-9);
  const fast = embedded.find('claude-opus-5-fast');
  close(fast.input * 1e6, 12, 1e-9);
  close(fast.output * 1e6, 60, 1e-9);
  const eu = embedded.find('claude-opus-5@eu');
  assert.ok(eu.input > base.input);
  assert.ok(embedded.find('claude-opus-5-20260115'));
  const dashed = embedded.find('claude-opus-5-eu');
  close(dashed.input, eu.input);
  close(dashed.output, eu.output);
  assert.ok(embedded.find('claude-opus-5-eu-preview'));
});

test('日期后缀、长上下文门槛与别名', () => {
  assert.equal(modelWithoutDateSuffix('gpt-5.5-2026-04-23'), 'gpt-5.5');
  assert.equal(modelWithoutDateSuffix('gpt-5.5-pro-2026-04-23'), 'gpt-5.5-pro');
  assert.equal(modelWithoutDateSuffix('claude-3-5-haiku-20241022'), 'claude-3-5-haiku');
  assert.equal(modelWithoutDateSuffix('gpt-4-0613'), 'gpt-4-0613');
  for (const model of ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.5-2026-04-23'])
    assert.equal(longContextSplitThreshold(model), 272_000, model);
  for (const model of ['gpt-5', 'gpt-5.4-mini'])
    assert.equal(longContextSplitThreshold(model), 200_000);
  const reserve = embedded.find('gpt-reserve'),
    luna = embedded.find('gpt-5.6-luna');
  assert.deepEqual(
    [reserve.input, reserve.output, reserve.cache_read, reserve.fast_multiplier],
    [luna.input, luna.output, luna.cache_read, luna.fast_multiplier],
  );
  assert.equal(embedded.find('anthropic.claude-opus-4-6-v1').fast_multiplier, 6);
  assert.equal(embedded.find('anthropic.claude-opus-4-7').fast_multiplier, 6);
  assert.equal(embedded.find('anthropic.claude-opus-4-8').fast_multiplier, 2);
  const aliased = PricingMap.loadEmbedded({ aliases: { 'my-model': 'gpt-5.5' } });
  assert.equal(aliased.find('my-model').input, embedded.find('gpt-5.5').input);
});

test('LiteLLM 条目解码：无效条目跳过，紧凑字段不全时回退完整字段名', () => {
  const map = new PricingMap();
  assert.equal(
    map.loadJson(
      '{"sample_spec":{"max_input_tokens":"max input tokens"},"gpt-valid":{"input_cost_per_token":0.000001,"output_cost_per_token":0.000010,"max_input_tokens":123}}',
    ),
    1,
  );
  assert.ok(map.find('gpt-valid'));
  const full = new PricingMap();
  assert.equal(
    full.loadJson(
      '{"gpt-full-with-extra-i":{"i":"provider metadata","o":"provider metadata","input_cost_per_token":0.000001,"output_cost_per_token":0.000010}}',
    ),
    1,
  );
  assert.deepEqual(
    [full.find('gpt-full-with-extra-i').input, full.find('gpt-full-with-extra-i').output],
    [1e-6, 10e-6],
  );
});

test('DeepSeek V4 按生效期与 UTC 工作日高峰时段计价，带提供商前缀的不算', () => {
  const map = new PricingMap();
  map.loadJson(`{
    "deepseek-v4-flash": {"input_cost_per_token": 0.00000014, "output_cost_per_token": 0.00000028,
      "cache_creation_input_token_cost": 0.000000123, "cache_read_input_token_cost": 0.0000000028},
    "deepseek-v4-pro": {"input_cost_per_token": 0.000000435, "output_cost_per_token": 0.00000087,
      "cache_creation_input_token_cost": 0.000000456, "cache_read_input_token_cost": 0.000000003625}
  }`);
  for (const [time, flash, pro] of [
    ['2026-08-16T15:59:59Z', [0.14, 0.28, 0.0028], [0.435, 0.87, 0.003625]],
    ['2026-08-16T16:00:00Z', [0.22, 0.66, 0.007], [0.66, 1.98, 0.022]],
    ['2026-08-17T01:00:00Z', [0.44, 1.32, 0.014], [1.32, 3.96, 0.044]],
  ]) {
    const ts = parseTsTimestamp(time);
    const f = map.findAt('deepseek-v4-flash', ts),
      p = map.findAt('deepseek-v4-pro', ts);
    [f.input, f.output, f.cache_read].forEach((v, i) => close(v * 1e6, flash[i]));
    [p.input, p.output, p.cache_read].forEach((v, i) => close(v * 1e6, pro[i]));
  }
  for (const [time, input] of [
    ['2026-08-17T00:59:59Z', 0.22],
    ['2026-08-17T01:00:00Z', 0.44],
    ['2026-08-17T03:59:59Z', 0.44],
    ['2026-08-17T04:00:00Z', 0.22],
    ['2026-08-17T06:00:00Z', 0.44],
    ['2026-08-17T10:00:00Z', 0.22],
    ['2026-08-22T02:00:00Z', 0.22],
    ['2026-08-17T09:00:00+08:00', 0.44],
  ])
    close(map.findAt('deepseek-v4-flash', parseTsTimestamp(time)).input * 1e6, input);
  const aliases = { 'deepseek-latest': 'deepseek-v4-flash' };
  for (const model of [
    'deepseek-v4-flash',
    'deepseek.v4.flash',
    'deepseek@v4@flash',
    'deepseek-latest',
  ])
    assert.ok(hasTimeDependentPricing(model, aliases), model);
  for (const model of ['openrouter/deepseek-v4-flash', 'gpt-5'])
    assert.ok(!hasTimeDependentPricing(model, aliases), model);
});

test('费用公式：5m / 1h 缓存分开计价、两段式长上下文、费用模式', () => {
  const map = new PricingMap();
  map.loadJson(`{"test-model": {"input_cost_per_token": 1.0, "output_cost_per_token": 10.0,
    "cache_creation_input_token_cost": 1.25, "cache_read_input_token_cost": 0.1,
    "input_cost_per_token_above_200k_tokens": 2.0, "cache_creation_input_token_cost_above_200k_tokens": 1.5}}`);
  const usage = (u) => ({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...u,
  });
  const cost = (u, extra = {}) =>
    calculateCostForUsageAt({
      model: 'test-model',
      usage: usage(u),
      mode: 'calculate',
      pricing: map,
      ...extra,
    });
  close(
    cost({
      cache_creation_input_tokens: 999,
      cache_read_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    }),
    55.5,
    Number.EPSILON,
  );
  close(cost({ cache_creation_input_tokens: 10 }), 12.5, Number.EPSILON);
  assert.equal(cost({ input_tokens: 1 }, { costUSD: 9, mode: 'auto' }), 9);
  assert.equal(cost({ input_tokens: 1 }, { costUSD: 9, mode: 'display' }), 9);
  assert.equal(cost({ input_tokens: 1 }, { costUSD: undefined, mode: 'display' }), 0);
  const twoStage = new PricingMap();
  twoStage.loadModelsDevJson(
    '{"two-stage-test":{"cost":{"input":1,"output":10,"cache_read":0.1,"tiers":[{"input":2,"output":20,"cache_read":0.2,"tier":{"type":"context","size":100}}]}}}',
  );
  const run = (input) =>
    calculateCostForUsageAt({
      model: 'two-stage-test',
      usage: usage({ input_tokens: input, output_tokens: 3, cache_read_input_tokens: 40 }),
      mode: 'calculate',
      pricing: twoStage,
    });
  close(run(59), 93e-6);
  close(run(60), 94e-6);
  assert.ok(run(61) > 2 * 94e-6);
});

test('浮点、货币与宽度写法与 serde_json 1.0.151 / Rust 一致', () => {
  const cases = [
    [0, '0.0'],
    [-0, '-0.0'],
    [1, '1.0'],
    [0.1, '0.1'],
    [1e-5, '0.00001'],
    [1.2e-5, '0.000012'],
    [1e-6, '1e-6'],
    [2.8e-9, '2.8e-9'],
    [123456789012345, '123456789012345.0'],
    [1e15, '1000000000000000.0'],
    [1e16, '1e+16'],
    [1.234e17, '1.234e+17'],
  ];
  for (const [value, text] of cases) assert.equal(formatF64(value), text);
  assert.equal(jsonFloat(0), '0');
  assert.equal(jsonFloat(-0), '0');
  assert.equal(jsonFloat(1.312881), '1.312881');
  for (const [value, text] of [
    [0.125, '$0.12'],
    [0.135, '$0.14'],
    [1.005, '$1.00'],
    [2.675, '$2.67'],
    [1316.747708350002, '$1316.75'],
    [0.004999999, '$0.00'],
  ])
    assert.equal(formatCurrency(value), text);
  assert.equal(visibleWidth('DeepSeek Harness'), 16);
  assert.equal(visibleWidth('中文'), 4);
  assert.equal(visibleWidth('\x1b[33mTotal\x1b[0m'), 5);
});
