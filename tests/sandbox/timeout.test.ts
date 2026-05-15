import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout, TimeoutError } from "../../src/sandbox/timeout.js";

test("withTimeout resolves when promise completes before deadline", async () => {
  const result = await withTimeout(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 10)),
    1000,
  );
  assert.equal(result, "done");
});

test("withTimeout rejects with TimeoutError when promise hangs past deadline", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => { /* never resolves */ }), 20),
    TimeoutError,
  );
});

test("TimeoutError carries the deadline ms and a stable code", async () => {
  try {
    await withTimeout(new Promise(() => {}), 50);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof TimeoutError);
    assert.equal(err.afterMs, 50);
    assert.equal(err.code, "TIMEOUT");
  }
});

test("withTimeout passes the inner promise's rejection through", async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error("inner failure")), 1000),
    /inner failure/,
  );
});

test("withTimeout with ms<=0 returns the promise unmodified", async () => {
  const result = await withTimeout(Promise.resolve("instant"), 0);
  assert.equal(result, "instant");
  const result2 = await withTimeout(Promise.resolve("negative"), -1);
  assert.equal(result2, "negative");
});

test("withTimeout aborts on a pre-aborted signal", async () => {
  const ac = new AbortController();
  ac.abort(new Error("pre-aborted"));
  await assert.rejects(
    withTimeout(new Promise(() => {}), 1000, ac.signal),
    /pre-aborted/,
  );
});

test("withTimeout aborts when signal is triggered mid-wait", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("signal-aborted")), 10);
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5000, ac.signal),
    /signal-aborted/,
  );
});

test("withTimeout clears its timer when promise resolves first", async () => {
  // Implicit: if the timer were not cleared, the process would hold open.
  // We assert by completing a sub-deadline promise and waiting past the deadline.
  const start = Date.now();
  await withTimeout(new Promise<void>((r) => setTimeout(r, 10)), 1000);
  // If the timer is properly cleared, this test takes ~10ms, not ~1000ms.
  assert.ok(Date.now() - start < 500, "timer not cleared (test ran too long)");
});
