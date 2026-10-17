import { createReadStream } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { parseCompatible } from './json.mjs';
import { compressed, logFile, issue } from './shared.mjs';
export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
export async function walk(root, ctx) {
  const result = [],
    visited = new Set();
  async function visit(p) {
    const canonical = await realpath(p);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const info = await stat(canonical);
    if (info.isFile()) {
      if (logFile(canonical)) result.push(canonical);
      return;
    }
    if (!info.isDirectory()) return;
    for (const entry of (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      // 不遍历日志目录外的符号链接，也不扫描配置、凭据或附件。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() || logFile(entry.name)) await visit(join(canonical, entry.name));
    }
  }
  await visit(root);
  const present = new Set(result);
  return result
    .filter((p) => !(compressed(p) && present.has(p.replace(/\.(zst|zstd)$/, ''))))
    .filter((p) => !ctx.noCompressed || !compressed(p))
    .sort();
}

// DSH 使用拼接 Zstd 帧；Node 22 的流式接口不能可靠跨帧，逐帧扫描后解压。
function frameSize(b) {
  if (b.length < 5) return null;
  if (b.readUInt32LE(0) !== 0xfd2fb528) throw new Error('Zstd 帧头损坏');
  const d = b[4];
  if (d & 0x18) throw new Error('Zstd 帧头包含保留位');
  const single = !!(d & 0x20),
    flag = d >>> 6,
    dict = d & 3;
  let offset =
    5 + (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (flag === 0 ? (single ? 1 : 0) : 1 << flag);
  if (b.length < offset) return null;
  for (;;) {
    if (b.length < offset + 3) return null;
    const header = b.readUIntLE(offset, 3),
      type = (header >>> 1) & 3;
    if (type === 3) throw new Error('Zstd 块类型无效');
    offset += 3 + (type === 1 ? 1 : header >>> 3);
    if (b.length < offset) return null;
    if (header & 1) break;
  }
  offset += d & 4 ? 4 : 0;
  return b.length < offset ? null : offset;
}
async function* dshFrames(file) {
  let pending = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      const size = frameSize(pending);
      if (size === null) break;
      yield zlib.zstdDecompressSync(pending.subarray(0, size), {
        maxOutputLength: 64 * 1024 * 1024,
      });
      pending = pending.subarray(size);
    }
    if (pending.length > 64 * 1024 * 1024) throw new Error('单个 Zstd 帧超过 64 MiB 上限');
  }
  if (pending.length) throw new Error('末尾 Zstd 帧不完整；请等写入结束后重试');
}

// 流式解压，内存只保留当前行及用量元数据，不保存对话内容。
export async function* records(file, ctx, interesting) {
  const input = createReadStream(file);
  let stream = input,
    pumping;
  if (compressed(file)) {
    if (typeof zlib.createZstdDecompress !== 'function')
      throw new Error('读取压缩日志需要支持 Zstd 的 Node.js（最低 22.16）');
    if (file.endsWith('.zstd')) {
      input.destroy();
      stream = Readable.from(dshFrames(file));
    } else {
      stream = zlib.createZstdDecompress();
      pumping = pipeline(input, stream).then(
        () => null,
        (e) => e,
      );
    }
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo++;
      if (!line.trim() || (interesting && !interesting(line))) continue;
      try {
        const record = ctx.compat ? parseCompatible(line) : JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record))
          throw new Error('不是 JSON 对象');
        yield record;
      } catch (e) {
        issue(ctx, 'invalid_json', file, `第 ${lineNo} 行 JSON 损坏`);
      }
    }
    const error = await pumping;
    if (error) throw error;
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  } finally {
    lines.close();
    input.destroy();
    if (stream !== input) stream.destroy();
    if (pumping) await pumping;
  }
}
