// Output cap for stream-producing tools. Reads from a readable stream,
// accumulating bytes up to maxBytes, then continues draining without
// storing further data so the producer can finish cleanly.
//
// Used by shell_exec for stdout/stderr and http_fetch for response body.

import type { Readable } from "node:stream";

export interface CapResult {
  content: Buffer;
  truncated: boolean;
  totalBytesSeen: number;
}

export async function capStream(stream: Readable, maxBytes: number): Promise<CapResult> {
  if (maxBytes < 0) throw new Error(`maxBytes must be >= 0 (got ${maxBytes})`);
  const chunks: Buffer[] = [];
  let stored = 0;
  let totalSeen = 0;
  let truncated = false;

  for await (const chunk of stream) {
    const buf: Buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
      ? Buffer.from(chunk)
      : Buffer.from(chunk as Uint8Array);
    totalSeen += buf.length;
    if (stored >= maxBytes) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - stored;
    if (buf.length <= remaining) {
      chunks.push(buf);
      stored += buf.length;
    } else {
      chunks.push(buf.subarray(0, remaining));
      stored = maxBytes;
      truncated = true;
    }
  }

  return { content: Buffer.concat(chunks), truncated, totalBytesSeen: totalSeen };
}

// Same shape but for an iterable of Buffer chunks (no stream backpressure).
// Useful for tests and synchronous-ish producers.
export function capChunks(chunks: Iterable<Buffer | string>, maxBytes: number): CapResult {
  if (maxBytes < 0) throw new Error(`maxBytes must be >= 0 (got ${maxBytes})`);
  const out: Buffer[] = [];
  let stored = 0;
  let totalSeen = 0;
  let truncated = false;
  for (const chunk of chunks) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSeen += buf.length;
    if (stored >= maxBytes) {
      truncated = true;
      continue;
    }
    const remaining = maxBytes - stored;
    if (buf.length <= remaining) {
      out.push(buf);
      stored += buf.length;
    } else {
      out.push(buf.subarray(0, remaining));
      stored = maxBytes;
      truncated = true;
    }
  }
  return { content: Buffer.concat(out), truncated, totalBytesSeen: totalSeen };
}
