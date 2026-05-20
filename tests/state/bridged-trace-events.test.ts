// v0.12.1: bridged_* trace event shapes + TRACE_SCHEMA_VERSION 4 bump.

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

test("TRACE_SCHEMA_VERSION reflects the additive bumps through v0.12.1+", () => {
  // v0.12.1 introduced bridged_* at version 4; later versions add more
  // additive event types. Anchor only on the floor.
  assert.ok(TRACE_SCHEMA_VERSION >= 4);
});

test("trace header records the current TRACE_SCHEMA_VERSION", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-bridged-trace-"));
  try {
    const filePath = join(dir, "x.ndjson");
    new Tracer({ briefId: "x", enabled: true, openwarVersion: "0.12.1", filePath });
    const raw = await readFile(filePath, "utf8");
    const header = JSON.parse(raw.trim().split("\n")[0]!);
    assert.equal(header.type, "trace_version");
    assert.equal(header.version, TRACE_SCHEMA_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridged_tool_call round-trips through tracer + readTraceFromPath", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-bridged-trace-"));
  try {
    const filePath = join(dir, "y.ndjson");
    const t = new Tracer({ briefId: "y", enabled: true, openwarVersion: "0.12.1", filePath });
    const ev: TraceEvent = {
      type: "bridged_tool_call",
      call_id: "toolu_01",
      tool_name: "Glob",
      arguments: { pattern: "*" },
      binary: "claude",
      at: "2026-05-19T00:00:00.000Z",
    };
    t.emit(ev);
    const read = readTraceFromPath(filePath);
    const found = read.events.filter((e) => e.type === "bridged_tool_call");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], ev);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridged_tool_result with is_error=true round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-bridged-trace-"));
  try {
    const filePath = join(dir, "y.ndjson");
    const t = new Tracer({ briefId: "y", enabled: true, openwarVersion: "0.12.1", filePath });
    t.emit({
      type: "bridged_tool_result",
      call_id: "toolu_01",
      result: { error: "permission denied" },
      is_error: true,
      binary: "claude",
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const found = read.events.filter((e) => e.type === "bridged_tool_result");
    assert.equal(found.length, 1);
    assert.equal((found[0] as { is_error: boolean }).is_error, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridged_thinking_delta carries delta + binary fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-bridged-trace-"));
  try {
    const filePath = join(dir, "t.ndjson");
    const tr = new Tracer({ briefId: "t", enabled: true, openwarVersion: "0.12.1", filePath });
    tr.emit({
      type: "bridged_thinking_delta",
      delta: "Let me consider the request.",
      binary: "claude",
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const found = read.events.filter((e) => e.type === "bridged_thinking_delta");
    assert.equal(found.length, 1);
    assert.equal((found[0] as { binary: string }).binary, "claude");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridged_usage round-trip preserves cache fields separately from input/output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-bridged-trace-"));
  try {
    const filePath = join(dir, "u.ndjson");
    const tr = new Tracer({ briefId: "u", enabled: true, openwarVersion: "0.12.1", filePath });
    tr.emit({
      type: "bridged_usage",
      binary: "claude",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 1000,
      cache_write_tokens: 200,
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const found = read.events.filter((e) => e.type === "bridged_usage") as Extract<TraceEvent, { type: "bridged_usage" }>[];
    assert.equal(found.length, 1);
    assert.equal(found[0]!.input_tokens, 100);
    assert.equal(found[0]!.output_tokens, 50);
    assert.equal(found[0]!.cache_read_tokens, 1000);
    assert.equal(found[0]!.cache_write_tokens, 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridged_usage with no token fields still round-trips (vendor surfaced no counters)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-bridged-trace-"));
  try {
    const filePath = join(dir, "u2.ndjson");
    const tr = new Tracer({ briefId: "u2", enabled: true, openwarVersion: "0.12.1", filePath });
    tr.emit({
      type: "bridged_usage",
      binary: "gemini",
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const found = read.events.filter((e) => e.type === "bridged_usage");
    assert.equal(found.length, 1);
    assert.equal((found[0] as { binary: string }).binary, "gemini");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
