// 生成 src/pricing/snapshot.mjs：与 ccusage 20.0.21 二进制内嵌的价格快照逐字节相同。
//
// 快照不在这里重新实现，而是直接取 ccusage 自己 build.rs 的产物（raw deflate），保证
// LiteLLM 压缩规则、models.dev 最小化、浮点往返写法都与上游完全一致：
//
//   git clone --depth 1 --branch v20.0.21 https://github.com/ccusage/ccusage.git
//   curl -fLo litellm.json https://raw.githubusercontent.com/BerriAI/litellm/4b368bf0669cfd3268b780eea6c69497b9a51850/model_prices_and_context_window.json
//   cd ccusage/rust && CCUSAGE_PRICING_JSON_PATH=$PWD/../../litellm.json cargo check -p ccusage-core
//   node scripts/pricing-snapshot.mjs <target/debug/build/ccusage-core-*/out> <ccusage 仓库根>
//
// LiteLLM 的锁定版本取自 ccusage 20.0.21 的 flake.lock（Nix 发布构建用它设置
// CCUSAGE_PRICING_JSON_PATH）。数据许可：LiteLLM 价格表 MIT（BerriAI），models.dev 快照与
// 目录规则随 ccusage 源码分发（MIT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const [outDir, repo] = process.argv.slice(2);
if (!outDir || !repo)
  throw new Error('用法：node scripts/pricing-snapshot.mjs <build.rs OUT_DIR> <ccusage 仓库根>');
const LITELLM_REV = '4b368bf0669cfd3268b780eea6c69497b9a51850';
const CCUSAGE_COMMIT = '3c5556a775ebcf1e59844d4283c8c5b30529c290';
const lock = JSON.parse(readFileSync(join(repo, 'flake.lock'), 'utf8'));
if (lock.nodes.litellm.locked.rev !== LITELLM_REV)
  throw new Error(`ccusage flake.lock 锁定的 LiteLLM 不是 ${LITELLM_REV}`);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const deflated = {};
const summary = {};
for (const [name, file] of [
  ['litellm', 'litellm-pricing.json.deflate'],
  ['modelsDev', 'models-dev-pricing.json.deflate'],
  ['catalogRules', 'models-dev-catalog-rules.json.deflate'],
]) {
  const bytes = readFileSync(join(outDir, file));
  const text = inflateRawSync(bytes);
  JSON.parse(text.toString('utf8'));
  deflated[name] = bytes.toString('base64');
  summary[name] = { deflated: bytes.length, inflated: text.length, sha256: sha(text) };
}
const fast = readFileSync(
  join(repo, 'rust/crates/ccusage-core/src/fast-multiplier-overrides.json'),
  'utf8',
);
summary.fastMultipliers = { inflated: Buffer.byteLength(fast), sha256: sha(Buffer.from(fast)) };

const source = `// 生成文件，勿手改：node scripts/pricing-snapshot.mjs（见该脚本说明）。
// ccusage ${CCUSAGE_COMMIT}（v20.0.21）build.rs 产出的内嵌价格快照，LiteLLM ${LITELLM_REV}。
// litellm / modelsDev / catalogRules 为 raw deflate 的 base64；fastMultipliers 为原文。
import { inflateRawSync } from 'node:zlib';

const DEFLATED = ${JSON.stringify(deflated, null, 2)};
const FAST_MULTIPLIERS = ${JSON.stringify(fast)};
export const SNAPSHOT = ${JSON.stringify(summary, null, 2)};

const cache = new Map();
/** 取一份快照的 JSON 文本（首次使用时解压）。 */
export function snapshotText(name) {
  if (name === 'fastMultipliers') return FAST_MULTIPLIERS;
  if (!cache.has(name)) {
    if (!Object.hasOwn(DEFLATED, name)) throw new Error(\`未知价格快照 \${name}\`);
    cache.set(name, inflateRawSync(Buffer.from(DEFLATED[name], 'base64')).toString('utf8'));
  }
  return cache.get(name);
}
`;
writeFileSync(new URL('../src/pricing/snapshot.mjs', import.meta.url), source);
console.log(JSON.stringify(summary, null, 2));
