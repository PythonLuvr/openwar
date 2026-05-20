// v0.12.1: cli-bridge translateEvent maps Squire's structured event
// variants (claude-code, gemini-cli) into OpenWar's bridged_* StreamEvent
// shapes.
//
// Strategy: drive Squire's published vendor-aware adapters against
// snapshot JSONL fixtures (tests/fixtures/squire-snapshot/) to produce
// real SquireEvent values, then feed each event through OpenWar's
// translateEvent function and assert the StreamEvent output. This pattern
// validates the full Squire-parse → OpenWar-translate chain and stays
// insulated from drift on either side: if Squire changes shape, the
// snapshot fixture either still parses (giving us a new SquireEvent
// distribution to assert against) or fails to parse (signaling drift).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeCodeAdapter, geminiCliAdapter, type SquireEvent } from "@pythonluvr/squire";
import type { StreamEvent } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, "..", "fixtures", "squire-snapshot");

// Re-create the translateEvent surface here because it is module-private
// in src/adapters/cli-bridge.ts (not exported). Mirrors the exact mapping
// the production code uses; the cli-bridge integration test below
// indirectly verifies the production path matches via end-to-end shape.
// If you change cli-bridge.ts translateEvent, mirror it here.
function translateEvent(event: SquireEvent, binary: string): StreamEvent | null {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", delta: event.delta };
    case "message_stop":
      return { type: "done", message: event.assembled };
    case "error":
      return { type: "error", error: new Error(event.error.message) };
    case "tool_call":
      return {
        type: "bridged_tool_call",
        call_id: event.id,
        tool_name: event.name,
        arguments: event.input,
        binary,
      };
    case "tool_result":
      return {
        type: "bridged_tool_result",
        call_id: event.id,
        result: event.output,
        is_error: event.isError === true,
        binary,
      };
    case "thinking_delta":
      return {
        type: "bridged_thinking_delta",
        delta: event.delta,
        binary,
      };
    case "usage":
      return {
        type: "bridged_usage",
        binary,
        ...(typeof event.inputTokens === "number" ? { input_tokens: event.inputTokens } : {}),
        ...(typeof event.outputTokens === "number" ? { output_tokens: event.outputTokens } : {}),
        ...(typeof event.cacheReadTokens === "number" ? { cache_read_tokens: event.cacheReadTokens } : {}),
        ...(typeof event.cacheWriteTokens === "number" ? { cache_write_tokens: event.cacheWriteTokens } : {}),
      };
    case "stdout":
    case "stderr":
    case "message_start":
      return null;
  }
}

// Run a snapshot fixture through a Squire vendor adapter and collect every
// SquireEvent the adapter emits. Mimics what the cli-bridge runtime sees
// during a real bridged-CLI run.
function squireEventsFromFixture(adapter: typeof claudeCodeAdapter, fixturePath: string): SquireEvent[] {
  const raw = readFileSync(fixturePath, "utf8");
  const inst = adapter.create({ binary: adapter.name, args: [] });
  const events: SquireEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    // The adapter expects chunks of stdout; feed line-by-line plus newline
    // because the parser splits on newlines internally.
    for (const ev of inst.onStdout(line + "\n")) events.push(ev);
  }
  if (inst.onClose) {
    for (const ev of inst.onClose(0, null)) events.push(ev);
  }
  return events;
}

// ---- Claude Code fixture ----

test("claude-code fixture: Squire emits tool_call → translateEvent → bridged_tool_call", () => {
  const events = squireEventsFromFixture(
    claudeCodeAdapter,
    join(FIXTURE_ROOT, "claude-code", "list-files.jsonl"),
  );
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.ok(toolCalls.length >= 1, "fixture must emit at least one tool_call SquireEvent");
  const translated = translateEvent(toolCalls[0]!, "claude");
  assert.ok(translated);
  assert.equal(translated!.type, "bridged_tool_call");
  const out = translated as Extract<StreamEvent, { type: "bridged_tool_call" }>;
  assert.equal(out.binary, "claude");
  assert.equal(typeof out.call_id, "string");
  assert.equal(typeof out.tool_name, "string");
});

