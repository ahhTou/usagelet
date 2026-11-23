// 移植自 ccusage 4f1df4ed 的 Antigravity parser.rs 与 loader.rs（MIT）。
import { issue, sum } from '../../shared.mjs';
import { DEFAULT_MODEL, modelFromId, modelResolution, normalizeModel, rowModel } from './model.mjs';
import { tokenFields } from './proto.mjs';

function appendEvent(events, knownTimes, usage, row, fallback, trajectoryTime, ctx, source) {
  if (!tokenFields.some((key) => usage[key] > 0)) return;
  const identities = usage.identities.length ? usage.identities : fallback;
  const time =
    row.timestamp === undefined
      ? ([...identities, ...fallback].map((id) => knownTimes.get(id)).find(Boolean) ??
        (trajectoryTime === undefined ? undefined : { timestamp: trajectoryTime, rank: 1 }))
      : { timestamp: row.timestamp, rank: 3 };
  if (!time) {
    issue(ctx, 'invalid_timestamp', source, 'Antigravity 用量缺少有效时间戳');
    return;
  }
  for (const id of identities) {
    if (preferTime(time, knownTimes.get(id))) knownTimes.set(id, time);
  }

  const totalOutputTokens = Math.max(
    usage.totalOutputTokens,
    sum([usage.outputTokens, usage.reasoningTokens]),
  );
  const outputTokens = Math.max(usage.outputTokens, totalOutputTokens - usage.reasoningTokens);
  const reasoningTokens = Math.max(usage.reasoningTokens, totalOutputTokens - outputTokens);
  const idModel = modelFromId(usage.modelId);
  const normalized = normalizeModel(row.model);
  const sameId = row.modelId === usage.modelId;
  const model =
    modelResolution(idModel) === 2
      ? idModel
      : sameId && modelResolution(normalized) === 2
        ? normalized
        : (idModel ?? normalized ?? DEFAULT_MODEL);
  const loggedModel =
    row.model !== model && (sameId || normalized === model) ? row.model : undefined;
  events.push({
    ...usage,
    ...time,
    model,
    loggedModel,
    provider: usage.provider ?? row.provider,
    identities,
    totalOutputTokens,
    outputTokens,
    reasoningTokens,
  });
}

function preferTime(candidate, existing) {
  return (
    !existing ||
    candidate.rank > existing.rank ||
    (candidate.rank === existing.rank && candidate.timestamp < existing.timestamp)
  );
}

export function databaseEvents(generations, steps, trajectoryTime, ctx, file) {
  const knownTimes = new Map();
  for (const row of [...steps, ...generations]) {
    if (row.timestamp === undefined) continue;
    const identities = [
      ...row.identities,
      ...(row.primary?.identities ?? []),
      ...row.retries.flatMap((usage) => usage.identities),
    ];
    const time = { timestamp: row.timestamp, rank: 3 };
    for (const id of identities) {
      if (preferTime(time, knownTimes.get(id))) knownTimes.set(id, time);
    }
  }
  const events = [];
  const generationModel = generations.map(rowModel).findLast((model) => model !== undefined);
  let currentModel;
  for (const [rows, table] of [
    [steps, 'steps'],
    [generations, 'gen_metadata'],
  ]) {
    const source = `${file}#${table}`;
    for (const metadata of rows) {
      let model;
      if (table === 'steps') model = rowModel(metadata) ?? generationModel;
      else {
        currentModel = rowModel(metadata) ?? modelFromId(metadata.primary?.modelId) ?? currentModel;
        model = currentModel;
      }
      const row = { ...metadata, model };
      if (row.primary)
        appendEvent(
          events,
          knownTimes,
          row.primary,
          row,
          row.identities,
          trajectoryTime,
          ctx,
          source,
        );
      for (const retry of row.retries)
        appendEvent(events, knownTimes, retry, row, [], trajectoryTime, ctx, source);
    }
  }
  return events;
}

function mergeUsage(target, duplicate) {
  for (const key of tokenFields) target[key] = Math.max(target[key], duplicate[key]);
  target.totalOutputTokens = Math.max(
    target.totalOutputTokens,
    sum([target.outputTokens, target.reasoningTokens]),
  );
  if (modelResolution(duplicate.model) > modelResolution(target.model)) {
    target.model = duplicate.model;
    target.loggedModel = duplicate.loggedModel;
  } else if (target.model === duplicate.model) target.loggedModel ??= duplicate.loggedModel;
  target.provider ??= duplicate.provider;
  if (preferTime(duplicate, target)) {
    target.timestamp = duplicate.timestamp;
    target.rank = duplicate.rank;
  }
  target.identities = [...new Set([...target.identities, ...duplicate.identities])];
}

export function deduplicate(events) {
  const slots = [];
  const indexes = new Map();
  for (const event of events) {
    const matches = [
      ...new Set(
        event.identities.map((id) => indexes.get(id)).filter((index) => index !== undefined),
      ),
    ].sort((a, b) => a - b);
    const index = matches[0] ?? slots.length;
    if (!matches.length) slots.push(event);
    else {
      for (const duplicate of matches.slice(1)) {
        mergeUsage(slots[index], slots[duplicate]);
        slots[duplicate] = null;
      }
      mergeUsage(slots[index], event);
    }
    for (const id of slots[index].identities) indexes.set(id, index);
  }
  return slots.filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
}
