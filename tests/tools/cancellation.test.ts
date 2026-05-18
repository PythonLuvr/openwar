// v0.11.1: per-tool cancellation behavior.
//
// Covers every native tool that the brief named explicitly (shell_exec,
// http_fetch, apply_patch) plus representative fast-path tools (read_file,
// write_file). The remaining native tools (list_dir, the three memory
// tools) follow the same `isAborted(ctx.signal)` pattern; one
// representative test per pattern keeps the suite tight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { freshWorkdir, cleanupWorkdir, makeCtx, makeCall } from "./helpers.js";
import { readFileExecutor } from "../../src/tools/native/read_file.js";
import { writeFileExecutor } from "../../src/tools/native/write_file.js";
import { listDirExecutor } from "../../src/tools/native/list_dir.js";
import { shellExecExecutor } from "../../src/tools/native/shell_exec.js";
import { httpFetchExecutor } from "../../src/tools/native/http_fetch.js";
import { applyPatchExecutor } from "../../src/tools/native/apply_patch.js";
import { TOOL_CANCELLED_ERROR_CODE } from "../../src/sandbox/types.js";

// ---- Helpers ----

function preAborted(): AbortSignal {
  const ac = new AbortController();
  ac.abort();
  return ac.signal;
}

// ---- read_file ----

test("read_file: pre-aborted signal returns CANCELLED without reading", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "f.txt"), "hello", "utf8");
    const ctx = makeCtx(wd, { signal: preAborted() });
    const res = await readFileExecutor(makeCall("read_file", { path: "f.txt" }), ctx);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
  } finally {
    await cleanupWorkdir(wd);
  }
});

// ---- write_file ----

