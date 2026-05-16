import { test } from "node:test";
import assert from "node:assert/strict";
import {
  step,
  applyMutations,
  type MachineSnapshot,
} from "../../src/coordinator/state-machine.js";
import { DEFAULT_BUDGETS } from "../../src/types.js";

function fresh(overrides: Partial<MachineSnapshot> = {}): MachineSnapshot {
  return {
    state: "init",
    plan: null,
    current_subtask_index: -1,
    subtask_states: {},
    active_roles: ["planner", "executor", "reviewer"],
    budgets: DEFAULT_BUDGETS,
    cost: { tokens_used: 0, wall_clock_ms: 0, tool_calls_by_subtask: {} },
    ...overrides,
  };
}

test("init transitions to plan", () => {
  const snap = fresh();
  const r = step(snap, { kind: "execute_ok" });
  assert.equal(r.next_state, "plan");
});

test("plan -> dispatch on plan_ready, sets subtask index to 0", () => {
  const snap = fresh({ state: "plan" });
  const r = step(snap, { kind: "plan_ready" });
  assert.equal(r.next_state, "dispatch");
  assert.deepEqual(r.mutations.find((m) => m.type === "set_subtask_index"), {
    type: "set_subtask_index",
    index: 0,
  });
});

test("plan_invalid first time retries the planner", () => {
  const snap = fresh({ state: "plan" });
  const r = step(snap, { kind: "plan_invalid" });
  assert.equal(r.next_state, "plan");
  assert.ok(r.mutations.find((m) => m.type === "incr_subtask_attempts"));
});

test("plan_invalid second time escalates", () => {
  const snap = fresh({
    state: "plan",
    subtask_states: {
      __planner__: { id: "__planner__", status: "pending", attempts: 2 },
    },
  });
  const r = step(snap, { kind: "plan_invalid" });
  assert.equal(r.next_state, "escalate");
});

test("dispatch with no plan escalates", () => {
  const snap = fresh({ state: "dispatch", plan: null });
  const r = step(snap, { kind: "execute_ok" });
  assert.equal(r.next_state, "escalate");
});

test("dispatch with a valid plan goes to execute and marks subtask executing", () => {
  const snap = fresh({
    state: "dispatch",
    plan: {
      subtasks: [
        { id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 },
      ],
    },
    current_subtask_index: 0,
  });
  const r = step(snap, { kind: "execute_ok" });
  assert.equal(r.next_state, "execute");
  assert.ok(
    r.mutations.find(
      (m) => m.type === "set_subtask_status" && m.id === "a" && m.status === "executing",
    ),
  );
});

test("execute_blocked transitions to block with subtask marked failed", () => {
  const snap = fresh({
    state: "execute",
    plan: { subtasks: [{ id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 }] },
    current_subtask_index: 0,
  });
  const r = step(snap, { kind: "execute_blocked", reason: "missing file" });
  assert.equal(r.next_state, "block");
  assert.ok(r.mutations.find((m) => m.type === "set_subtask_status" && m.status === "failed"));
});

test("review_pass advances on linear plan", () => {
  const plan = {
    subtasks: [
      { id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 },
      { id: "b", title: "B", instruction: "i", acceptance_criteria: ["x"], order: 1 },
    ],
  };
  const snap = fresh({ state: "review_step", plan, current_subtask_index: 0 });
  const r = step(snap, { kind: "review_pass" });
  assert.equal(r.next_state, "next_subtask");
});

test("next_subtask advances to dispatch when more remain, complete when none", () => {
  const plan = {
    subtasks: [
      { id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 },
      { id: "b", title: "B", instruction: "i", acceptance_criteria: ["x"], order: 1 },
    ],
  };
  const mid = fresh({ state: "next_subtask", plan, current_subtask_index: 0 });
  const r1 = step(mid, { kind: "execute_ok" });
  assert.equal(r1.next_state, "dispatch");
  const end = fresh({ state: "next_subtask", plan, current_subtask_index: 1 });
  const r2 = step(end, { kind: "execute_ok" });
  assert.equal(r2.next_state, "complete");
});

test("review_needs_retry transitions to retry when under budget", () => {
  const snap = fresh({
    state: "review_step",
    plan: { subtasks: [{ id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 }] },
    current_subtask_index: 0,
    subtask_states: { a: { id: "a", status: "reviewing", attempts: 1 } },
    budgets: { ...DEFAULT_BUDGETS, max_retries_per_subtask: 3 },
  });
  const r = step(snap, { kind: "review_needs_retry" });
  assert.equal(r.next_state, "retry");
});

test("review_needs_retry escalates when over retry budget", () => {
  const snap = fresh({
    state: "review_step",
    plan: { subtasks: [{ id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 }] },
    current_subtask_index: 0,
    subtask_states: { a: { id: "a", status: "reviewing", attempts: 3 } },
    budgets: { ...DEFAULT_BUDGETS, max_retries_per_subtask: 3 },
  });
  const r = step(snap, { kind: "review_needs_retry" });
  assert.equal(r.next_state, "escalate");
});

test("review_disagreement transitions to block", () => {
  const snap = fresh({
    state: "review_step",
    plan: { subtasks: [{ id: "a", title: "A", instruction: "i", acceptance_criteria: ["x"], order: 0 }] },
    current_subtask_index: 0,
  });
  const r = step(snap, { kind: "review_disagreement" });
  assert.equal(r.next_state, "block");
});

test("budget_overrun always escalates regardless of state", () => {
  for (const s of ["plan", "execute", "review_step", "dispatch"] as const) {
    const snap = fresh({ state: s });
    const r = step(snap, { kind: "budget_overrun", metric: "tokens" });
    assert.equal(r.next_state, "escalate");
  }
});

test("operator_done routes to complete", () => {
  const snap = fresh({ state: "execute" });
  const r = step(snap, { kind: "operator_done" });
  assert.equal(r.next_state, "complete");
});

test("applyMutations is pure and returns a new snapshot", () => {
  const before = fresh();
  const after = applyMutations(before, [
    { type: "set_subtask_status", id: "a", status: "executing" },
    { type: "incr_subtask_attempts", id: "a" },
    { type: "advance_subtask_index" },
  ]);
  assert.notEqual(after, before);
  assert.equal(after.subtask_states["a"]?.status, "executing");
  assert.equal(after.subtask_states["a"]?.attempts, 1);
  assert.equal(after.current_subtask_index, before.current_subtask_index + 1);
  // Verify the input was not mutated.
  assert.equal(before.subtask_states["a"], undefined);
  assert.equal(before.current_subtask_index, -1);
});

test("terminal states are absorbing", () => {
  for (const s of ["block", "escalate", "complete"] as const) {
    const r = step(fresh({ state: s }), { kind: "execute_ok" });
    assert.equal(r.next_state, s);
  }
});
