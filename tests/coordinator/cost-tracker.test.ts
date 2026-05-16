import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newCostUsage,
  addTokens,
  setWallClock,
  recordToolCall,
  estimateTokens,
  checkBudgets,
} from "../../src/coordinator/cost-tracker.js";
import { DEFAULT_BUDGETS } from "../../src/types.js";

test("estimateTokens returns ceil(chars/4)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(401)), 101);
});

test("addTokens ignores non-positive inputs", () => {
  const u = newCostUsage();
  addTokens(u, 100);
  addTokens(u, -5);
  addTokens(u, NaN);
  assert.equal(u.tokens_used, 100);
});

test("setWallClock is monotonic upward", () => {
  const u = newCostUsage();
  setWallClock(u, 5000);
  setWallClock(u, 1000);
  assert.equal(u.wall_clock_ms, 5000);
  setWallClock(u, 9000);
  assert.equal(u.wall_clock_ms, 9000);
});

test("recordToolCall increments global and per-subtask counters", () => {
  const u = newCostUsage();
  recordToolCall(u, "a");
  recordToolCall(u, "a");
  recordToolCall(u, "b");
  assert.equal(u.tool_calls, 3);
  assert.equal(u.tool_calls_by_subtask["a"], 2);
  assert.equal(u.tool_calls_by_subtask["b"], 1);
});

test("recordToolCall with null subtask still increments global counter", () => {
  const u = newCostUsage();
  recordToolCall(u, null);
  assert.equal(u.tool_calls, 1);
  assert.deepEqual(u.tool_calls_by_subtask, {});
});

test("checkBudgets returns null when under all limits", () => {
  const u = newCostUsage();
  const r = checkBudgets(u, DEFAULT_BUDGETS, null);
  assert.equal(r.exceeded, null);
});

test("checkBudgets returns tokens when token limit hit", () => {
  const u = newCostUsage();
  addTokens(u, DEFAULT_BUDGETS.max_tokens + 1);
  const r = checkBudgets(u, DEFAULT_BUDGETS, null);
  assert.equal(r.exceeded, "tokens");
});

test("checkBudgets prioritizes tokens over wall_clock when both exceeded", () => {
  const u = newCostUsage();
  addTokens(u, DEFAULT_BUDGETS.max_tokens + 1);
  setWallClock(u, DEFAULT_BUDGETS.max_wall_clock_minutes * 60 * 1000 + 1);
  const r = checkBudgets(u, DEFAULT_BUDGETS, null);
  assert.equal(r.exceeded, "tokens");
});

test("checkBudgets returns tool_calls when per-subtask cap exceeded", () => {
  const u = newCostUsage();
  for (let i = 0; i <= DEFAULT_BUDGETS.max_tool_calls_per_subtask; i++) {
    recordToolCall(u, "a");
  }
  const r = checkBudgets(u, DEFAULT_BUDGETS, "a");
  assert.equal(r.exceeded, "tool_calls");
});

test("checkBudgets ignores other sub-tasks for the tool_calls check", () => {
  const u = newCostUsage();
  for (let i = 0; i <= DEFAULT_BUDGETS.max_tool_calls_per_subtask; i++) {
    recordToolCall(u, "a");
  }
  const r = checkBudgets(u, DEFAULT_BUDGETS, "b");
  assert.equal(r.exceeded, null);
});
