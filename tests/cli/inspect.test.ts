// v0.8: inspect-mode formatter coverage. Each focused mode formats a known
// trace event list into a stable text shape. The dashboard reuses the same
// formatters; this file pins the column shape so v0.8.x changes are visible.

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  formatTrace,
  formatTiming,
  formatCost,
  formatDetectors,
  formatTools,
  formatMcp,
  table,
} = await import("../../src/cli/inspect.js");
type TraceEvent = import("../../src/state/trace.js").TraceEvent;

const SAMPLE: TraceEvent[] = [
  { type: "trace_version", version: 1, openwar_version: "0.8.0", brief_id: "x", at: "2026-05-18T00:00:00Z" },
  { type: "phase_enter", phase: "intake", at: "2026-05-18T00:00:00Z" },
  { type: "phase_exit", phase: "intake", duration_ms: 1500, at: "2026-05-18T00:00:01Z" },
  { type: "phase_enter", phase: "execute", at: "2026-05-18T00:00:01Z" },
  { type: "detector_fired", detector: "completion", payload: { complete: true }, at: "2026-05-18T00:00:02Z" },
  { type: "tool_call", call_id: "c1", name: "read_file", args: {}, auth_decision: "allow", at: "2026-05-18T00:00:02Z" },
  { type: "tool_result", call_id: "c1", success: true, duration_ms: 50, bytes: 500, at: "2026-05-18T00:00:02Z" },
  { type: "auth_check_fired", layer: "openwar", tool: "read_file", decision: "allow", reason: "ok", at: "2026-05-18T00:00:02Z" },
  { type: "role_invoke", role: "planner", tokens_in: 100, tokens_out: 50, tokens_source: "reported", duration_ms: 300, at: "2026-05-18T00:00:03Z" },
  { type: "role_invoke", role: "executor", tokens_in: 200, tokens_out: 100, tokens_source: "estimated", duration_ms: 600, at: "2026-05-18T00:00:04Z" },
  { type: "mcp_server_started", transport: "stdio", tool_count: 9, at: "2026-05-18T00:00:05Z" },
  { type: "mcp_call_dispatched", call_id: "m1", tool: "openwar:read_file", args_summary: "{path:...}", at: "2026-05-18T00:00:06Z" },
  { type: "mcp_call_completed", call_id: "m1", tool: "openwar:read_file", duration_ms: 1200, success: true, at: "2026-05-18T00:00:07Z" },
  { type: "settings_merge_attempted", binary: "Claude Code", settings_path: "/x/y", at: "2026-05-18T00:00:08Z" },
  { type: "settings_merge_outcome", outcome: "success", details: "0 added", at: "2026-05-18T00:00:08Z" },
  { type: "mcp_server_shutdown", reason: "session_end", at: "2026-05-18T00:00:09Z" },
];

test("table renders padded headers + separator + rows", () => {
  const out = table(["a", "longer_h"], [["1", "two"], ["abc", "x"]]);
  const lines = out.split("\n");
  assert.equal(lines.length, 4); // header + sep + 2 rows
  assert.match(lines[0]!, /^a +longer_h/);
  assert.match(lines[1]!, /^---? +---/);
});

test("formatTrace: full mode prints every event", () => {
  const out = formatTrace(SAMPLE, { full: true });
  // Every sample event should produce one line; trace_version + all others.
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, SAMPLE.length);
  assert.match(lines[0]!, /trace_version=1.*openwar=0\.8\.0/);
  assert.match(out, /phase_enter.*intake/);
  assert.match(out, /phase_exit.*intake.*1500ms/);
  assert.match(out, /tool_call.*read_file.*allow/);
  assert.match(out, /tool_result.*c1.*ok.*50ms.*500B/);
  assert.match(out, /mcp_start.*transport=stdio.*tools=9/);
  assert.match(out, /mcp_dispatch.*openwar:read_file/);
  assert.match(out, /mcp_done.*openwar:read_file.*ok.*1200ms/);
});

