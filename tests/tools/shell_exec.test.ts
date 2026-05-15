import { test } from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:os";
import { shellExecExecutor, SHELL_EXEC_DEFINITION } from "../../src/tools/native/shell_exec.js";
import { freshWorkdir, cleanupWorkdir, makeCtx, makeCall } from "./helpers.js";

const isWin = platform() === "win32";

test("shell_exec definition: shell_exec category", () => {
  assert.deepEqual(SHELL_EXEC_DEFINITION.authorization_categories, ["shell_exec"]);
});

test("shell_exec runs a simple echo", async () => {
  const wd = await freshWorkdir();
  try {
    const cmd = isWin ? "echo hello" : "echo hello";
    const r = await shellExecExecutor(makeCall("shell_exec", { cmd }), makeCtx(wd));
    assert.equal(r.success, true);
    assert.match(r.content, /hello/);
  } finally { await cleanupWorkdir(wd); }
});

test("shell_exec captures non-zero exit code as failure", async () => {
  const wd = await freshWorkdir();
  try {
    const cmd = isWin ? "exit 7" : "exit 7";
    const r = await shellExecExecutor(makeCall("shell_exec", { cmd }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.meta?.exit_code, 7);
  } finally { await cleanupWorkdir(wd); }
});

test("shell_exec refuses when shellEnabled is false", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await shellExecExecutor(
      makeCall("shell_exec", { cmd: "echo x" }),
      makeCtx(wd, { shellEnabled: false }),
    );
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "SHELL_DISABLED");
  } finally { await cleanupWorkdir(wd); }
});

test("shell_exec rejects cwd escape", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await shellExecExecutor(makeCall("shell_exec", { cmd: "echo x", cwd: "../" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PATH_ESCAPE");
  } finally { await cleanupWorkdir(wd); }
});

test("shell_exec kills runaway process on timeout", async () => {
  const wd = await freshWorkdir();
  try {
    // Unquoted blocking commands: no shell-quote escaping needed.
    // timeout.exe on Windows exits immediately without a console; ping blocks.
    const cmd = isWin ? "ping -n 31 127.0.0.1 >nul" : "sleep 30";
    const start = Date.now();
    const r = await shellExecExecutor(
      makeCall("shell_exec", { cmd, timeout_ms: 200 }),
      makeCtx(wd),
    );
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "TIMEOUT");
    // Confirm we did not wait for the full 30s (kill plus grace under ~5s).
    assert.ok(Date.now() - start < 10_000, `kill took too long: ${Date.now() - start}ms`);
  } finally { await cleanupWorkdir(wd); }
});

test("shell_exec rejects invalid args", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await shellExecExecutor(makeCall("shell_exec", { cmd: "" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});
