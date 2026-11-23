// 移植自 ccusage 4f1df4ed 的 Antigravity parser/proto.rs（MIT）。
import { count } from '../../shared.mjs';

const I64_MAX = (1n << 63n) - 1n;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readVarint(blob, cursor) {
  let value = 0n;
  for (let shift = 0n; shift <= 63n; shift += 7n) {
    const byte = blob[cursor.offset++];
    if (byte === undefined) throw Error('Protobuf varint 不完整');
    const payload = byte & 127;
    if (shift === 63n && (payload > 1 || byte >= 128)) throw Error('Protobuf varint 溢出');
    value |= BigInt(payload) << shift;
    if (byte < 128) return value;
  }
}

function decode(blob) {
  if (!(blob instanceof Uint8Array)) throw Error('SQLite 元数据列必须为 BLOB');
  const cursor = { offset: 0 };
  const fields = new Map();
  while (cursor.offset < blob.length) {
    const tag = readVarint(blob, cursor);
    const number = Number(tag >> 3n);
    if (number === 0 || number > 0xffffffff) throw Error('Protobuf 字段编号无效');
    const wire = Number(tag & 7n);
    let value;
    if (wire === 0) value = readVarint(blob, cursor);
    else {
      const width = { 1: 8, 5: 4 }[wire];
      if (wire !== 2 && width === undefined) throw Error('Protobuf wire type 不受支持');
      const length = wire === 2 ? Number(readVarint(blob, cursor)) : width;
      const end = cursor.offset + length;
      if (end > blob.length) throw Error('Protobuf 字段不完整');
      if (wire === 2) value = blob.subarray(cursor.offset, end);
      cursor.offset = end;
    }
    if (value === undefined) continue;
    if (!fields.has(number)) fields.set(number, []);
    fields.get(number).push(value);
  }
  return fields;
}

const varint = (fields, id) => fields.get(id)?.findLast((x) => typeof x === 'bigint');
const blobs = (fields, id) => (fields.get(id) ?? []).filter((x) => x instanceof Uint8Array);
const first = (fields, id) => blobs(fields, id)[0];
const nested = (fields, id) => {
  const blob = first(fields, id);
  return blob === undefined ? new Map() : decode(blob);
};
const idOf = (fields, id) => varint(fields, id) || undefined;
const tokens = (fields, id) => count(Number(varint(fields, id) ?? 0n));

function text(fields, id) {
  const value = blobs(fields, id).at(-1);
  if (!value) return;
  try {
    const decoded = utf8.decode(value);
    if (decoded.trim()) return decoded;
  } catch {
    // 与上游一致，忽略无法作为 UTF-8 解码的标识。
  }
}

function timestamp(blob) {
  if (blob === undefined) return;
  const fields = decode(blob);
  const seconds = varint(fields, 1) ?? 0n;
  if (seconds <= 0n || seconds > I64_MAX) return;
  const nanos = varint(fields, 2) ?? 0n;
  const millis = Number(seconds * 1000n + (nanos > 999999999n ? 999n : nanos / 1000000n));
  return Number.isFinite(new Date(millis).getTime()) ? millis : undefined;
}

export const trajectoryTimestamp = (blob) => timestamp(first(decode(blob), 2));

const tokenIds = {
  inputTokens: 2,
  totalOutputTokens: 3,
  cacheCreationTokens: 4,
  cacheReadTokens: 5,
  reasoningTokens: 9,
  outputTokens: 10,
};
export const tokenFields = Object.keys(tokenIds);

function usage(blob) {
  if (blob === undefined) return;
  const fields = decode(blob);
  const identities = [];
  for (const [id, prefix] of [
    [11, 'response'],
    [12, 'provider'],
    [7, 'message'],
  ]) {
    const value = text(fields, id);
    if (value) identities.push(`${prefix}:${value}`);
  }
  return {
    modelId: idOf(fields, 1),
    provider: idOf(fields, 6),
    identities,
    ...Object.fromEntries(Object.entries(tokenIds).map(([key, id]) => [key, tokens(fields, id)])),
  };
}

function attempts(fields, primaryId, retryId) {
  const primary = usage(first(fields, primaryId));
  const retries = blobs(fields, retryId)
    .map((blob) => usage(first(decode(blob), 2)))
    .filter(Boolean);
  // retry_infos 会镜像主请求，只去掉一条镜像，保留实际重试。
  if (primary) {
    const mirror = retries.findIndex(
      (retry) =>
        retry.modelId === primary.modelId &&
        tokenFields.every((key) => retry[key] === primary[key]) &&
        retry.identities.every((id) => primary.identities.includes(id)),
    );
    if (mirror !== -1) retries.splice(mirror, 1);
  }
  return { primary, retries };
}

function stepIndices(fields) {
  const indices = [];
  for (const value of fields.get(2) ?? []) {
    if (typeof value === 'bigint') {
      if (value <= I64_MAX) indices.push(value);
      continue;
    }
    const cursor = { offset: 0 };
    while (cursor.offset < value.length) {
      try {
        const index = readVarint(value, cursor);
        if (index > I64_MAX) break;
        indices.push(index);
      } catch {
        break;
      }
    }
  }
  return indices;
}

export function generationMetadata(blob) {
  const root = decode(blob);
  const model = first(root, 1);
  if (model === undefined) throw Error('缺少 Protobuf chat model 字段');
  const fields = decode(model);
  return {
    model: text(fields, 19) ?? text(fields, 21),
    modelId: idOf(fields, 3),
    timestamp: timestamp(first(nested(fields, 9), 4)),
    stepIndices: stepIndices(root),
    ...attempts(fields, 4, 17),
  };
}

export function stepMetadata(blob) {
  const fields = decode(blob);
  const model = nested(fields, 24);
  return {
    model: text(model, 12) ?? text(model, 8),
    modelId: idOf(model, 1),
    provider: idOf(model, 7),
    timestamp: timestamp(first(fields, 8) ?? first(fields, 1)),
    ...attempts(fields, 9, 28),
  };
}
