// v0.12.1: cost-tracker bridged-CLI usage accounting.
//
// Validates:
//   - addBridgedUsage adds input + output tokens to tokens_used (budget).
//   - Cache reads/writes are stored on separate counters but DO NOT inflate
//     tokens_used (cache reads bill at a fraction; including them in the
//     budget total would trip --max-tokens gates prematurely).
//   - Existing addTokens / native-adapter token tracking is unaffected.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  newCostUsage,
  addTokens,
  addBridgedUsage,
} from "../../src/coordinator/cost-tracker.js";

test("addBridgedUsage: input + output flow into tokens_used", () => {
  const u = newCostUsage(() => new Date("2026-05-19T00:00:00Z"));
  addBridgedUsage(u, { input_tokens: 100, output_tokens: 50 });
  assert.equal(u.tokens_used, 150);
  assert.equal(u.bridged_tokens_input, 100);
  assert.equal(u.bridged_tokens_output, 50);
});

test("addBridgedUsage: cache reads recorded separately, NOT counted toward tokens_used", () => {
  const u = newCostUsage();
  addBridgedUsage(u, {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 33297,
    cache_write_tokens: 116,
  });
  // Budget total is input + output only.
  assert.equal(u.tokens_used, 150);
  // Cache counters surfaced for visibility.
  assert.equal(u.bridged_tokens_cache_read, 33297);
  assert.equal(u.bridged_tokens_cache_write, 116);
});

test("addBridgedUsage: multiple calls accumulate per-field", () => {
  const u = newCostUsage();
  addBridgedUsage(u, { input_tokens: 100, cache_read_tokens: 1000 });
  addBridgedUsage(u, { input_tokens: 50, cache_read_tokens: 500 });
  assert.equal(u.tokens_used, 150);
  assert.equal(u.bridged_tokens_input, 150);
  assert.equal(u.bridged_tokens_cache_read, 1500);
});

test("addBridgedUsage: zero / undefined / negative fields ignored cleanly", () => {
  const u = newCostUsage();
  addBridgedUsage(u, {});
  addBridgedUsage(u, { input_tokens: 0 });
  addBridgedUsage(u, { output_tokens: -5 });
  assert.equal(u.tokens_used, 0);
  assert.equal(u.bridged_tokens_input, undefined);
  assert.equal(u.bridged_tokens_output, undefined);
});

test("addBridgedUsage and addTokens both feed tokens_used (no regression)", () => {
  const u = newCostUsage();
  addTokens(u, 100); // native adapter usage
  addBridgedUsage(u, { input_tokens: 25, output_tokens: 25 });
  assert.equal(u.tokens_used, 150);
  // Native tokens don't populate bridged counters.
  assert.equal(u.bridged_tokens_input, 25);
  assert.equal(u.bridged_tokens_output, 25);
});

test("addBridgedUsage: only cache fields supplied -> tokens_used unchanged", () => {
  const u = newCostUsage();
  addBridgedUsage(u, { cache_read_tokens: 5000, cache_write_tokens: 1000 });
  assert.equal(u.tokens_used, 0);
  assert.equal(u.bridged_tokens_cache_read, 5000);
  assert.equal(u.bridged_tokens_cache_write, 1000);
});

test("addBridgedUsage: existing CostUsage shape is BC (older sessions deserialize)", () => {
  // Simulate an older session serialized without the bridged_* fields.
  const u: ReturnType<typeof newCostUsage> = {
    tokens_used: 500,
    wall_clock_ms: 1000,
    tool_calls: 5,
    tool_calls_by_subtask: { st1: 3, st2: 2 },
    started_at: "2026-05-18T00:00:00Z",
  };
  addBridgedUsage(u, { input_tokens: 10 });
  assert.equal(u.tokens_used, 510);
  assert.equal(u.bridged_tokens_input, 10);
});
