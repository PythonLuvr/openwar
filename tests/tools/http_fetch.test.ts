import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { httpFetchExecutor, HTTP_FETCH_DEFINITION } from "../../src/tools/native/http_fetch.js";
import { buildAllowlist } from "../../src/sandbox/host-allowlist.js";
import { SandboxContext } from "../../src/sandbox/types.js";
import { makeCall, freshWorkdir, cleanupWorkdir } from "./helpers.js";

function startServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function ctxWithAllowlist(workdir: string, allowedHost: string | null) {
  return SandboxContext._create({
    workdir,
    defaultTimeoutMs: 5000,
    defaultMaxOutputBytes: 1_000_000,
    httpAllowlist: allowedHost === null ? null : buildAllowlist([allowedHost]),
    shellEnabled: true,
  });
}

test("http_fetch definition: http_fetch category", () => {
  assert.deepEqual(HTTP_FETCH_DEFINITION.authorization_categories, ["http_fetch"]);
});

test("http_fetch GETs from a local server", async () => {
  const wd = await freshWorkdir();
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pong");
  });
  try {
    const r = await httpFetchExecutor(
      makeCall("http_fetch", { url: `http://127.0.0.1:${port}/ping` }),
      ctxWithAllowlist(wd, null),
    );
    assert.equal(r.success, true);
    const body = JSON.parse(r.content) as { status: number; body: string };
    assert.equal(body.status, 200);
    assert.equal(body.body, "pong");
  } finally {
    server.close();
    await cleanupWorkdir(wd);
  }
});

test("http_fetch refuses non-HTTP schemes", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await httpFetchExecutor(
      makeCall("http_fetch", { url: "file:///etc/passwd" }),
      ctxWithAllowlist(wd, null),
    );
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "BAD_SCHEME");
  } finally { await cleanupWorkdir(wd); }
});

test("http_fetch refuses host not in allowlist", async () => {
  const wd = await freshWorkdir();
  const { server, port } = await startServer((_req, res) => res.end("ok"));
  try {
    const r = await httpFetchExecutor(
      makeCall("http_fetch", { url: `http://127.0.0.1:${port}/` }),
      ctxWithAllowlist(wd, "example.com"),
    );
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "HOST_NOT_ALLOWED");
  } finally {
    server.close();
    await cleanupWorkdir(wd);
  }
});

test("http_fetch permits host in allowlist", async () => {
  const wd = await freshWorkdir();
  const { server, port } = await startServer((_req, res) => res.end("ok"));
  try {
    const r = await httpFetchExecutor(
      makeCall("http_fetch", { url: `http://127.0.0.1:${port}/` }),
      ctxWithAllowlist(wd, "127.0.0.1"),
    );
    assert.equal(r.success, true);
  } finally {
    server.close();
    await cleanupWorkdir(wd);
  }
});

test("http_fetch caps body at max_bytes", async () => {
  const wd = await freshWorkdir();
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("0123456789".repeat(100));
  });
  try {
    const r = await httpFetchExecutor(
      makeCall("http_fetch", { url: `http://127.0.0.1:${port}/`, max_bytes: 10 }),
      ctxWithAllowlist(wd, null),
    );
    assert.equal(r.success, true);
    const parsed = JSON.parse(r.content) as { body: string; truncated: boolean };
    assert.equal(parsed.body.length, 10);
    assert.equal(parsed.truncated, true);
  } finally {
    server.close();
    await cleanupWorkdir(wd);
  }
});

test("http_fetch invalid URL", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await httpFetchExecutor(makeCall("http_fetch", { url: "not a url" }), ctxWithAllowlist(wd, null));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_URL");
  } finally { await cleanupWorkdir(wd); }
});

test("http_fetch invalid args", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await httpFetchExecutor(makeCall("http_fetch", { method: "GET" }), ctxWithAllowlist(wd, null));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});
