import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const license = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
await build({
  entryPoints: [root + 'src/index.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.16',
  outfile: root + 'dist/usagelet.mjs',
  minify: false,
  legalComments: 'none',
  footer: { js: '/*\n' + license + '*/' },
});
const data = await readFile(root + 'dist/usagelet.mjs');
await writeFile(
  root + 'dist/usagelet.mjs.sha256',
  createHash('sha256').update(data).digest('hex') + '  usagelet.mjs\n',
);
console.log(`已构建 dist/usagelet.mjs（${data.length} 字节，无运行依赖）`);
