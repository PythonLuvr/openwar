import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRetryPolicy } from "../../src/coordinator/retry-policy.js";
import { DEFAULT_BUDGETS } from "../../src/types.js";

test("shouldRetry returns true while under the cap", () => {
  for (let i = 0; i < DEFAULT_BUDGETS.max_retries_per_subtask; i++) {
    assert.equal(defaultRetryPolicy.shouldRetry(i, DEFAULT_BUDGETS), true);
  }
  assert.equal(
    defaultRetryPolicy.shouldRetry(DEFAULT_BUDGETS.max_retries_per_subtask, DEFAULT_BUDGETS),
    false,
  );
});

test("backoffMs is monotonic and clamps at 8s", () => {
  let prev = -1;
  for (let i = 0; i <= 10; i++) {
    const ms = defaultRetryPolicy.backoffMs(i);
    assert.ok(ms >= prev, `expected monotonic non-decreasing, got ${ms} after ${prev}`);
    assert.ok(ms <= 8000);
    prev = ms;
  }
});
