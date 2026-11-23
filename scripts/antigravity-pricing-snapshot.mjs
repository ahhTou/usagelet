// 复制 ccusage 4f1df4ed build.rs 的原始定价表（MIT）。
// 用法：node scripts/antigravity-pricing-snapshot.mjs <ccusage-pricing-snapshots 的 OUT_DIR>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir] = process.argv.slice(2);
if (!outDir) throw Error('请指定 ccusage-pricing-snapshots 的 OUT_DIR');
const tables = ['pricing-table.bin', 'models-dev-table.bin'].map((file) =>
  readFileSync(join(outDir, file)).toString('base64'),
);
writeFileSync(
  new URL('../src/adapters/antigravity/pricing-snapshot.mjs', import.meta.url),
  '// 生成文件，来自 ccusage 4f1df4ed。见 scripts/antigravity-pricing-snapshot.mjs。\n' +
    `export const [primary, secondary] = ${JSON.stringify(tables, null, 2)};\n`,
);
