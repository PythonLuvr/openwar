// v0.13.0: OpenAI Chat Completions request parsing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChatRequest } from "../../src/serve/openai-parse.js";

test("parseChatRequest: minimal valid request", () => {
  const r = parseChatRequest({
    model: "openwar",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.request.model, "openwar");
    assert.equal(r.request.messages.length, 1);
  }
});

test("parseChatRequest: rejects non-object body with missing_request_object code", () => {
  const r = parseChatRequest("not an object");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "missing_request_object");
});

test("parseChatRequest: rejects missing model", () => {
  const r = parseChatRequest({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "missing_model");
});

test("parseChatRequest: rejects empty messages array", () => {
  const r = parseChatRequest({ model: "openwar", messages: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "missing_messages");
});

test("parseChatRequest: rejects unknown role", () => {
  const r = parseChatRequest({
    model: "openwar",
    messages: [{ role: "guru", content: "hi" }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.body.error.code, "invalid_role");
});

test("parseChatRequest: accepts all five OpenAI roles", () => {
  for (const role of ["system", "user", "assistant", "tool", "developer"] as const) {
    const r = parseChatRequest({
      model: "openwar",
      messages: [{ role, content: "x" }],
    });
    assert.equal(r.ok, true, `role ${role} should parse`);
  }
});

test("parseChatRequest: accepts null content (assistant with tool_calls)", () => {
  const r = parseChatRequest({
    model: "openwar",
    messages: [{ role: "assistant", content: null }],
  });
  assert.equal(r.ok, true);
});

test("parseChatRequest: preserves stream / temperature / max_tokens / tools", () => {
  const r = parseChatRequest({
    model: "openwar",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    temperature: 0.7,
    max_tokens: 100,
    tools: [{ type: "function", function: { name: "foo" } }],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.request.stream, true);
    assert.equal(r.request.temperature, 0.7);
    assert.equal(r.request.max_tokens, 100);
    assert.equal(r.request.tools?.length, 1);
  }
});

test("parseChatRequest: preserves unknown fields (top_p, response_format, etc.)", () => {
  const r = parseChatRequest({
    model: "openwar",
    messages: [{ role: "user", content: "hi" }],
    top_p: 0.9,
    response_format: { type: "json_object" },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal((r.request as Record<string, unknown>).top_p, 0.9);
  }
});