test("formatTrace: default tail caps output at 100 events", () => {
  const long: TraceEvent[] = [];
  for (let i = 0; i < 150; i++) {
    long.push({ type: "phase_enter", phase: "execute", at: `t${i}` });
  }
  const out = formatTrace(long);
  const lines = out.split("\n").filter(Boolean);
  // One header note line + 100 events.
  assert.equal(lines.length, 101);
  assert.match(lines[0]!, /showing last 100 of 150/);
});

test("formatTrace: explicit --tail overrides default", () => {
  const long: TraceEvent[] = [];
  for (let i = 0; i < 50; i++) long.push({ type: "phase_enter", phase: "execute", at: `t${i}` });
  const out = formatTrace(long, { tail: 10 });
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 11); // note + 10
});

test("formatTiming: per-phase enters + total_ms", () => {
  const out = formatTiming(SAMPLE);
  assert.match(out, /phase\s+enters\s+total_ms/);
  assert.match(out, /intake\s+1\s+1500ms/);
});

test("formatTiming: empty returns explanatory message", () => {
  const out = formatTiming([]);
  assert.match(out, /no phase enter\/exit events/);
});

test("formatCost: prints per-role token columns and marks mixed source", () => {
  const out = formatCost(SAMPLE);
  assert.match(out, /role\s+invocations\s+tokens_in\s+tokens_out\s+source/);
  assert.match(out, /planner\s+1\s+100\s+50\s+reported/);
  assert.match(out, /executor\s+1\s+200\s+100\s+estimated/);
  // No dollar column when no rate provided.
  assert.equal(/est_\$/.test(out), false);
});

test("formatCost: with dollar_per_1k_tokens prints est_$ column with asterisk on estimated", () => {
  const out = formatCost(SAMPLE, { dollar_per_1k_tokens: 3.0 });
  assert.match(out, /est_\$/);
  // planner = (150/1000)*3 = 0.45, reported -> no asterisk
  assert.match(out, /planner.*\$0\.4500(\s|$)/);
  // executor = (300/1000)*3 = 0.9, estimated -> asterisk
  assert.match(out, /executor.*\$0\.9000\*/);
  assert.match(out, /asterisk marks rows whose token counts were estimated/);
});

test("formatDetectors: sorted by count descending; banned_phrases counts dedupe", () => {
  const events: TraceEvent[] = [
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
    { type: "detector_fired", detector: "completion", payload: {}, at: "t" },
  ];
  const out = formatDetectors(events);
  assert.match(out, /detector\s+count/);
  const lines = out.split("\n").map((l) => l.trim());
  // After header + separator, blocker should appear first.
  assert.match(lines[2]!, /^blocker\s+2/);
  assert.match(lines[3]!, /^completion\s+1/);
});

test("formatDetectors: empty returns explanatory message", () => {
  assert.match(formatDetectors([]), /no detector_fired events/);
});

test("formatTools: joins call+result by call_id and surfaces auth decision", () => {
  const out = formatTools(SAMPLE);
  assert.match(out, /at\s+tool\s+auth\s+result\s+duration\s+bytes/);
  assert.match(out, /read_file\s+allow\s+ok\s+50ms\s+500B/);
});

test("formatTools: tool_call without matching tool_result shows pending", () => {
  const events: TraceEvent[] = [
    { type: "tool_call", call_id: "x", name: "shell_exec", args: {}, auth_decision: "allow", at: "t" },
  ];
  const out = formatTools(events);
  assert.match(out, /pending/);
});

test("formatMcp: filters to MCP + settings events", () => {
  const out = formatMcp(SAMPLE);
  assert.match(out, /mcp_start/);
  assert.match(out, /mcp_dispatch/);
  assert.match(out, /mcp_done/);
  assert.match(out, /settings_try/);
  assert.match(out, /settings_end/);
  assert.match(out, /mcp_stop/);
  // No unrelated event types.
  assert.equal(/tool_call/.test(out), false);
  assert.equal(/role_invoke/.test(out), false);
});

test("formatMcp: returns helpful message when no MCP events", () => {
  assert.match(formatMcp([]), /no MCP \/ settings events/);
});
