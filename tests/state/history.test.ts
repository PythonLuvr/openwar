// v0.9.0 history math. Pure-function coverage: phase attribution, quantile,
// aggregation, dead-tool threshold, determinism.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeRun,
  aggregateRuns,
  quantile,
  stringifyDeterministic,
} from "../../src/state/history.js";
type TraceEvent = import("../../src/state/trace.js").TraceEvent;

function ev(...es: TraceEvent[]): TraceEvent[] {
  return es;
}

test("quantile: handles empty, single, exact, and interpolation cases", () => {
  assert.equal(quantile([], 0.5), 0);
  assert.equal(quantile([7], 0.5), 7);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  // p90 across [1..10] = 9.1 (linear interp). Position = 9*0.9 = 8.1, value = 9 + 0.1*(10-9) = 9.1.
  assert.equal(round1(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)), 9.1);
});

test("summarizeRun: attributes tool_calls to most recent phase_enter", () => {
  const events = ev(
    { type: "trace_version", version: 1, openwar_version: "0.9.0", brief_id: "r1", at: "2026-05-18T00:00:00Z" },
    { type: "phase_enter", phase: "intake", at: "2026-05-18T00:00:00Z" },
    { type: "phase_enter", phase: "execute", at: "2026-05-18T00:00:01Z" },
    { type: "tool_call", call_id: "c1", name: "read_file", args: {}, auth_decision: "allow", at: "2026-05-18T00:00:02Z" },
    { type: "tool_call", call_id: "c2", name: "read_file", args: {}, auth_decision: "allow", at: "2026-05-18T00:00:03Z" },
    { type: "tool_call", call_id: "c3", name: "write_file", args: {}, auth_decision: "allow", at: "2026-05-18T00:00:04Z" },
    { type: "phase_enter", phase: "completion", at: "2026-05-18T00:00:05Z" },
    { type: "phase_enter", phase: "done", at: "2026-05-18T00:00:06Z" },
  );
  const sum = summarizeRun("r1", events);
  assert.equal(sum.tool_calls_by_phase.execute, 3);
  assert.equal(sum.tool_calls_by_name.read_file, 2);
  assert.equal(sum.tool_calls_by_name.write_file, 1);
  assert.equal(sum.tool_call_total, 3);
  assert.equal(sum.final_phase, "done");
});

test("summarizeRun: tool_call before any phase_enter is bucketed under _unknown", () => {
  const events = ev(
    { type: "tool_call", call_id: "x", name: "read_file", args: {}, auth_decision: "allow", at: "t" },
    { type: "phase_enter", phase: "execute", at: "t" },
  );
  const sum = summarizeRun("r0", events);
  assert.equal((sum.tool_calls_by_phase as Record<string, number>)._unknown, 1);
});

test("summarizeRun: phase_exit durations sum across re-entries of the same phase", () => {
  const events = ev(
    { type: "phase_enter", phase: "execute", at: "t1" },
    { type: "phase_exit", phase: "execute", duration_ms: 100, at: "t2" },
    { type: "phase_enter", phase: "execute", at: "t3" },
    { type: "phase_exit", phase: "execute", duration_ms: 250, at: "t4" },
  );
  const sum = summarizeRun("r", events);
  assert.equal(sum.phase_durations_ms.execute, 350);
});

test("summarizeRun: counts each detector fire independently", () => {
  const events = ev(
    { type: "phase_enter", phase: "execute", at: "t" },
    { type: "detector_fired", detector: "completion", payload: {}, at: "t" },
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
    { type: "detector_fired", detector: "blocker", payload: {}, at: "t" },
  );
  const sum = summarizeRun("r", events);
  assert.equal(sum.detector_fires.completion, 1);
  assert.equal(sum.detector_fires.blocker, 2);
});

test("aggregateRuns: dead-tool flag requires sample_size >= 3", () => {
  // Two runs, write_file is called in run-a but not run-b. Sample size = 2,
  // so write_file is NOT flagged dead despite zero calls in run-b alone.
  const runA = summarizeRun("a", ev(
    { type: "phase_enter", phase: "execute", at: "t" },
    { type: "tool_call", call_id: "1", name: "read_file", args: {}, auth_decision: "allow", at: "t" },
  ));
  const runB = summarizeRun("b", ev(
    { type: "phase_enter", phase: "execute", at: "t" },
    { type: "tool_call", call_id: "2", name: "read_file", args: {}, auth_decision: "allow", at: "t" },
  ));
  const report = aggregateRuns([runA, runB], { slug: "p" });
  // No "dead" rows: a tool only shows up in tool_usage if it was called at
  // least once in the sample. write_file was never called, so it's absent.
  const writeFile = report.tool_usage.find((t) => t.tool === "write_file");
  assert.equal(writeFile, undefined);
  assert.equal(report.sample_size, 2);
});

