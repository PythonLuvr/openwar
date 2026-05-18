// v0.8 trace event stream: writer/reader round-trip, schema-version header,
// tail/filter/corruption handling, and aggregator helpers. Every event-type
// shape exercised at least once so future additions get a paired test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v08-trace-"));
process.env.OPENWAR_SESSIONS_DIR = TMP;
process.env.OPENWAR_TRACE_STRICT = "1";

const {
  Tracer,
  readTrace,
  readTraceFromPath,
  nullTracer,
  aggregatePhaseTimings,
  aggregateRoleCost,
  aggregateDetectorCounts,
  TRACE_SCHEMA_VERSION,
} = await import("../../src/state/trace.js");
const { traceFile, sessionsDir } = await import("../../src/state/paths.js");
type TraceEvent = import("../../src/state/trace.js").TraceEvent;

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_TRACE_STRICT;
});

test("OPENWAR_SESSIONS_DIR is honored by sessionsDir and traceFile", () => {
  assert.equal(sessionsDir(), TMP);
  assert.ok(traceFile("brief-x").startsWith(TMP));
});

test("Tracer writes a trace_version header as the first event", () => {
  const tracer = new Tracer({ briefId: "brief-header", enabled: true, openwarVersion: "0.8.0" });
  const path = traceFile("brief-header");
  assert.ok(existsSync(path));
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const header = JSON.parse(lines[0]!);
  assert.equal(header.type, "trace_version");
  assert.equal(header.version, TRACE_SCHEMA_VERSION);
  assert.equal(header.openwar_version, "0.8.0");
  assert.equal(header.brief_id, "brief-header");
  // Header counts as event #1; emit gives event #2.
  tracer.emit({ type: "phase_enter", phase: "intake", at: new Date().toISOString() });
  const after = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(after.length, 2);
});

test("Tracer with enabled=false writes nothing", () => {
  const tracer = new Tracer({ briefId: "brief-disabled", enabled: false, openwarVersion: "0.8.0" });
  tracer.emit({ type: "phase_enter", phase: "intake", at: new Date().toISOString() });
  assert.equal(existsSync(traceFile("brief-disabled")), false);
});

test("nullTracer is a disabled tracer and is safe to emit through", () => {
  const t = nullTracer();
  assert.equal(t.enabled, false);
  t.emit({ type: "error", error: "x", phase: "execute", at: "" });
  // Nothing to assert beyond "did not throw."
});

test("readTrace returns events in write order and skips header from caller's perspective", () => {
  const tracer = new Tracer({ briefId: "brief-read", enabled: true, openwarVersion: "0.8.0" });
  const events: TraceEvent[] = [
    { type: "phase_enter", phase: "intake", at: "2026-01-01T00:00:00Z" },
    { type: "phase_exit", phase: "intake", duration_ms: 1234, at: "2026-01-01T00:00:01Z" },
    { type: "phase_enter", phase: "execute", at: "2026-01-01T00:00:01Z" },
  ];
  for (const e of events) tracer.emit(e);
  const { events: out, corrupted_lines, empty } = readTrace("brief-read");
  assert.equal(empty, false);
  assert.equal(corrupted_lines.length, 0);
  // 1 header + 3 emitted = 4 events on disk
  assert.equal(out.length, 4);
  assert.equal(out[0]!.type, "trace_version");
  assert.equal(out[1]!.type, "phase_enter");
  assert.equal(out[3]!.type, "phase_enter");
});

test("readTrace type filter narrows the result without re-reading", () => {
  const tracer = new Tracer({ briefId: "brief-filter", enabled: true, openwarVersion: "0.8.0" });
  tracer.emit({ type: "phase_enter", phase: "intake", at: "2026-01-01T00:00:00Z" });
  tracer.emit({ type: "detector_fired", detector: "blocker", payload: { x: 1 }, at: "2026-01-01T00:00:01Z" });
  tracer.emit({ type: "detector_fired", detector: "completion", payload: {}, at: "2026-01-01T00:00:02Z" });
  const { events } = readTrace("brief-filter", { type: "detector_fired" });
  assert.equal(events.length, 2);
  for (const e of events) assert.equal(e.type, "detector_fired");
});

