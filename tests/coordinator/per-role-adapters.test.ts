import { test } from "node:test";
import assert from "node:assert/strict";
import { runCoordinator, resolveBudgets } from "../../src/coordinator/driver.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import { parseBrief } from "../../src/brief.js";
import { createScriptedIO } from "../../src/io.js";
import { SandboxContext } from "../../src/sandbox/types.js";
import type { Brief, RoleId } from "../../src/types.js";

function makeBrief(roles: string[]): Brief {
  return parseBrief(`---
project: per-role-coord
brief_id: 2026-05-17-PRT
scope_locked: true
authorized_costs:
  - filesystem_read
  - filesystem_write
roles:
${roles.map((r) => `  - ${r}`).join("\n")}
---

# Objective
Tiny.

# Deliverables
- one

# Constraints
- None.

# Tools required
- None.

# Notes / unknowns
- None.
`);
}

const baseSandbox = SandboxContext._create({
  workdir: process.cwd(),
  defaultTimeoutMs: 30_000,
  defaultMaxOutputBytes: 1_000_000,
  httpAllowlist: null,
  shellEnabled: false,
});

const PLAN_TEXT =
  "Planning.\n\n```json\n" +
  JSON.stringify({
    kind: "plan",
    rationale: "single sub-task",
    subtasks: [
      {
        id: "s1",
        title: "Build",
        instruction: "build it",
        acceptance_criteria: ["produced", "no breakage"],
        order: 0,
      },
    ],
  }) +
  "\n```";

const EXEC_TEXT =
  "Executing.\n\n```json\n" +
  JSON.stringify({
    kind: "execution",
    subtask_id: "s1",
    output: "done: s1",
    tool_calls: [],
    notes: "ok",
  }) +
  "\n```";

const REVIEW_TEXT_PASS =
  "Reviewing.\n\n```json\n" +
  JSON.stringify({
    kind: "review",
    subtask_id: "s1",
    verdict: "pass",
    rationale: "criteria met",
  }) +
  "\n```";

test("getAdapter routes each role to its own adapter (planner != executor != reviewer)", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const plannerAdapter = new MockAdapter([PLAN_TEXT]);
  const executorAdapter = new MockAdapter([EXEC_TEXT]);
  const reviewerAdapter = new MockAdapter([REVIEW_TEXT_PASS]);
  const adapters: Record<RoleId, MockAdapter> = {
    planner: plannerAdapter,
    executor: executorAdapter,
    reviewer: reviewerAdapter,
  };
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    getAdapter: (roleId) => adapters[roleId]!,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "per-role-1",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, true);
  // Each adapter saw exactly one call, in the right role.
  assert.equal(plannerAdapter.calls.length, 1);
  assert.equal(executorAdapter.calls.length, 1);
  assert.equal(reviewerAdapter.calls.length, 1);
});

test("getAdapter routes critic to its own adapter on disagreement", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer", "critic"]);
  const plannerAdapter = new MockAdapter([PLAN_TEXT]);
  const executorAdapter = new MockAdapter([EXEC_TEXT]);
  const reviewerAdapter = new MockAdapter([REVIEW_TEXT_PASS]);
  const REVIEW_TEXT_FAIL =
    "Critic.\n\n```json\n" +
    JSON.stringify({
      kind: "review",
      subtask_id: "s1",
      verdict: "fail",
      rationale: "disagrees",
    }) +
    "\n```";
  const criticAdapter = new MockAdapter([REVIEW_TEXT_FAIL]);
  const adapters: Record<RoleId, MockAdapter> = {
    planner: plannerAdapter,
    executor: executorAdapter,
    reviewer: reviewerAdapter,
    critic: criticAdapter,
  };
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    getAdapter: (roleId) => adapters[roleId]!,
    io,
    roleIds: ["planner", "executor", "reviewer", "critic"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "per-role-critic",
    onMessage: () => {},
    onApproval: () => {},
  });
  // Critic disagreed -> coordinator halts on disagreement.
  assert.equal(result.completed, false);
  assert.equal(result.final_state, "block");
  // Each adapter saw exactly one call.
  assert.equal(plannerAdapter.calls.length, 1);
  assert.equal(executorAdapter.calls.length, 1);
  assert.equal(reviewerAdapter.calls.length, 1);
  assert.equal(criticAdapter.calls.length, 1);
});

test("legacy single-adapter callers still work (back-compat)", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const shared = new MockAdapter([PLAN_TEXT, EXEC_TEXT, REVIEW_TEXT_PASS]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter: shared,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "back-compat-1",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, true);
  assert.equal(shared.calls.length, 3);
});

test("runCoordinator throws when neither getAdapter nor adapter is supplied", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const io = createScriptedIO();
  await assert.rejects(
    () =>
      runCoordinator({
        brief,
        framework: "FRAMEWORK",
        io,
        roleIds: ["planner", "executor", "reviewer"],
        budgets: resolveBudgets(brief),
        toolDefinitions: [],
        toolExecutors: new Map(),
        sandbox: baseSandbox,
        onSnapshot: () => {},
        sessionApproved: [],
        sessionId: "no-adapter",
        onMessage: () => {},
        onApproval: () => {},
      }),
    /must provide either getAdapter or adapter/,
  );
});
