// v0.13.0: OpenAI response translation (non-streaming) + SSE streaming
// encoder shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildNonStreamingResponse,
  denialRefusalText,
  traceIdHeader,
  generateChatCompletionId,
} from "../../src/serve/openai-translate.js";
import {
  encodeRoleChunk,
  encodeContentChunk,
  encodeFinishChunk,
  encodeErrorChunk,
  newChunkContext,
  SSE_DONE_SENTINEL,
  STREAMING_RESPONSE_HEADERS,
} from "../../src/serve/openai-streaming.js";

// ---- buildNonStreamingResponse ----

test("buildNonStreamingResponse: id is chatcmpl-<requestId>", () => {
  const r = buildNonStreamingResponse({
    requestId: "proxy-abc",
    model: "claude-opus-4-7",
    text: "hello",
    finishReason: "stop",
  });
  assert.equal(r.id, "chatcmpl-proxy-abc");
});

test("buildNonStreamingResponse: object is chat.completion (not chunk)", () => {
  const r = buildNonStreamingResponse({
    requestId: "x", model: "m", text: "t", finishReason: "stop",
  });
  assert.equal(r.object, "chat.completion");
});

test("buildNonStreamingResponse: single choice carrying assistant text + finish_reason", () => {
  const r = buildNonStreamingResponse({
    requestId: "x", model: "m", text: "hi there", finishReason: "stop",
  });
  assert.equal(r.choices.length, 1);
  assert.equal(r.choices[0]!.message.role, "assistant");
  assert.equal(r.choices[0]!.message.content, "hi there");
  assert.equal(r.choices[0]!.finish_reason, "stop");
});

test("buildNonStreamingResponse: usage included when supplied", () => {
  const r = buildNonStreamingResponse({
    requestId: "x", model: "m", text: "t", finishReason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(r.usage?.total_tokens, 15);
});

// ---- denialRefusalText ----

test("denialRefusalText: mentions action + missing categories", () => {
  const t = denialRefusalText("delete src/legacy.ts", ["filesystem_write"]);
  assert.match(t, /delete src\/legacy\.ts/);
  assert.match(t, /filesystem_write/);
  assert.match(t, /--authorized-costs/);
});

test("denialRefusalText: handles empty categories list", () => {
  const t = denialRefusalText("some action", []);
  assert.match(t, /unspecified/);
});

// ---- traceIdHeader ----

test("traceIdHeader: returns X-OpenWar-Trace-Id with the request id", () => {
  const h = traceIdHeader("proxy-abc-123");
  assert.equal(h.name, "X-OpenWar-Trace-Id");
  assert.equal(h.value, "proxy-abc-123");
});

test("generateChatCompletionId: shape is chatcmpl-<uuid>", () => {
  const id = generateChatCompletionId();
  assert.match(id, /^chatcmpl-[0-9a-f-]{36}$/);
});

// ---- SSE encoders ----

test("encodeRoleChunk: shape is `data: {json}\\n\\n` with role=assistant + empty content", () => {
  const chunk = encodeRoleChunk(newChunkContext("req1", "m"));
  assert.match(chunk, /^data: /);
  assert.match(chunk, /\n\n$/);
  const json = JSON.parse(chunk.slice("data: ".length, -2));
  assert.equal(json.object, "chat.completion.chunk");
  assert.equal(json.choices[0].delta.role, "assistant");
  assert.equal(json.choices[0].delta.content, "");
  assert.equal(json.choices[0].finish_reason, null);
});

test("encodeContentChunk: delta carries only content; no role on subsequent chunks", () => {
  const chunk = encodeContentChunk(newChunkContext("r", "m"), "hello");
  const json = JSON.parse(chunk.slice("data: ".length, -2));
  assert.equal(json.choices[0].delta.content, "hello");
  assert.equal(json.choices[0].delta.role, undefined);
  assert.equal(json.choices[0].finish_reason, null);
});

test("encodeFinishChunk: empty delta + finish_reason populated", () => {
  const chunk = encodeFinishChunk(newChunkContext("r", "m"), "content_filter");
  const json = JSON.parse(chunk.slice("data: ".length, -2));
  assert.deepEqual(json.choices[0].delta, {});
  assert.equal(json.choices[0].finish_reason, "content_filter");
});

test("encodeFinishChunk: accepts all four v0.13.0 finish reasons", () => {
  for (const reason of ["stop", "length", "tool_calls", "content_filter"] as const) {
    const chunk = encodeFinishChunk(newChunkContext("r", "m"), reason);
    const json = JSON.parse(chunk.slice("data: ".length, -2));
    assert.equal(json.choices[0].finish_reason, reason);
  }
});

test("SSE_DONE_SENTINEL is exactly 'data: [DONE]\\n\\n' (OpenAI SDK byte match)", () => {
  assert.equal(SSE_DONE_SENTINEL, "data: [DONE]\n\n");
});

test("encodeErrorChunk: wraps in OpenAI error shape", () => {
  const chunk = encodeErrorChunk("boom", "server_error", "openwar_unhandled");
  const json = JSON.parse(chunk.slice("data: ".length, -2));
  assert.equal(json.error.message, "boom");
  assert.equal(json.error.type, "server_error");
  assert.equal(json.error.code, "openwar_unhandled");
});

test("STREAMING_RESPONSE_HEADERS: text/event-stream + no-cache + keep-alive", () => {
  assert.equal(STREAMING_RESPONSE_HEADERS["content-type"], "text/event-stream; charset=utf-8");
  assert.match(STREAMING_RESPONSE_HEADERS["cache-control"]!, /no-cache/);
  assert.equal(STREAMING_RESPONSE_HEADERS["connection"], "keep-alive");
});