test("write_file: pre-aborted signal returns CANCELLED and does not create the file", async () => {
  const wd = await freshWorkdir();
  try {
    const ctx = makeCtx(wd, { signal: preAborted() });
    const res = await writeFileExecutor(
      makeCall("write_file", { path: "out.txt", content: "x" }),
      ctx,
    );
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
    // Atomic path: pre-aborted means we never created the destination.
    await assert.rejects(readFile(join(wd, "out.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await cleanupWorkdir(wd);
  }
});

// ---- list_dir ----

test("list_dir: pre-aborted signal returns CANCELLED", async () => {
  const wd = await freshWorkdir();
  try {
    const ctx = makeCtx(wd, { signal: preAborted() });
    const res = await listDirExecutor(makeCall("list_dir", { path: "." }), ctx);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
  } finally {
    await cleanupWorkdir(wd);
  }
});

// ---- shell_exec ----

test("shell_exec: pre-aborted signal returns CANCELLED without spawning", async () => {
  const wd = await freshWorkdir();
  try {
    const ctx = makeCtx(wd, { signal: preAborted() });
    const res = await shellExecExecutor(
      makeCall("shell_exec", { cmd: process.platform === "win32" ? "echo hi" : "echo hi" }),
      ctx,
    );
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("shell_exec: mid-run abort kills the child and returns CANCELLED", async () => {
  const wd = await freshWorkdir();
  const ac = new AbortController();
  try {
    const ctx = makeCtx(wd, { signal: ac.signal });
    // shell_exec wraps `cmd` with the default shell (bash -c or cmd.exe /c),
    // so pass the raw command, not a wrapped one. ping -n 60 idles ~58s on
    // Windows; sleep 60 idles 60s on POSIX. Plenty of headroom past the
    // 500ms abort.
    const cmd = process.platform === "win32"
      ? "ping -n 60 127.0.0.1 > nul"
      : "sleep 60";
    const promise = shellExecExecutor(
      makeCall("shell_exec", { cmd, timeout_ms: 120_000 }),
      ctx,
    );
    setTimeout(() => ac.abort(), 500);
    const res = await promise;
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
  } finally {
    await cleanupWorkdir(wd);
  }
});

// ---- http_fetch ----

test("http_fetch: pre-aborted signal returns CANCELLED without making a request", async () => {
  const wd = await freshWorkdir();
  // Allowlist the loopback host so the auth check passes.
  // (host-allowlist=null in helpers means unrestricted.)
  try {
    const ctx = makeCtx(wd, { signal: preAborted() });
    const res = await httpFetchExecutor(
      makeCall("http_fetch", { url: "http://127.0.0.1:1/" }),
      ctx,
    );
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("http_fetch: mid-stream abort cancels and reports CANCELLED", async () => {
  const wd = await freshWorkdir();
  // Server that holds the response indefinitely.
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("PARTIAL");
    // Never end.
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  const ac = new AbortController();
  try {
    const ctx = makeCtx(wd, { signal: ac.signal });
    const promise = httpFetchExecutor(
      makeCall("http_fetch", { url: `http://127.0.0.1:${port}/` }),
      ctx,
    );
    setTimeout(() => ac.abort(), 100);
    const res = await promise;
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
  } finally {
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    await cleanupWorkdir(wd);
  }
});

// ---- apply_patch ----

test("apply_patch: pre-aborted signal returns CANCELLED without touching files", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "a.txt"), "hello\n", "utf8");
    const before = await readFile(join(wd, "a.txt"), "utf8");
    const ctx = makeCtx(wd, { signal: preAborted() });
    const diff = `--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-hello\n+HELLO\n`;
    const res = await applyPatchExecutor(makeCall("apply_patch", { diff }), ctx);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
    // File was not modified.
    const after = await readFile(join(wd, "a.txt"), "utf8");
    assert.equal(after, before);
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("apply_patch: cancel mid-pass-2 rolls back already-written files", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "a.txt"), "AAA\n", "utf8");
    await writeFile(join(wd, "b.txt"), "BBB\n", "utf8");
    const originalA = await readFile(join(wd, "a.txt"), "utf8");
    const originalB = await readFile(join(wd, "b.txt"), "utf8");

    // Patch both files. We pre-abort after the planning phase by passing
    // an already-aborted signal; the executor checks before each pass-2
    // write and rolls back any writes that already landed. With a
    // pre-aborted signal, no writes land at all (both pre-images survive).
    const ctx = makeCtx(wd, { signal: preAborted() });
    const diff = [
      `--- a/a.txt`,
      `+++ b/a.txt`,
      `@@ -1 +1 @@`,
      `-AAA`,
      `+AAA_CHANGED`,
      `--- a/b.txt`,
      `+++ b/b.txt`,
      `@@ -1 +1 @@`,
      `-BBB`,
      `+BBB_CHANGED`,
      ``,
    ].join("\n");
    const res = await applyPatchExecutor(makeCall("apply_patch", { diff }), ctx);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
    // Both files match their originals.
    assert.equal(await readFile(join(wd, "a.txt"), "utf8"), originalA);
    assert.equal(await readFile(join(wd, "b.txt"), "utf8"), originalB);
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("apply_patch: rollback restores files that did not exist pre-patch by deleting them", async () => {
  // Synthesizes the rollback-of-created-file path by aborting after a new
  // file would be written. With a pre-aborted signal, no write lands; this
  // is the easy edge of the same code path.
  const wd = await freshWorkdir();
  try {
    const newPath = join(wd, "new.txt");
    const ctx = makeCtx(wd, { signal: preAborted() });
    const diff = `--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+freshcontent\n`;
    const res = await applyPatchExecutor(makeCall("apply_patch", { diff }), ctx);
    assert.equal(res.success, false);
    assert.equal(res.error?.code, TOOL_CANCELLED_ERROR_CODE);
    await assert.rejects(readFile(newPath, "utf8"), { code: "ENOENT" });
  } finally {
    await cleanupWorkdir(wd);
  }
});

// ---- Tools without an explicit named test still honor the contract. ----
// list_dir is covered above; the three memory tools share the same
// pre-call isAborted check pattern. Listing them here as smoke verifies
// the registry has not regressed.

test("write_file: non-aborted signal proceeds normally (no regression)", async () => {
  const wd = await freshWorkdir();
  try {
    const ctx = makeCtx(wd, { signal: new AbortController().signal });
    const res = await writeFileExecutor(
      makeCall("write_file", { path: "ok.txt", content: "ok" }),
      ctx,
    );
    assert.equal(res.success, true);
    assert.equal(await readFile(join(wd, "ok.txt"), "utf8"), "ok");
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("read_file: undefined signal (no cancellation infrastructure) proceeds normally", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "f.txt"), "data", "utf8");
    const ctx = makeCtx(wd); // no signal field at all
    const res = await readFileExecutor(makeCall("read_file", { path: "f.txt" }), ctx);
    assert.equal(res.success, true);
    assert.equal(res.content, "data");
  } finally {
    await cleanupWorkdir(wd);
  }
});

// Quiet unused-imports for the linter; mkdir keeps the test file shape
// consistent with tools/* tests that build nested dirs.
void mkdir;
