// v0.12.0: permission_* trace event shapes + TRACE_SCHEMA_VERSION bump.

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

test("TRACE_SCHEMA_VERSION bumped to 3 for v0.12.0", () => {
  assert.equal(TRACE_SCHEMA_VERSION, 3);
});

test("trace header records schema version 3 after the v0.12 bump", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-perm-trace-"));
  try {
    const filePath = join(dir, "x.ndjson");
    new Tracer({ briefId: "x", enabled: true, openwarVersion: "0.12.0", filePath });
    const raw = await readFile(filePath, "utf8");
    const header = JSON.parse(raw.trim().split("\n")[0]!);
    assert.equal(header.type, "trace_version");
    assert.equal(header.version, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission_requested + permission_granted round-trip through tracer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-perm-trace-"));
  try {
    const filePath = join(dir, "y.ndjson");
    const t = new Tracer({ briefId: "y", enabled: true, openwarVersion: "0.12.0", filePath });
    const at = "2026-05-19T00:00:00.000Z";
    const reqEvent: TraceEvent = {
      type: "permission_requested",
      grant_id: "grant-1",
      action: "Delete legacy.ts",
      category: "filesystem_write",
      scope_requested: "this_call",
      reasoning: "unreferenced",
      fallback: null,
      at,
    };
    const grantEvent: TraceEvent = {
      type: "permission_granted",
      grant_id: "grant-1",
      scope_granted: "this_call",
      operator_note: "",
      at,
    };
    t.emit(reqEvent);
    t.emit(grantEvent);
    const read = readTraceFromPath(filePath);
    const requested = read.events.filter((e) => e.type === "permission_requested");
    const granted = read.events.filter((e) => e.type === "permission_granted");
    assert.equal(requested.length, 1);
    assert.equal(granted.length, 1);
    assert.deepEqual(requested[0], reqEvent);
    assert.deepEqual(granted[0], grantEvent);
    assert.equal(read.corrupted_lines.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission_denied event round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-perm-trace-"));
  try {
    const filePath = join(dir, "z.ndjson");
    const t = new Tracer({ briefId: "z", enabled: true, openwarVersion: "0.12.0", filePath });
    t.emit({
      type: "permission_denied",
      grant_id: "g-2",
      operator_note: "not safe yet",
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const denied = read.events.filter((e) => e.type === "permission_denied");
    assert.equal(denied.length, 1);
    assert.equal((denied[0] as { operator_note: string }).operator_note, "not safe yet");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission_grant_consumed carries consuming_tool_call_id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-perm-trace-"));
  try {
    const filePath = join(dir, "c.ndjson");
    const t = new Tracer({ briefId: "c", enabled: true, openwarVersion: "0.12.0", filePath });
    t.emit({
      type: "permission_grant_consumed",
      grant_id: "g-3",
      consuming_tool_call_id: "call-xyz",
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const consumed = read.events.filter((e) => e.type === "permission_grant_consumed");
    assert.equal(consumed.length, 1);
    assert.equal((consumed[0] as { consuming_tool_call_id: string }).consuming_tool_call_id, "call-xyz");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permission_revoked event ships as fifth variant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-perm-trace-"));
  try {
    const filePath = join(dir, "r.ndjson");
    const t = new Tracer({ briefId: "r", enabled: true, openwarVersion: "0.12.0", filePath });
    t.emit({
      type: "permission_revoked",
      grant_id: "g-4",
      revoked_at: "2026-05-19T01:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const revoked = read.events.filter((e) => e.type === "permission_revoked");
    assert.equal(revoked.length, 1);
    assert.equal((revoked[0] as { revoked_at: string }).revoked_at, "2026-05-19T01:00:00Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