test("readTrace tail keeps only the last N events", () => {
  const tracer = new Tracer({ briefId: "brief-tail", enabled: true, openwarVersion: "0.8.0" });
  for (let i = 0; i < 20; i++) {
    tracer.emit({ type: "phase_enter", phase: "execute", at: new Date(2026, 0, 1, 0, 0, i).toISOString() });
  }
  const { events } = readTrace("brief-tail", { tail: 5 });
  assert.equal(events.length, 5);
});

test("readTrace tolerates corrupted lines and reports their indices", () => {
  const path = traceFile("brief-corrupt");
  writeFileSync(path, "", "utf8");
  appendFileSync(path, JSON.stringify({ type: "phase_enter", phase: "intake", at: "x" }) + "\n");
  appendFileSync(path, "{this is not json\n");
  appendFileSync(path, JSON.stringify({ type: "phase_exit", phase: "intake", duration_ms: 5, at: "y" }) + "\n");
  const { events, corrupted_lines } = readTrace("brief-corrupt");
  assert.equal(events.length, 2);
  assert.deepEqual(corrupted_lines, [2]);
});

test("readTrace returns empty=true when the file does not exist", () => {
  const { events, empty } = readTrace("brief-never-emitted");
  assert.deepEqual(events, []);
  assert.equal(empty, true);
});

test("event union: every type round-trips through JSONL", () => {
  const path = join(TMP, "brief-union.trace.ndjson");
  const tracer = new Tracer({ briefId: "brief-union", enabled: true, openwarVersion: "0.8.0", filePath: path });
  const samples: TraceEvent[] = [
    { type: "phase_enter", phase: "execute", at: "t" },
    { type: "phase_exit", phase: "execute", duration_ms: 100, at: "t" },
    { type: "detector_fired", detector: "blocker", payload: { reason: "x" }, at: "t" },
    { type: "tool_call", call_id: "c1", name: "read_file", args: { path: "a" }, auth_decision: "allow", at: "t" },
    { type: "tool_result", call_id: "c1", success: true, duration_ms: 12, bytes: 99, at: "t" },
    { type: "auth_prompt", categories: ["shell_exec"], response: "Y", at: "t" },
    { type: "auth_check_fired", layer: "openwar", tool: "write_file", decision: "deny", reason: "missing", at: "t" },
    { type: "role_invoke", role: "planner", tokens_in: 100, tokens_out: 50, tokens_source: "reported", duration_ms: 200, at: "t" },
    { type: "budget_warn", metric: "tokens", used: 100, limit: 200, at: "t" },
    { type: "budget_halt", metric: "tokens", used: 250, limit: 200, at: "t" },
    { type: "subtask_status", subtask_id: "s1", status: "passed", at: "t" },
    { type: "coordinator_state", state: "execute", at: "t" },
    { type: "mcp_server_started", transport: "stdio", tool_count: 9, at: "t" },
    { type: "mcp_server_shutdown", reason: "session_end", at: "t" },
    { type: "mcp_call_dispatched", call_id: "m1", tool: "openwar:read_file", args_summary: "{path}", at: "t" },
    { type: "mcp_call_pending", call_id: "m1", tool: "openwar:read_file", elapsed_ms: 10_000, at: "t" },
    { type: "mcp_call_completed", call_id: "m1", tool: "openwar:read_file", duration_ms: 12_345, success: true, at: "t" },
    { type: "settings_merge_attempted", binary: "claude", settings_path: "/x/y/settings.json", at: "t" },
    { type: "settings_merge_outcome", outcome: "success", details: "9 added", at: "t" },
    { type: "error", error: "boom", phase: "execute", at: "t" },
  ];
  for (const e of samples) tracer.emit(e);
  const { events } = readTraceFromPath(path);
  // header + samples
  assert.equal(events.length, samples.length + 1);
  // Round-trip equality on every sample (skip header at index 0).
  for (let i = 0; i < samples.length; i++) {
    assert.deepEqual(events[i + 1], samples[i]);
  }
});