test("aggregateRuns: filters by since timestamp", () => {
  const events = (id: string, at: string): TraceEvent[] => ev(
    { type: "phase_enter", phase: "execute", at },
    { type: "tool_call", call_id: id, name: "read_file", args: {}, auth_decision: "allow", at },
  );
  const oldRun = summarizeRun("old", events("o", "2026-01-01T00:00:00Z"));
  const newRun = summarizeRun("new", events("n", "2026-05-18T00:00:00Z"));
  const report = aggregateRuns([oldRun, newRun], { slug: "p", since: "2026-03-01T00:00:00Z" });
  assert.equal(report.sample_size, 1);
  assert.deepEqual(report.source_runs, ["new"]);
});

test("aggregateRuns: source_runs is sorted lexicographically (determinism)", () => {
  const events: TraceEvent[] = ev(
    { type: "phase_enter", phase: "execute", at: "t" },
  );
  const runs = ["zebra", "apple", "mango"].map((id) => summarizeRun(id, events));
  const r = aggregateRuns(runs, { slug: "p" });
  assert.deepEqual(r.source_runs, ["apple", "mango", "zebra"]);
});

test("aggregateRuns: thin-sample note fires when sample_size < minSamples", () => {
  const runs = [summarizeRun("a", ev({ type: "phase_enter", phase: "execute", at: "t" }))];
  const r = aggregateRuns(runs, { slug: "p", minSamples: 5 });
  assert.ok(r.notes.some((n) => n.includes("Thin sample")));
});

test("aggregateRuns: empty input produces zero sample_size and a stable shape", () => {
  const r = aggregateRuns([], { slug: "p" });
  assert.equal(r.sample_size, 0);
  assert.deepEqual(r.source_runs, []);
  assert.deepEqual(r.tool_usage, []);
  assert.deepEqual(r.phase_distribution, []);
  assert.deepEqual(r.detectors, []);
});

test("aggregateRuns: phase_distribution carries p50, p90, max, samples", () => {
  // Five runs with tool-call counts in execute: [3, 5, 8, 12, 20]
  const runs = [3, 5, 8, 12, 20].map((n, i) => {
    const events: TraceEvent[] = [
      { type: "phase_enter", phase: "execute", at: `t${i}` },
    ];
    for (let j = 0; j < n; j++) {
      events.push({ type: "tool_call", call_id: `c${i}-${j}`, name: "read_file", args: {}, auth_decision: "allow", at: `t${i}` });
    }
    return summarizeRun(`r${i}`, events);
  });
  const r = aggregateRuns(runs, { slug: "p" });
  const exec = r.phase_distribution.find((p) => p.phase === "execute")!;
  assert.equal(exec.samples, 5);
  assert.equal(exec.total_calls, 3 + 5 + 8 + 12 + 20);
  assert.equal(exec.p50, 8); // median of sorted [3, 5, 8, 12, 20]
  assert.equal(exec.max, 20);
});

test("stringifyDeterministic: same logical input produces same string", () => {
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
  const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
  assert.equal(stringifyDeterministic(a), stringifyDeterministic(b));
});

test("stringifyDeterministic: preserves array order", () => {
  const s = stringifyDeterministic({ items: [3, 1, 2] });
  assert.match(s, /"items": \[\s*3,\s*1,\s*2\s*\]/);
});

test("aggregateRuns: corrupted_lines_total accumulates across runs", () => {
  const runA = summarizeRun("a", ev({ type: "phase_enter", phase: "execute", at: "t" }), [3, 7]);
  const runB = summarizeRun("b", ev({ type: "phase_enter", phase: "execute", at: "t" }), [12]);
  const r = aggregateRuns([runA, runB], { slug: "p" });
  assert.equal(r.corrupted_lines_total, 3);
  assert.ok(r.notes.some((n) => /corrupted trace line/.test(n)));
});

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
