// 与 Rust 字符串语义对齐的小工具：字节序比较、str::lines、split_whitespace、模型名缩写、Agent 显示名。

/** 按 UTF-8 字节序（等价于码位序）比较，对应 Rust String / &str 的 Ord。 */
export function compareBytes(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // UTF-16 里代理对（≥ U+10000）排在 U+E000..U+FFFF 之前，UTF-8 字节序相反，需要调换。
    if (x >= 0xd800 && y >= 0xd800) {
      x = x <= 0xdfff ? x + 0x2000 : x - 0x800;
      y = y <= 0xdfff ? y + 0x2000 : y - 0x800;
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** 字节序排序并去重（BTreeSet<String> 的迭代结果）。 */
export const sortedUnique = (values) => [...new Set(values)].sort(compareBytes);

/** Rust str::lines：按 \n 切分，去掉行尾 \r（仅限 \r\n），末尾空行不产出，空串无行。 */
export function rustLines(value) {
  const lines = [];
  let start = 0;
  while (start < value.length) {
    const end = value.indexOf('\n', start);
    if (end < 0) {
      lines.push(value.slice(start));
      break;
    }
    const line = value.slice(start, end);
    lines.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    start = end + 1;
  }
  return lines;
}

/** Rust str::split_whitespace（Unicode White_Space，丢弃空片段）。 */
export const splitWhitespace = (value) => value.split(/\p{White_Space}+/u).filter(Boolean);

/** UTF-8 字节长度（Rust str::len）。 */
export const utf8Length = (value) => Buffer.byteLength(value, 'utf8');

/** short_model_name：去掉 claude- / anthropic/claude- 前缀与 8 字节日期后缀。 */
export function shortModelName(model) {
  const name = model.startsWith('anthropic/claude-')
    ? model.slice('anthropic/claude-'.length)
    : model.startsWith('claude-')
      ? model.slice('claude-'.length)
      : model;
  const parts = name.split('-');
  if (parts.length >= 3 && utf8Length(parts.at(-1)) === 8) return parts.slice(0, -1).join('-');
  return name;
}

/** format_models_multiline：缩写、字节序排序、相邻去重，每行 "- 模型"。 */
export function formatModelsMultiline(models) {
  const names = models.map(shortModelName).sort(compareBytes);
  return names
    .filter((name, i) => i === 0 || name !== names[i - 1])
    .map((name) => `- ${name}`)
    .join('\n');
}

/** format_breakdown_model_label */
export const formatBreakdownModelLabel = (model) => `  └─ ${shortModelName(model)}`;

const AGENT_LABELS = {
  all: 'All',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  amp: 'Amp',
  droid: 'Droid',
  codebuff: 'Codebuff',
  hermes: 'Hermes',
  pi: 'pi-agent',
  goose: 'Goose',
  openclaw: 'OpenClaw',
  kilo: 'Kilo',
  copilot: 'GitHub Copilot CLI',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  qwen: 'Qwen',
  grok: 'Grok',
  zcode: 'ZCode',
  // 上游 20.0.21 没有 dsh；沿用社区 DSH 适配器（oksure/ccusage 分支）的显示名。
  dsh: 'DeepSeek Harness',
};

/** agent_label：已知 Agent 的显示名，未知的原样返回。 */
export const agentLabel = (agent) =>
  Object.hasOwn(AGENT_LABELS, agent) ? AGENT_LABELS[agent] : agent;