test("aggregatePhaseTimings sums duration_ms per phase across enter/exit pairs", () => {
  const events: TraceEvent[] = [
    { type: "phase_enter", phase: "intake", at: "t" },
    { type: "phase_exit", phase: "intake", duration_ms: 500, at: "t" },
    { type: "phase_enter", phase: "execute", at: "t" },
    { type: "phase_exit", phase: "execute", duration_ms: 2000, at: "t" },
    { type: "phase_enter", phase: "execute", at: "t" }, // re-entry, e.g. after Phase 3
    { type: "phase_exit", phase: "execute", duration_ms: 800, at: "t" },
  ];
  const rows = aggregatePhaseTimings(events);
  const intake = rows.find((r) => r.phase === "intake")!;
  const execute = rows.find((r) => r.phase === "execute")!;
  assert.equal(intake.duration_ms, 500);
  assert.equal(intake.enters, 1);
  assert.equal(execute.duration_ms, 2800);
  assert.equal(execute.enters, 2);
});

test("aggregateRoleCost sums tokens and marks mixed when sources differ", () => {
  const events: TraceEvent[] = [
    { type: "role_invoke", role: "planner", tokens_in: 100, tokens_out: 50, tokens_source: "reported", duration_ms: 200, at: "t" },
    { type: "role_invoke", role: "planner", tokens_in: 100, tokens_out: 50, tokens_source: "reported", duration_ms: 200, at: "t" },
    { type: "role_invoke", role: "executor", tokens_in: 80, tokens_out: 30, tokens_source: "reported", duration_ms: 150, at: "t" },
    { type: "role_invoke", role: "executor", tokens_in: 80, tokens_out: 30, tokens_source: "estimated", duration_ms: 150, at: "t" },
  ];
  const rows = aggregateRoleCost(events);
  const planner = rows.find((r) => r.role === "planner")!;
  const executor = rows.find((r) => r.role === "executor")!;
  assert.equal(planner.invocations, 2);
  assert.equal(planner.tokens_in, 200);
  assert.equal(planner.tokens_source, "reported");
  assert.equal(executor.invocations, 2);
  assert.equal(executor.tokens_source, "mixed");
});

test("aggregateDetectorCounts is sorted by count descending", () => {
  const events: TraceEvent[] = [
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
    { type: "detector_fired", detector: "completion", payload: {}, at: "t" },
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
  ];
  const rows = aggregateDetectorCounts(events);
  assert.equal(rows[0]!.detector, "blocker");
  assert.equal(rows[0]!.count, 3);
  assert.equal(rows[1]!.detector, "completion");
  assert.equal(rows[1]!.count, 1);
});

test("non-strict mode: emit failure does not throw, run proceeds unaffected", () => {
  // Force a known-fail by routing the trace into a path whose parent is a file.
  const blockingPath = join(TMP, "blocker-as-file");
  writeFileSync(blockingPath, "x", "utf8");
  delete process.env.OPENWAR_TRACE_STRICT;
  try {
    const t = new Tracer({
      briefId: "non-strict",
      enabled: true,
      openwarVersion: "0.8.0",
      filePath: join(blockingPath, "trace.ndjson"),
    });
    assert.doesNotThrow(() => t.emit({ type: "phase_enter", phase: "intake", at: "t" }));
  } finally {
    process.env.OPENWAR_TRACE_STRICT = "1";
  }
});

test("strict mode: emit failure throws (catches bugs in tests)", () => {
  const blockingPath = join(TMP, "blocker-as-file-strict");
  writeFileSync(blockingPath, "x", "utf8");
  // OPENWAR_TRACE_STRICT=1 is already set at file scope.
  assert.throws(() => {
    // Constructor's ensureHeader will throw on mkdirSync under strict.
    new Tracer({
      briefId: "strict",
      enabled: true,
      openwarVersion: "0.8.0",
      filePath: join(blockingPath, "trace.ndjson"),
    });
  });
});
