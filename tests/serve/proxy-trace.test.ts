// v0.13.0: proxy_request + proxy_response trace events round-trip
// through the tracer and the in-process server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TRACE_SCHEMA_VERSION,
  Tracer,
  readTraceFromPath,
  type TraceEvent,
} from "../../src/state/trace.js";
import { startServer } from "../../src/serve/server.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import type { ServeOptions } from "../../src/serve/types.js";

test("TRACE_SCHEMA_VERSION bumped to 5 (or higher) for v0.13.0 proxy_* events", () => {
  assert.ok(TRACE_SCHEMA_VERSION >= 5);
});

test("proxy_request round-trip via tracer + readTraceFromPath", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-proxy-trace-"));
  try {
    const filePath = join(dir, "proxy-1.trace.ndjson");
    const t = new Tracer({ briefId: "proxy-1", enabled: true, openwarVersion: "0.13.0", filePath });
    const ev: TraceEvent = {
      type: "proxy_request",
      request_id: "proxy-1",
      client_addr: "127.0.0.1:54321",
      model: "openwar",
      stream: true,
      tool_count: 0,
      at: "2026-05-19T00:00:00.000Z",
    };
    t.emit(ev);
    const read = readTraceFromPath(filePath);
    const found = read.events.filter((e) => e.type === "proxy_request");
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], ev);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proxy_request carries model_substituted_from when set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-proxy-trace-"));
  try {
    const filePath = join(dir, "p.trace.ndjson");
    const t = new Tracer({ briefId: "p", enabled: true, openwarVersion: "0.13.0", filePath });
    t.emit({
      type: "proxy_request",
      request_id: "p",
      client_addr: "127.0.0.1",
      model: "claude-opus-4-7",
      stream: false,
      tool_count: 0,
      model_substituted_from: "gpt-4",
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const ev = read.events.find((e) => e.type === "proxy_request") as
      | Extract<TraceEvent, { type: "proxy_request" }>
      | undefined;
    assert.equal(ev?.model_substituted_from, "gpt-4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("proxy_response captures status_code, duration_ms, bytes_written, cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-proxy-trace-"));
  try {
    const filePath = join(dir, "r.trace.ndjson");
    const t = new Tracer({ briefId: "r", enabled: true, openwarVersion: "0.13.0", filePath });
    t.emit({
      type: "proxy_response",
      request_id: "r",
      status_code: 200,
      duration_ms: 123,
      bytes_written: 4567,
      cancelled: false,
      at: "2026-05-19T00:00:00Z",
    });
    const read = readTraceFromPath(filePath);
    const ev = read.events.find((e) => e.type === "proxy_response") as
      | Extract<TraceEvent, { type: "proxy_response" }>
      | undefined;
    assert.ok(ev);
    assert.equal(ev!.status_code, 200);
    assert.equal(ev!.duration_ms, 123);
    assert.equal(ev!.bytes_written, 4567);
    assert.equal(ev!.cancelled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: server writes proxy_request + proxy_response per completed request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-proxy-trace-"));
  try {
    const adapter = new MockAdapter(["the answer"]);
    const opts: ServeOptions = {
      openaiCompat: true,
      bind: "127.0.0.1",
      port: 0,
      authToken: "tok",
      noAuth: false,
      upstreamAdapter: null,
      upstreamModel: null,
      workdir: process.cwd(),
      authorizedCosts: ["filesystem_read"],
      maxConcurrent: 4,
      logRequests: false,
    };
    const handle = await startServer({
      options: opts,
      upstream: adapter,
      openwarVersion: "test",
      traceFilePath: (id) => join(dir, `${id}.trace.ndjson`),
    });
    const url = `http://${handle.address.host}:${handle.address.port}`;
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ model: "openwar", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(r.status, 200);
    await r.text();
    await handle.close({ drainMs: 100 });

    const traceFiles = (await readdir(dir)).filter((f) => f.endsWith(".trace.ndjson"));
    assert.equal(traceFiles.length, 1);
    const raw = await readFile(join(dir, traceFiles[0]!), "utf8");
    const types = raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l).type as string);
    assert.ok(types.includes("proxy_request"), `trace lacks proxy_request: ${types.join(",")}`);
    assert.ok(types.includes("proxy_response"), `trace lacks proxy_response: ${types.join(",")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
