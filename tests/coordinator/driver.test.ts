import { test } from "node:test";
import assert from "node:assert/strict";
import { runCoordinator, resolveBudgets } from "../../src/coordinator/driver.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import { parseBrief } from "../../src/brief.js";
import { createScriptedIO } from "../../src/io.js";
import { SandboxContext } from "../../src/sandbox/types.js";
import type { Brief } from "../../src/types.js";

function makeBrief(roles: string[]): Brief {
  const src = `---
project: e2e-coord
brief_id: 2026-02-01-T1
scope_locked: true
authorized_costs:
  - filesystem_read
  - filesystem_write
roles:
${roles.map((r) => `  - ${r}`).join("\n")}
---

# Objective
Build a tiny helper module.

# Deliverables
- src/h.ts
- tests/h.test.ts

# Constraints
- No new deps.

# Tools required
- fs

# Notes / unknowns
- None.
`;
  return parseBrief(src);
}

const baseSandbox = SandboxContext._create({
  workdir: process.cwd(),
  defaultTimeoutMs: 30_000,
  defaultMaxOutputBytes: 1_000_000,
  httpAllowlist: null,
  shellEnabled: false,
});

const VALID_PLAN_TEXT = (subs: { id: string; title: string }[]) =>
  "Decomposing the work.\n\n```json\n" +
  JSON.stringify({
    kind: "plan",
    rationale: "linear breakdown",
    subtasks: subs.map((s, i) => ({
      id: s.id,
      title: s.title,
      instruction: `instruction for ${s.id}`,
      acceptance_criteria: ["produced", "no breakage"],
      order: i,
      ...(i === 0 ? {} : { depends_on: [subs[i - 1]!.id] }),
    })),
  }) +
  "\n```";

const EXECUTION_TEXT = (id: string) =>
  "I built the thing.\n\n```json\n" +
  JSON.stringify({
    kind: "execution",
    subtask_id: id,
    output: `done: ${id}`,
    tool_calls: [],
    notes: "no surprises",
  }) +
  "\n```";

const REVIEW_TEXT = (id: string, verdict: "pass" | "fail" | "needs_retry", revision?: string) =>
  "Reviewing.\n\n```json\n" +
  JSON.stringify({
    kind: "review",
    subtask_id: id,
    verdict,
    rationale: "checked the criteria",
    ...(revision ? { suggested_revision: revision } : {}),
  }) +
  "\n```";

test("driver walks planner -> executor -> reviewer for one sub-task and completes", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const adapter = new MockAdapter([
    VALID_PLAN_TEXT([{ id: "s1", title: "Build" }]),
    EXECUTION_TEXT("s1"),
    REVIEW_TEXT("s1", "pass"),
  ]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "test-session",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, true);
  assert.equal(result.final_state, "complete");
  // 3 adapter calls: planner + executor + reviewer.
  assert.equal(adapter.calls.length, 3);
});

test("driver handles two sub-tasks sequentially", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const adapter = new MockAdapter([
    VALID_PLAN_TEXT([{ id: "s1", title: "A" }, { id: "s2", title: "B" }]),
    EXECUTION_TEXT("s1"),
    REVIEW_TEXT("s1", "pass"),
    EXECUTION_TEXT("s2"),
    REVIEW_TEXT("s2", "pass"),
  ]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "test-session-2",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, true);
  // 5 adapter calls: planner + 2*(executor+reviewer).
  assert.equal(adapter.calls.length, 5);
});

test("driver retries when reviewer says needs_retry, then completes", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const adapter = new MockAdapter([
    VALID_PLAN_TEXT([{ id: "s1", title: "Build" }]),
    EXECUTION_TEXT("s1"),
    REVIEW_TEXT("s1", "needs_retry", "Add a comment to the export"),
    EXECUTION_TEXT("s1"),
    REVIEW_TEXT("s1", "pass"),
  ]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "test-session-retry",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, true);
  // 5 adapter calls: planner + (executor + reviewer-needs-retry) + (executor + reviewer-pass).
  assert.equal(adapter.calls.length, 5);
});

test("driver halts on critic disagreement", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer", "critic"]);
  const adapter = new MockAdapter([
    VALID_PLAN_TEXT([{ id: "s1", title: "Build" }]),
    EXECUTION_TEXT("s1"),
    REVIEW_TEXT("s1", "pass"),
    REVIEW_TEXT("s1", "fail"), // critic disagrees
  ]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter,
    io,
    roleIds: ["planner", "executor", "reviewer", "critic"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "test-session-critic",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, false);
  assert.equal(result.final_state, "block");
});

test("driver escalates when planner produces invalid plan twice", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const adapter = new MockAdapter([
    "no fence here",
    "still no fence",
  ]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: resolveBudgets(brief),
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "test-session-bad-plan",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, false);
  assert.equal(result.final_state, "escalate");
});

test("driver halts on token budget overrun", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  // Provide a tiny token budget so the planner call alone exceeds it.
  const tinyBudgets = { ...resolveBudgets(brief), max_tokens: 1 };
  const adapter = new MockAdapter([
    VALID_PLAN_TEXT([{ id: "s1", title: "Build" }]),
  ]);
  const io = createScriptedIO();
  const result = await runCoordinator({
    brief,
    framework: "FRAMEWORK",
    adapter,
    io,
    roleIds: ["planner", "executor", "reviewer"],
    budgets: tinyBudgets,
    toolDefinitions: [],
    toolExecutors: new Map(),
    sandbox: baseSandbox,
    onSnapshot: () => {},
    sessionApproved: [],
    sessionId: "test-session-budget",
    onMessage: () => {},
    onApproval: () => {},
  });
  assert.equal(result.completed, false);
  assert.equal(result.final_state, "escalate");
});

test("driver determinism: same script same snapshot trace", async () => {
  const brief = makeBrief(["planner", "executor", "reviewer"]);
  const script = [
    VALID_PLAN_TEXT([{ id: "s1", title: "Build" }]),
    EXECUTION_TEXT("s1"),
    REVIEW_TEXT("s1", "pass"),
  ];
  const traceA: string[] = [];
  const traceB: string[] = [];
  for (const trace of [traceA, traceB]) {
    const adapter = new MockAdapter(script);
    const io = createScriptedIO();
    await runCoordinator({
      brief,
      framework: "FRAMEWORK",
      adapter,
      io,
      roleIds: ["planner", "executor", "reviewer"],
      budgets: resolveBudgets(brief),
      toolDefinitions: [],
      toolExecutors: new Map(),
      sandbox: baseSandbox,
      onSnapshot: (snap) => { trace.push(snap.state); },
      sessionApproved: [],
      sessionId: "det",
      onMessage: () => {},
      onApproval: () => {},
    });
  }
  assert.deepEqual(traceA, traceB);
});
