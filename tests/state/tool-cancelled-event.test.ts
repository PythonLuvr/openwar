// v0.11.1: tool_cancelled trace event shape + TRACE_SCHEMA_VERSION bump.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TRACE_SCHEMA_VERSION,
  Tracer,
  readTraceFromPath,
  type TraceEvent,
} from "../../src/state/trace.js";

test("TRACE_SCHEMA_VERSION reflects the additive bumps (v0.11.1=2, v0.12.0=3)", () => {
  assert.ok(TRACE_SCHEMA_VERSION >= 2);
});

test("trace header records the bumped schema version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-trace-cancel-"));
  try {
    const filePath = join(dir, "x.ndjson");
    new Tracer({ briefId: "x", enabled: true, openwarVersion: "0.11.1", filePath });
    const raw = await readFile(filePath, "utf8");
    const header = JSON.parse(raw.trim().split("\n")[0]!);
    assert.equal(header.type, "trace_version");
    assert.equal(header.version, TRACE_SCHEMA_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool_cancelled event round-trips through the tracer + readTraceFromPath", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-trace-cancel-"));
  try {
    const filePath = join(dir, "y.ndjson");
    const tracer = new Tracer({ briefId: "y", enabled: true, openwarVersion: "0.11.1", filePath });
    const ev: TraceEvent = {
      type: "tool_cancelled",
      call_id: "call_42",
      tool_name: "shell_exec",
      cancellation_source: "operator_signal",
      partial_output: "START\n",
      at: "2026-05-19T00:00:00.000Z",
    };
    tracer.emit(ev);
    const read = readTraceFromPath(filePath);
    const cancels = read.events.filter((e) => e.type === "tool_cancelled");
    assert.equal(cancels.length, 1);
    assert.deepEqual(cancels[0], ev);
    assert.equal(read.corrupted_lines.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool_cancelled supports all three cancellation_source variants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-trace-cancel-"));
  try {
    const filePath = join(dir, "z.ndjson");
    const tracer = new Tracer({ briefId: "z", enabled: true, openwarVersion: "0.11.1", filePath });
    const sources = ["operator_signal", "timeout", "runtime_shutdown"] as const;
    for (const source of sources) {
      tracer.emit({
        type: "tool_cancelled",
        call_id: `c_${source}`,
        tool_name: "http_fetch",
        cancellation_source: source,
        partial_output: "",
        at: new Date().toISOString(),
      });
    }
    const read = readTraceFromPath(filePath);
    const cancels = read.events.filter((e) => e.type === "tool_cancelled");
    assert.equal(cancels.length, 3);
    const seen = new Set(cancels.map((e) => (e as { cancellation_source: string }).cancellation_source));
    assert.deepEqual([...seen].sort(), ["operator_signal", "runtime_shutdown", "timeout"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTraceFromPath ignores unknown event types from a future schema version (forward-compat)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-trace-cancel-"));
  try {
    const filePath = join(dir, "future.ndjson");
    const tracer = new Tracer({ briefId: "future", enabled: true, openwarVersion: "0.11.1", filePath });
    tracer.emit({
      type: "tool_cancelled",
      call_id: "c1",
      tool_name: "shell_exec",
      cancellation_source: "operator_signal",
      partial_output: "",
      at: "2026-05-19T00:00:00.000Z",
    });
    // Hand-write a synthetic future event to verify the reader doesn't choke.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(filePath, JSON.stringify({ type: "future_event", payload: {} }) + "\n", "utf8");
    const read = readTraceFromPath(filePath);
    // Parser parses unknown types as TraceEvent (the union is open via JSON).
    // The contract is: no corruption, no throw.
    assert.equal(read.corrupted_lines.length, 0);
    assert.ok(read.events.length >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
