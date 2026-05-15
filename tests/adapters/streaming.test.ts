// Streaming response parsing tests. Each test spins up a local HTTP server
// that returns a canned SSE stream, then verifies the adapter assembles the
// expected events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AnthropicAdapter } from "../../src/adapters/anthropic.js";
import { OpenAIAdapter } from "../../src/adapters/openai.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import type { StreamEvent, ToolCall } from "../../src/types.js";

function startSseServer(sse: string): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.end(sse);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

test("Anthropic: assembles a streamed text response with no tool calls", async () => {
  const sse =
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const { server, baseUrl } = await startSseServer(sse);
  try {
    const adapter = new AnthropicAdapter({ id: "anthropic", apiKey: "test", baseUrl });
    const events = await collect(
      adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
    );
    const deltas = events.filter(e => e.type === "text_delta").map(e => (e as { delta: string }).delta);
    assert.deepEqual(deltas, ["Hello", " world"]);
    const done = events.find(e => e.type === "done") as { message: string; tool_calls?: ToolCall[] } | undefined;
    assert.ok(done);
    assert.equal(done!.message, "Hello world");
  } finally { server.close(); }
});

test("Anthropic: streams a tool_use block and assembles JSON arguments", async () => {
  const part1 = `{"pa`;
  const part2 = `th":"x.txt"}`;
  const sse =
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: part1 } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: part2 } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const { server, baseUrl } = await startSseServer(sse);
  try {
    const adapter = new AnthropicAdapter({ id: "anthropic", apiKey: "test", baseUrl });
    const events = await collect(
      adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
    );
    const complete = events.find(e => e.type === "tool_call_complete") as { call: ToolCall } | undefined;
    assert.ok(complete);
    assert.equal(complete!.call.id, "tu_1");
    assert.equal(complete!.call.name, "read_file");
    assert.deepEqual(complete!.call.arguments, { path: "x.txt" });
  } finally { server.close(); }
});

test("Anthropic: handles multi-tool-call response", async () => {
  const argsA = `{"path":"a"}`;
  const argsB = `{"path":"."}`;
  const sse =
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: argsA } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_2", name: "list_dir" } })}\n\n` +
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: argsB } })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n` +
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
  const { server, baseUrl } = await startSseServer(sse);
  try {
    const adapter = new AnthropicAdapter({ id: "anthropic", apiKey: "test", baseUrl });
    const events = await collect(
      adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
    );
    const calls = events.filter(e => e.type === "tool_call_complete").map(e => (e as { call: ToolCall }).call);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.name, "read_file");
    assert.equal(calls[1]!.name, "list_dir");
  } finally { server.close(); }
});

test("OpenAI: assembles streamed text + tool call", async () => {
  const argsPart1 = `{"pa`;
  const argsPart2 = `th":"x"}`;
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "thinking" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: argsPart1 } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsPart2 } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    `data: [DONE]\n\n`;
  const { server, baseUrl } = await startSseServer(sse);
  try {
    const adapter = new OpenAIAdapter({ id: "openai", apiKey: "test", baseUrl });
    const events = await collect(
      adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
    );
    const text = events.filter(e => e.type === "text_delta").map(e => (e as { delta: string }).delta).join("");
    assert.equal(text, "thinking");
    const complete = events.find(e => e.type === "tool_call_complete") as { call: ToolCall } | undefined;
    assert.ok(complete);
    assert.equal(complete!.call.name, "read_file");
    assert.deepEqual(complete!.call.arguments, { path: "x" });
  } finally { server.close(); }
});

test("OpenAI: handles malformed tool-call JSON gracefully", async () => {
  const sse =
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "not json" } }] } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`;
  const { server, baseUrl } = await startSseServer(sse);
  try {
    const adapter = new OpenAIAdapter({ id: "openai", apiKey: "test", baseUrl });
    const events = await collect(
      adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
    );
    const complete = events.find(e => e.type === "tool_call_complete") as { call: ToolCall } | undefined;
    assert.ok(complete);
    const args = complete!.call.arguments as Record<string, unknown>;
    assert.equal(typeof args.__parse_error, "string");
  } finally { server.close(); }
});

test("Mock: emits scripted tool calls deterministically", async () => {
  const adapter = new MockAdapter([
    {
      text: "I'll read the file.",
      tool_calls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }],
    },
  ]);
  const events = await collect(
    adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
  );
  const complete = events.find(e => e.type === "tool_call_complete") as { call: ToolCall } | undefined;
  assert.ok(complete);
  assert.equal(complete!.call.name, "read_file");
});

test("Mock: backwards-compatible with plain-string scripts", async () => {
  const adapter = new MockAdapter(["just text"]);
  const events = await collect(
    adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
  );
  const done = events.find(e => e.type === "done") as { message: string };
  assert.equal(done.message, "just text");
});
