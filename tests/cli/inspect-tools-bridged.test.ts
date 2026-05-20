// v0.12.1: openwar inspect --tools renders bridged-CLI tool calls in a
// separate section from OpenWar's native tool calls. Both sort
// chronologically within their section.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTools } from "../../src/cli/inspect.js";
import type { TraceEvent } from "../../src/state/trace.js";

function nativeCall(call_id: string, at: string, name = "read_file"): TraceEvent {
  return {
    type: "tool_call",
    call_id,
    name,
    args: { path: "x" },
    auth_decision: "allow",
    at,
  };
}

function nativeResult(call_id: string, at: string, ok = true): TraceEvent {
  return {
    type: "tool_result",
    call_id,
    success: ok,
    duration_ms: 10,
    bytes: 100,
    at,
  };
}

function bridgedCall(call_id: string, at: string, binary = "claude", tool_name = "Glob"): TraceEvent {
  return {
    type: "bridged_tool_call",
    call_id,
    tool_name,
    arguments: { pattern: "*" },
    binary,
    at,
  };
}

function bridgedResult(call_id: string, at: string, binary = "claude", is_error = false): TraceEvent {
  return {
    type: "bridged_tool_result",
    call_id,
    result: "ok",
    is_error,
    binary,
    at,
  };
}

test("formatTools: empty trace returns placeholder mentioning both kinds", () => {
  const out = formatTools([]);
  assert.match(out, /no tool_call or bridged_tool_call events/);
});

test("formatTools: native-only trace renders only the Native section", () => {
  const events: TraceEvent[] = [
    nativeCall("c1", "2026-05-19T00:00:00Z"),
    nativeResult("c1", "2026-05-19T00:00:01Z"),
  ];
  const out = formatTools(events);
  assert.match(out, /Native tool calls/);
  assert.doesNotMatch(out, /Bridged CLI tool calls/);
  assert.match(out, /read_file/);
});

test("formatTools: bridged-only trace renders only the Bridged section", () => {
  const events: TraceEvent[] = [
    bridgedCall("toolu_01", "2026-05-19T00:00:00Z"),
    bridgedResult("toolu_01", "2026-05-19T00:00:01Z"),
  ];
  const out = formatTools(events);
  assert.match(out, /Bridged CLI tool calls/);
  assert.doesNotMatch(out, /Native tool calls/);
  assert.match(out, /claude/);
  assert.match(out, /Glob/);
});

test("formatTools: both kinds present -> two sections, in order Native then Bridged", () => {
  const events: TraceEvent[] = [
    nativeCall("c1", "2026-05-19T00:00:00Z"),
    bridgedCall("toolu_01", "2026-05-19T00:00:00.500Z"),
    nativeResult("c1", "2026-05-19T00:00:01Z"),
    bridgedResult("toolu_01", "2026-05-19T00:00:02Z"),
  ];
  const out = formatTools(events);
  const nativeIdx = out.indexOf("Native tool calls");
  const bridgedIdx = out.indexOf("Bridged CLI tool calls");
  assert.ok(nativeIdx > -1 && bridgedIdx > -1);
  assert.ok(nativeIdx < bridgedIdx, "Native section comes before Bridged");
});

test("formatTools: bridged is_error=true shows as 'err' result column", () => {
  const events: TraceEvent[] = [
    bridgedCall("toolu_e", "2026-05-19T00:00:00Z"),
    bridgedResult("toolu_e", "2026-05-19T00:00:01Z", "claude", true),
  ];
  const out = formatTools(events);
  assert.match(out, /\berr\b/);
});

test("formatTools: bridged section includes binary + tool name columns", () => {
  const events: TraceEvent[] = [
    bridgedCall("c1", "t1", "gemini", "Glob"),
    bridgedResult("c1", "t2", "gemini"),
  ];
  const out = formatTools(events);
  assert.match(out, /binary/);
  assert.match(out, /gemini/);
  assert.match(out, /Glob/);
});

test("formatTools: pending bridged call (no result) shows 'pending'", () => {
  const events: TraceEvent[] = [bridgedCall("c1", "t1")];
  const out = formatTools(events);
  assert.match(out, /pending/);
});

test("formatTools: native auth column still surfaces (no regression)", () => {
  const events: TraceEvent[] = [
    nativeCall("c1", "2026-05-19T00:00:00Z"),
    nativeResult("c1", "2026-05-19T00:00:01Z"),
  ];
  const out = formatTools(events);
  assert.match(out, /auth/);
  assert.match(out, /allow/);
});
