// 移植自 ccusage 4f1df4ed 的 Antigravity parser/model.rs（MIT）。
export const DEFAULT_MODEL = 'gemini-internal-model';
const PLACEHOLDER = 'model_placeholder_m';
const UNRESOLVED = 'antigravity-model-';

const namesById = new Map([
  [246n, 'gemini-2.5-pro'],
  [312n, 'gemini-2.5-flash'],
  [313n, 'gemini-2.5-flash-thinking'],
  [329n, 'gemini-2.5-flash-thinking'],
  [330n, 'gemini-2.5-flash-lite'],
  [281n, 'claude-sonnet-4'],
  [282n, 'claude-sonnet-4'],
  [290n, 'claude-opus-4'],
  [291n, 'claude-opus-4'],
  [333n, 'claude-4.5-sonnet'],
  [334n, 'claude-4.5-sonnet'],
  [340n, 'claude-4.5-haiku'],
  [341n, 'claude-4.5-haiku'],
  [342n, 'model_openai_gpt_oss_120b_medium'],
]);

const names = new Map([
  ['gemini 3.8 flash', 'gemini-3.8-flash'],
  ['gemini 3.8 flash thinking', 'gemini-3.8-flash'],
  ['gemini 3.7 flash', 'gemini-3.7-flash'],
  ['gemini 3.7 flash thinking', 'gemini-3.7-flash'],
  ['gemini 3.7 pro', 'gemini-3.7-pro'],
  ['gemini 3.7 pro thinking', 'gemini-3.7-pro'],
  ['gemini 3.6 flash', 'gemini-3.6-flash'],
  ['gemini 3 flash', 'gemini-3.6-flash'],
  ['gemini 3.6 pro', 'gemini-3.6-pro'],
  ['gemini 3 pro', 'gemini-3-pro'],
  ['gemini 3 pro thinking', 'gemini-3-pro'],
  ['gemini 2 flash', 'gemini-2.0-flash'],
  ['model_openai_gpt_oss_120b_medium', 'gpt-oss-120b-medium'],
  ['gemini-pro-default', 'gemini-3.1-pro'],
  ['gemini-pro-agent', 'gemini-3.1-pro'],
  ['gemini-3-flash-agent', 'gemini-3.5-flash-high'],
  ['gemini-3-flash-agent-a', 'gemini-3.5-flash-high'],
  ['gemini-3-flash-agent-b', 'gemini-3.5-flash-high'],
  ['gemini-3-flash-a', 'gemini-3.5-flash-high'],
  ['gemini-3-flash-b', 'gemini-3.5-flash-high'],
  ['gemini-3-flash-c', 'gemini-3-flash-preview'],
  ['gemini-3-flash', 'gemini-3-flash-preview'],
  ['gemini-3.5-flash-low', 'gemini-3.5-flash-medium'],
  ['gemini-3.1-pro-high', 'gemini-3.1-pro'],
  ['gemini-3.1-pro-low', 'gemini-3.1-pro'],
  ['gemini-3-pro-high', 'gemini-3-pro'],
  ['gemini-3-pro-low', 'gemini-3-pro'],
  ['claude 3.7 sonnet', 'claude-3-7-sonnet'],
  ['claude 3.7 sonnet thinking', 'claude-3-7-sonnet'],
  ['claude 3.5 sonnet', 'claude-3-5-sonnet'],
  ['claude 3.5 haiku', 'claude-3-5-haiku'],
  ['claude 3 opus', 'claude-3-opus'],
]);

const placeholders = new Map([
  [318, 'gemini-3.8-flash-high'],
  [319, 'gemini-3.8-flash-medium'],
  [320, 'gemini-3.8-flash-low'],
  [298, 'gemini-3.7-flash-high'],
  [299, 'gemini-3.7-flash-medium'],
  [300, 'gemini-3.7-flash-low'],
  [71, 'gemini-3.6-flash-high'],
  [72, 'gemini-3.6-flash-medium'],
  [73, 'gemini-3.6-flash-low'],
  [417, 'gemini-4-argon'],
  [418, 'gemini-4-argon'],
  [419, 'gemini-4-argon'],
  [402, 'claude-opus-5-5'],
  [50, 'gemini-3.1-flash-lite'],
  [26, 'claude-opus-4-6'],
  [35, 'claude-sonnet-4-6'],
  [36, 'gemini-3.1-pro'],
  [37, 'gemini-3.1-pro'],
  [16, 'gemini-3.1-pro'],
  [18, 'gemini-3-flash-preview'],
  [84, 'gemini-3-flash-preview'],
  [47, 'gemini-3-flash-preview'],
  [132, 'gemini-3.5-flash-high'],
  [133, 'gemini-3.5-flash-high'],
  [187, 'gemini-3.5-flash-extra-low'],
  [20, 'gemini-3.5-flash-medium'],
]);
for (const [id, name] of placeholders) names.set(PLACEHOLDER + id, name);

export const flashPricingAlias = (model) =>
  model.match(/^(gemini-3\.[678]-flash)-(?:high|medium|low)$/)?.[1];

export function normalizeModel(raw) {
  if (!raw?.trim()) return;
  const trimmed = raw.trim();
  const lower = trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const effort = lower.match(/^([^-]+?) \(([^)]+)\)$/);
  if (effort) {
    const variant = effort[1].replaceAll(' ', '-') + '-' + effort[2];
    if (flashPricingAlias(variant)) return variant;
  }
  const base = lower.split('(', 1)[0].trim();
  const converted = base.replaceAll(' ', '-');
  return names.get(base) ?? (/^(gemini|claude|gpt)-/.test(converted) ? converted : trimmed);
}

export function modelFromId(id) {
  if (id === undefined) return;
  return normalizeModel(
    namesById.get(id) ?? (id >= 1000n ? PLACEHOLDER + (id - 1000n) : UNRESOLVED + id),
  );
}

export const rowModel = (metadata) => metadata.model ?? modelFromId(metadata.modelId);

export function modelResolution(model) {
  if (!model || model === DEFAULT_MODEL) return 0;
  return model.startsWith(PLACEHOLDER) || model.startsWith(UNRESOLVED) ? 1 : 2;
}
