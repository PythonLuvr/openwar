import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolsForAnthropic,
  formatMessagesForAnthropic,
  formatToolResultForAnthropicMessage,
} from "../../src/adapters/anthropic.js";
import {
  formatToolsForOpenAI,
  formatMessagesForOpenAI,
  formatToolResultForOpenAIMessage,
} from "../../src/adapters/openai.js";
import {
  formatToolsForGemini,
  formatMessagesForGemini,
  formatToolResultForGeminiMessage,
} from "../../src/adapters/gemini.js";
import type { ToolDefinition, SendMessageOptions } from "../../src/types.js";

const SAMPLE_TOOL: ToolDefinition = {
  name: "read_file",
  description: "Read a UTF-8 text file.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

const SAMPLE_OPTS: SendMessageOptions = {
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hi", at: new Date().toISOString() }],
};

test("Anthropic: formatToolsForAnthropic produces input_schema shape", () => {
  const out = formatToolsForAnthropic([SAMPLE_TOOL]) as Array<{ name: string; input_schema: unknown }>;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "read_file");
  assert.ok(out[0]!.input_schema);
});

test("Anthropic: prior_tool_calls and prior_tool_results become content blocks", () => {
  const opts: SendMessageOptions = {
    ...SAMPLE_OPTS,
    prior_tool_calls: [{ id: "tu_1", name: "read_file", arguments: { path: "x.txt" } }],
    prior_tool_results: [{ call_id: "tu_1", content: "hello", is_error: false }],
  };
  const msgs = formatMessagesForAnthropic(opts) as Array<{ role: string; content: unknown }>;
  // 1 user + 1 assistant (tool_use) + 1 user (tool_result) = 3
  assert.equal(msgs.length, 3);
  const assistantMsg = msgs[1]!;
  assert.equal(assistantMsg.role, "assistant");
  const blocks = assistantMsg.content as Array<{ type: string }>;
  assert.equal(blocks[0]!.type, "tool_use");
  const userMsg = msgs[2]!;
  const resBlocks = userMsg.content as Array<{ type: string; tool_use_id: string }>;
  assert.equal(resBlocks[0]!.type, "tool_result");
  assert.equal(resBlocks[0]!.tool_use_id, "tu_1");
});

test("Anthropic: tool_result is_error flag only emitted when true", () => {
  const ok = formatToolResultForAnthropicMessage({ call_id: "x", content: "ok" }) as Record<string, unknown>;
  assert.equal("is_error" in ok, false);
  const err = formatToolResultForAnthropicMessage({ call_id: "x", content: "no", is_error: true }) as Record<string, unknown>;
  assert.equal(err.is_error, true);
});

test("OpenAI: formatToolsForOpenAI produces type=function shape", () => {
  const out = formatToolsForOpenAI([SAMPLE_TOOL]) as Array<{ type: string; function: { name: string; parameters: unknown } }>;
  assert.equal(out[0]!.type, "function");
  assert.equal(out[0]!.function.name, "read_file");
  assert.ok(out[0]!.function.parameters);
});

test("OpenAI: prior_tool_calls + results map to assistant+tool messages", () => {
  const opts: SendMessageOptions = {
    ...SAMPLE_OPTS,
    prior_tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "x" } }],
    prior_tool_results: [{ call_id: "call_1", content: "hello" }],
  };
  const msgs = formatMessagesForOpenAI(opts, opts.system) as Array<{ role: string; tool_calls?: unknown[]; tool_call_id?: string }>;
  // system + user + assistant(tool_calls) + tool = 4
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[2]!.role, "assistant");
  assert.ok(msgs[2]!.tool_calls);
  assert.equal(msgs[3]!.role, "tool");
  assert.equal(msgs[3]!.tool_call_id, "call_1");
});

test("OpenAI: tool arguments are stringified JSON for the wire", () => {
  const opts: SendMessageOptions = {
    ...SAMPLE_OPTS,
    prior_tool_calls: [{ id: "c", name: "x", arguments: { a: 1 } }],
  };
  const msgs = formatMessagesForOpenAI(opts, opts.system) as Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>;
  const tc = msgs[2]!.tool_calls![0]!;
  assert.equal(typeof tc.function.arguments, "string");
  assert.deepEqual(JSON.parse(tc.function.arguments), { a: 1 });
});

test("Gemini: formatToolsForGemini wraps as function_declarations array", () => {
  const out = formatToolsForGemini([SAMPLE_TOOL]) as Array<{ function_declarations: Array<{ name: string }> }>;
  assert.equal(out.length, 1);
  assert.equal(out[0]!.function_declarations[0]!.name, "read_file");
});

test("Gemini: prior_tool_calls and results map to function_call / function_response parts", () => {
  const opts: SendMessageOptions = {
    ...SAMPLE_OPTS,
    prior_tool_calls: [{ id: "gemini_call_0", name: "read_file", arguments: { path: "x" } }],
    prior_tool_results: [{ call_id: "gemini_call_0", content: "hi" }],
  };
  const contents = formatMessagesForGemini(opts) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  // user, model (function_call), user (function_response) = 3
  assert.equal(contents.length, 3);
  assert.ok(contents[1]!.parts[0]!.function_call);
  assert.ok(contents[2]!.parts[0]!.function_response);
});

test("Gemini: formatToolResultForGeminiMessage wraps response payload", () => {
  const out = formatToolResultForGeminiMessage({ call_id: "x", content: "hello" }) as { function_response: { response: { content: string } } };
  assert.equal(out.function_response.response.content, "hello");
});
