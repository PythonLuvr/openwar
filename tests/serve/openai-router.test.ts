// v0.13.0: openwar serve --openai-compat end-to-end through an in-process
// HTTP server bound to ephemeral port 0. Uses the published MockAdapter
// as the upstream so tests are deterministic and free of network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../../src/serve/server.js";
import type { ServeOptions } from "../../src/serve/types.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import { readTraceFromPath } from "../../src/state/trace.js";

const TOKEN = "test-token-123";
const BASE_OPTS: ServeOptions = {
  openaiCompat: true,
  bind: "127.0.0.1",
  port: 0,
  authToken: TOKEN,
  noAuth: false,
  upstreamAdapter: null,
  upstreamModel: null,
  workdir: process.cwd(),
  authorizedCosts: ["filesystem_read"],
  maxConcurrent: 4,
  logRequests: false,
};

async function withServer<T>(
  options: Partial<ServeOptions>,
  scriptedReplies: string[],
  fn: (url: string, traceDir: string) => Promise<T>,
): Promise<T> {
  const traceDir = await mkdtemp(join(tmpdir(), "openwar-proxy-trace-"));
  const adapter = new MockAdapter(scriptedReplies);
  const handle = await startServer({
    options: { ...BASE_OPTS, ...options },
    upstream: adapter,
    openwarVersion: "test",
    traceFilePath: (id) => join(traceDir, `${id}.trace.ndjson`),
  });
  try {
    return await fn(`http://${handle.address.host}:${handle.address.port}`, traceDir);
  } finally {
    await handle.close({ drainMs: 200 });
    await rm(traceDir, { recursive: true, force: true });
  }
}

// ---- /healthz ----

test("GET /healthz returns 200 ok without auth", async () => {
  await withServer({}, [], async (url) => {
    const r = await fetch(`${url}/healthz`);
    assert.equal(r.status, 200);
    const body = await r.json() as { status: string };
    assert.equal(body.status, "ok");
  });
});

// ---- auth gate ----

test("POST /v1/chat/completions without auth -> 401", async () => {
  await withServer({}, ["hi"], async (url) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openwar", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 401);
  });
});

test("--no-auth mode skips bearer check", async () => {
  await withServer({ noAuth: true, authToken: null }, ["hello"], async (url) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openwar", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 200);
  });
});

// ---- /v1/models ----

test("GET /v1/models returns a single configured-upstream model entry", async () => {
  await withServer({ upstreamModel: "claude-opus-4-7" }, [], async (url) => {
    const r = await fetch(`${url}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { object: string; data: Array<{ id: string }> };
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]!.id, "claude-opus-4-7");
  });
});

// ---- 404 fallback ----

test("unknown path -> 404 in OpenAI error shape", async () => {
  await withServer({}, [], async (url) => {
    const r = await fetch(`${url}/random/path`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(r.status, 404);
    const body = await r.json() as { error: { type: string } };
    assert.equal(body.error.type, "invalid_request_error");
  });
});

// ---- non-streaming chat completion ----

test("non-streaming POST returns chat.completion with assistant text", async () => {
  await withServer({}, ["the answer is 42"], async (url) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openwar", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("x-openwar-trace-id") ?? "", /^proxy-/);
    const body = await r.json() as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0]!.message.role, "assistant");
    assert.match(body.choices[0]!.message.content, /the answer is 42/);
    assert.equal(body.choices[0]!.finish_reason, "stop");
  });
});

// ---- streaming chat completion ----

test("streaming POST returns SSE chunks ending with data: [DONE]", async () => {
  await withServer({}, ["streaming-reply"], async (url) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "openwar",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /data: \[DONE\]\n\n$/);
    assert.match(text, /"delta":\{"role":"assistant"/);
    assert.match(text, /"finish_reason":"stop"/);
  });
});

// ---- request validation ----

test("invalid JSON body -> 400 with openwar_bad_json code", async () => {
  await withServer({}, [], async (url) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "openwar_bad_json");
  });
});

test("missing model -> 400 missing_model", async () => {
  await withServer({}, [], async (url) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r.status, 400);
    const body = await r.json() as { error: { code: string } };
    assert.equal(body.error.code, "missing_model");
  });
});

// ---- max-concurrent gate ----

test("max-concurrent exceeded -> 429 rate_limit_error", async () => {
  // Hand-construct a never-resolving adapter so we can stack up requests
  // beyond the gate. The MockAdapter resolves immediately, which would
  // race the second request through before the first occupies the slot.
  class StallingAdapter extends MockAdapter {
    override readonly id = "stall";
    constructor() { super([]); }
    override async *sendMessage() {
      await new Promise<void>(() => { /* never */ });
      yield { type: "done" as const, message: "" };
    }
  }
  const adapter = new StallingAdapter();
  const traceDir = await mkdtemp(join(tmpdir(), "openwar-proxy-trace-"));
  const handle = await startServer({
    options: { ...BASE_OPTS, maxConcurrent: 1 },
    upstream: adapter,
    openwarVersion: "test",
    traceFilePath: (id) => join(traceDir, `${id}.trace.ndjson`),
  });
  const url = `http://${handle.address.host}:${handle.address.port}`;
  try {
    // First request occupies the only slot and never completes.
    const first = fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openwar", messages: [{ role: "user", content: "hi" }] }),
    });
    // Tick the event loop so the first request acquires the slot.
    await new Promise<void>((r) => setTimeout(r, 50));
    const second = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openwar", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(second.status, 429);
    const body = await second.json() as { error: { code: string } };
    assert.equal(body.error.code, "openwar_max_concurrent");
    // Force-close drops the stalled first request.
    void first.catch(() => {});
  } finally {
    await handle.close({ drainMs: 100 });
    await rm(traceDir, { recursive: true, force: true });
  }
});
