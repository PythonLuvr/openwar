// v0.13.0: SSE encoder for streaming /v1/chat/completions responses.
//
// OpenAI streams chat completions as Server-Sent Events: each event is a
// single line `data: {json}\n\n` (the blank line is the SSE terminator
// between events), and the stream ends with the literal `data: [DONE]\n\n`
// sentinel. Hand-rolled here; no SSE library dep.
//
// Format reference: OpenAI Chat Completions API streaming docs. The
// chunk shape is `chat.completion.chunk` (not `chat.completion`); each
// chunk carries an `index` + `delta` object that the client accumulates.
// The first chunk for a turn carries the `role`, subsequent chunks carry
// only `content` deltas, and the final chunk carries `finish_reason`
// with an empty delta. The exact byte format matters for client SDK
// compatibility.

import { randomUUID } from "node:crypto";

export interface SSEChunkContext {
  requestId: string;
  model: string;
  // Per-chunk created timestamp. OpenAI repeats `created` on every chunk;
  // mirror that so clients verifying chunk shape don't reject us.
  createdSec: number;
}

export function newChunkContext(requestId: string, model: string): SSEChunkContext {
  return {
    requestId,
    model,
    createdSec: Math.floor(Date.now() / 1000),
  };
}

// First chunk of a streaming response. Carries the assistant role marker
// with an empty content delta; subsequent chunks fill in the content.
export function encodeRoleChunk(ctx: SSEChunkContext): string {
  const payload = {
    id: `chatcmpl-${ctx.requestId}`,
    object: "chat.completion.chunk",
    created: ctx.createdSec,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  };
  return formatSse(payload);
}

// Content delta chunk. Each text_delta StreamEvent produces one of these.
export function encodeContentChunk(ctx: SSEChunkContext, deltaText: string): string {
  const payload = {
    id: `chatcmpl-${ctx.requestId}`,
    object: "chat.completion.chunk",
    created: ctx.createdSec,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: { content: deltaText },
        finish_reason: null,
      },
    ],
  };
  return formatSse(payload);
}

// Final chunk before [DONE]. Empty delta plus a finish_reason. OpenAI's
// recognized reasons for our v0.13.0 scope: "stop" (clean completion),
// "length" (max_tokens hit), "content_filter" (Phase 3 denial), and
// "tool_calls" (reserved for v0.13.1 when tool surface lands).
export function encodeFinishChunk(
  ctx: SSEChunkContext,
  finishReason: "stop" | "length" | "tool_calls" | "content_filter",
): string {
  const payload = {
    id: `chatcmpl-${ctx.requestId}`,
    object: "chat.completion.chunk",
    created: ctx.createdSec,
    model: ctx.model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
  return formatSse(payload);
}

// Terminal sentinel. OpenAI's SDKs read until they see exactly this
// literal and treat the stream as complete.
export const SSE_DONE_SENTINEL = "data: [DONE]\n\n";

// Encode a payload as one SSE event. JSON-encoded with no embedded
// newlines (JSON.stringify already escapes them) so the line-oriented
// SSE format is preserved.
function formatSse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// Encode an error in OpenAI's error shape as a single SSE event. Used
// when the proxy needs to surface a server-side error mid-stream (for
// example, an upstream adapter timing out). The client's SDK propagates
// this through its error-handling path. Not emitted for Phase 3 denials
// (those flow as a final content chunk + content_filter finish_reason).
export function encodeErrorChunk(message: string, type: string, code?: string): string {
  const payload = {
    error: {
      message,
      type,
      ...(code ? { code } : {}),
    },
  };
  return formatSse(payload);
}

// Convenience: header set every streaming response must send before the
// first chunk. Cache-Control prevents intermediaries (and some clients)
// from buffering; Connection: keep-alive holds the socket open; the
// content-type is OpenAI's SSE convention.
export const STREAMING_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

// Re-export for ergonomic test fixtures.
export { randomUUID as _randomUUID };
