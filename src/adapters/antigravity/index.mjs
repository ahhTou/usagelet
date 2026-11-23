// Antigravity 会话发现及加载，参考 ccusage 4f1df4ed（MIT）。
import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { issue } from '../../shared.mjs';
import { compareBytes } from '../../report/text.mjs';
import { deduplicate } from './events.mjs';
import { readDatabase } from './sqlite.mjs';
import { antigravityCost } from './pricing.mjs';

const defaultRoots = [
  '.gemini/antigravity',
  '.gemini/antigravity-cli',
  '.gemini/antigravity-ide',
  '.gemini/antigravity-backup',
  '.gemini/antigravity-acp',
  '.config/antigravity',
];

export function antigravityRoots(raw, home) {
  const roots = raw
    ?.split(',')
    .map((path) => path.trim())
    .filter(Boolean);
  return roots?.length
    ? roots.map((path) => path.replace(/^~(?=$|\/)/, () => home))
    : defaultRoots.map((root) => join(home, root, 'conversations'));
}

export async function antigravityFiles(roots, ctx) {
  const files = new Map();
  const visited = new Set();
  const links = [];
  async function visit(path) {
    try {
      const info = await stat(path);
      if (!info.isDirectory() && !(info.isFile() && extname(path) === '.db')) return;
      const canonical = await realpath(path);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      if (info.isFile()) files.set(canonical, path);
      else {
        const entries = await readdir(path, { withFileTypes: true });
        entries.sort((a, b) => compareBytes(a.name, b.name));
        for (const entry of entries) {
          const child = join(path, entry.name);
          if (entry.isSymbolicLink()) links.push(child);
          else if (entry.isDirectory() || (entry.isFile() && extname(child) === '.db'))
            await visit(child);
        }
      }
    } catch {
      issue(ctx, 'unreadable', path, '无法读取 Antigravity 会话路径');
    }
  }
  for (const root of roots) {
    const nested = join(root, 'conversations');
    const directory = await stat(nested).catch(() => null);
    await visit(directory?.isDirectory() ? nested : root);
    for (const link of links) await visit(link);
    links.length = 0;
  }
  return [...files.values()].sort(compareBytes);
}

export async function antigravity(files, ctx) {
  const { DatabaseSync } = await import('node:sqlite').catch(() => {
    throw Error('读取 Antigravity 会话需要 Node.js >= 22.16 的内置 SQLite');
  });
  const events = [];
  for (const file of files) {
    try {
      for (const event of readDatabase(DatabaseSync, file, ctx)) events.push(event);
    } catch (error) {
      issue(ctx, 'invalid_database', file, `Antigravity 会话数据库跳过（${error.message}）`);
    }
  }
  const price = antigravityCost(ctx);
  return deduplicate(events).map((row) => ({
    ...row,
    extraTotalTokens: row.totalOutputTokens - row.outputTokens,
    ...price(row),
  }));
}