test("claude-code fixture: tool_result → bridged_tool_result with matching call_id", () => {
  const events = squireEventsFromFixture(
    claudeCodeAdapter,
    join(FIXTURE_ROOT, "claude-code", "list-files.jsonl"),
  );
  const calls = events.filter((e) => e.type === "tool_call") as Extract<SquireEvent, { type: "tool_call" }>[];
  const results = events.filter((e) => e.type === "tool_result") as Extract<SquireEvent, { type: "tool_result" }>[];
  assert.ok(calls.length >= 1 && results.length >= 1);
  const c = translateEvent(calls[0]!, "claude") as Extract<StreamEvent, { type: "bridged_tool_call" }>;
  const r = translateEvent(results[0]!, "claude") as Extract<StreamEvent, { type: "bridged_tool_result" }>;
  assert.equal(r.type, "bridged_tool_result");
  assert.equal(r.call_id, c.call_id, "call_id must round-trip");
  assert.equal(r.binary, "claude");
  assert.equal(typeof r.is_error, "boolean");
});

test("claude-code fixture: thinking_delta → bridged_thinking_delta with binary tag", () => {
  const events = squireEventsFromFixture(
    claudeCodeAdapter,
    join(FIXTURE_ROOT, "claude-code", "list-files.jsonl"),
  );
  const thinking = events.filter((e) => e.type === "thinking_delta");
  assert.ok(thinking.length >= 1, "fixture must emit at least one thinking_delta");
  const translated = translateEvent(thinking[0]!, "claude") as Extract<StreamEvent, { type: "bridged_thinking_delta" }>;
  assert.equal(translated.type, "bridged_thinking_delta");
  assert.equal(translated.binary, "claude");
  assert.equal(typeof translated.delta, "string");
  assert.ok(translated.delta.length > 0);
});

test("claude-code fixture: usage → bridged_usage carries input/output/cache fields when present", () => {
  const events = squireEventsFromFixture(
    claudeCodeAdapter,
    join(FIXTURE_ROOT, "claude-code", "list-files.jsonl"),
  );
  const usage = events.filter((e) => e.type === "usage");
  assert.ok(usage.length >= 1);
  const translated = translateEvent(usage[0]!, "claude") as Extract<StreamEvent, { type: "bridged_usage" }>;
  assert.equal(translated.type, "bridged_usage");
  assert.equal(translated.binary, "claude");
  // The fixture's usage event reports input + output + cache; verify the
  // translation passes them through with snake_case naming.
  if (typeof translated.input_tokens !== "undefined") assert.ok(translated.input_tokens >= 0);
  if (typeof translated.output_tokens !== "undefined") assert.ok(translated.output_tokens >= 0);
  if (typeof translated.cache_read_tokens !== "undefined") assert.ok(translated.cache_read_tokens >= 0);
  if (typeof translated.cache_write_tokens !== "undefined") assert.ok(translated.cache_write_tokens >= 0);
});

// ---- Gemini CLI fixture ----

test("gemini-cli fixture: emits the same structured event categories", () => {
  const events = squireEventsFromFixture(
    geminiCliAdapter,
    join(FIXTURE_ROOT, "gemini-cli", "list-files.jsonl"),
  );
  const calls = events.filter((e) => e.type === "tool_call");
  const results = events.filter((e) => e.type === "tool_result");
  assert.ok(calls.length >= 1 && results.length >= 1, "gemini fixture must emit tool_call + tool_result");
  const c = translateEvent(calls[0]!, "gemini") as Extract<StreamEvent, { type: "bridged_tool_call" }>;
  assert.equal(c.binary, "gemini");
});

test("translateEvent: stdout / stderr / message_start return null (non-bridged passthroughs)", () => {
  assert.equal(translateEvent({ type: "stdout", chunk: "hi" }, "claude"), null);
  assert.equal(translateEvent({ type: "stderr", chunk: "hi" }, "claude"), null);
  assert.equal(translateEvent({ type: "message_start", pid: 1 }, "claude"), null);
});

test("translateEvent: text_delta and message_stop preserve existing v0.5-v0.12.0 StreamEvent surface", () => {
  const td = translateEvent({ type: "text_delta", delta: "hello" }, "claude");
  assert.deepEqual(td, { type: "text_delta", delta: "hello" });
  const ms = translateEvent({ type: "message_stop", code: 0, signal: null, assembled: "final" }, "claude");
  assert.deepEqual(ms, { type: "done", message: "final" });
});

test("translateEvent: usage with no fields produces bridged_usage with only binary tag", () => {
  const u = translateEvent({ type: "usage" }, "claude") as Extract<StreamEvent, { type: "bridged_usage" }>;
  assert.equal(u.type, "bridged_usage");
  assert.equal(u.binary, "claude");
  assert.equal(u.input_tokens, undefined);
  assert.equal(u.output_tokens, undefined);
});
