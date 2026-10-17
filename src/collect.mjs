import { realpath, stat } from 'node:fs/promises';
import { join, basename, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { exists, walk } from './io.mjs';
import { VERSION, AGENTS } from './shared.mjs';
import { COMPAT, BASE_AGENTS, aliases } from './compat.mjs';
import { aggregate } from './aggregate.mjs';
import { claude } from './adapters/claude.mjs';
import { codex } from './adapters/codex.mjs';
import { zcode } from './adapters/zcode.mjs';
import { claude as extendedClaude } from './adapters/claude-extended.mjs';
import { codex as extendedCodex } from './adapters/codex-extended.mjs';
import { zcode as extendedZcode } from './adapters/zcode-extended.mjs';
import { deepseek } from './adapters/deepseek-extended.mjs';
const list = (raw) =>
  raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
// 接受 YYYY-MM-DD 或 YYYYMMDD，统一成 YYYY-MM-DD；与 ccusage 的 --since / --until 写法一致。
function dateOption(name, value) {
  if (value === undefined || value === null) return undefined;
  const raw = value;
  if (typeof value === 'string' && /^\d{8}$/.test(value))
    value = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw Error(`${name} 无效日期 ${raw}，应为 YYYY-MM-DD 或 YYYYMMDD`);
  return value;
}
export async function collect(options = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16)) throw Error('usagelet 需要 Node.js >= 22.16');
  const mode = options.mode ?? 'ccusage';
  if (!['ccusage', 'extended'].includes(mode)) throw Error('mode 必须为 ccusage 或 extended');
  const env = options.env ?? process.env,
    home = options.home ?? homedir();
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = dateOption('since', options.since),
    until = dateOption('until', options.until);
  if (since && until && since > until) throw Error('since 不能晚于 until');
  const ctx = {
    compat: mode === 'ccusage',
    issues: new Map(),
    noCompressed: mode === 'ccusage' || !!options.noCompressed,
    aliases: aliases(env.CCUSAGE_MODEL_ALIASES),
  };
  const selected = options.agents ?? (mode === 'ccusage' ? BASE_AGENTS : AGENTS);
  for (const a of selected)
    if (!AGENTS.includes(a)) throw Error(a === 'qoder' ? 'Qoder 已暂缓接入' : `未知来源 ${a}`);
  const claudeRoots = env.CLAUDE_CONFIG_DIR
    ? list(env.CLAUDE_CONFIG_DIR).map((p) => (basename(p) === 'projects' ? p : join(p, 'projects')))
    : [
        join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'claude/projects'),
        join(home, '.claude/projects'),
      ];
  const codexRoots = [];
  for (const base of env.CODEX_HOME ? list(env.CODEX_HOME) : [join(home, '.codex')]) {
    const dirs = [];
    for (const name of ['sessions', 'archived_sessions'])
      if (await exists(join(base, name))) dirs.push(join(base, name));
    codexRoots.push(...(dirs.length ? dirs : [base]));
  }
  const defaults = {
    claude: claudeRoots,
    codex: codexRoots,
    zcode: (env.ZCODE_HOME ? list(env.ZCODE_HOME) : [join(home, '.zcode')]).map((p) =>
      join(p, 'cli/db/db.sqlite'),
    ),
    deepseek: [join(env.DSH_HOME ?? join(home, '.dsh'), 'sessions')],
  };
  const sources = [],
    rows = [];
  for (const agent of selected) {
    const explicit = options.sources?.[agent],
      paths = explicit ?? defaults[agent],
      found = [],
      files = [],
      seenFiles = new Set(),
      relativeKeys = new Set();
    for (const path of paths) {
      if (!(await exists(path))) {
        if (explicit) throw Error(`指定的 ${agent} 数据源不存在：${path}`);
        continue;
      }
      // 上游只接受文件形式的 ZCode 数据库；默认位置不是文件时同样视为未找到。
      if (agent === 'zcode' && !(await stat(path)).isFile()) {
        if (explicit)
          throw Error(
            `指定的 zcode 数据源不是文件：${path}；--source zcode= 需要指向 SQLite 数据库文件，通常是 ~/.zcode/cli/db/db.sqlite`,
          );
        continue;
      }
      found.push(await realpath(path));
    }
    for (const path of [...new Set(found)]) {
      const entries =
        agent === 'zcode'
          ? [path]
          : await walk(
              path,
              agent === 'deepseek' ? { ...ctx, noCompressed: !!options.noCompressed } : ctx,
            );
      for (const file of entries) {
        if (seenFiles.has(file)) continue;
        if (agent === 'codex' && mode === 'ccusage') {
          const key = JSON.stringify([
            ['sessions', 'archived_sessions'].includes(basename(path)) ? dirname(path) : path,
            relative(path, file),
          ]);
          if (relativeKeys.has(key)) continue;
          relativeKeys.add(key);
        }
        seenFiles.add(file);
        files.push(file);
      }
    }
    const adapters =
      mode === 'ccusage'
        ? { claude, codex, zcode, deepseek }
        : { claude: extendedClaude, codex: extendedCodex, zcode: extendedZcode, deepseek };
    const data = files.length ? await adapters[agent](files, ctx) : [];
    for (const row of data) rows.push(row);
    sources.push({
      agent,
      status: !found.length ? 'not_found' : data.length ? 'ok' : 'no_usage',
      files: files.length,
      records: data.length,
    });
  }
  const warnings = [...ctx.issues.values()],
    data = aggregate(rows, { ...options, timezone, since, until });
  return {
    metadata: {
      tool: 'usagelet',
      version: VERSION,
      mode,
      // 契约只覆盖 Claude Code、Codex、ZCode；选了 DeepSeek 等契约外来源时不再标注对齐。
      compatibility:
        mode === 'ccusage' && selected.every((a) => BASE_AGENTS.includes(a)) ? COMPAT : null,
      timezone,
      complete: !warnings.length && !data.totals.missingFields.length,
      compressedLogs: mode === 'extended' && !options.noCompressed,
      sources,
      warnings,
    },
    ...data,
  };
}
