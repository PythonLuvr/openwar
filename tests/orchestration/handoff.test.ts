import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractHandoffJson,
  parseHandoffFromText,
  validatePlanHandoff,
  validateExecutionHandoff,
  validateReviewHandoff,
  validateEscalationHandoff,
  HandoffValidationError,
} from "../../src/orchestration/handoff.js";

// ---------- extractHandoffJson ----------

test("extractHandoffJson picks the last fenced json block", () => {
  const text = "intro prose\n```json\n{\"a\":1}\n```\nmiddle\n```json\n{\"b\":2}\n```\noutro";
  assert.equal(extractHandoffJson(text), '{"b":2}');
});

test("extractHandoffJson returns null when no fenced block", () => {
  assert.equal(extractHandoffJson("nothing fenced here"), null);
});

test("extractHandoffJson accepts uppercase JSON tag", () => {
  const text = "```JSON\n{\"k\":\"v\"}\n```";
  assert.equal(extractHandoffJson(text), '{"k":"v"}');
});

// ---------- parseHandoffFromText error paths ----------

test("parseHandoffFromText: no_fence on plain text", () => {
  const r = parseHandoffFromText("Plain text reply, no JSON.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no_fence");
});

test("parseHandoffFromText: bad_json on malformed JSON", () => {
  const r = parseHandoffFromText("```json\n{not valid json}\n```");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad_json");
});

test("parseHandoffFromText: validation on unknown kind", () => {
  const r = parseHandoffFromText('```json\n{"kind":"mystery"}\n```');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "validation");
});

test("parseHandoffFromText: validation when payload is array not object", () => {
  const r = parseHandoffFromText('```json\n[1,2,3]\n```');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "validation");
});

// ---------- Plan handoff ----------

const goodPlan = {
  kind: "plan",
  subtasks: [
    {
      id: "s1",
      title: "Create the module",
      instruction: "Write a function exporting build()",
      acceptance_criteria: ["file exists", "function exported"],
      order: 0,
    },
    {
      id: "s2",
      title: "Add tests",
      instruction: "Test happy path",
      acceptance_criteria: ["tests pass"],
      order: 1,
      depends_on: ["s1"],
    },
  ],
  rationale: "Build first, test second.",
};

test("validatePlanHandoff happy path", () => {
  const out = validatePlanHandoff(goodPlan);
  assert.equal(out.kind, "plan");
  assert.equal(out.subtasks.length, 2);
  assert.equal(out.subtasks[0]!.order, 0);
  assert.equal(out.subtasks[1]!.order, 1);
});

test("validatePlanHandoff rejects empty subtasks", () => {
  assert.throws(
    () => validatePlanHandoff({ kind: "plan", subtasks: [], rationale: "x" }),
    HandoffValidationError,
  );
});

test("validatePlanHandoff rejects non-linear dependency (skip)", () => {
  const bad = {
    kind: "plan",
    rationale: "x",
    subtasks: [
      { id: "a", title: "A", instruction: "a", acceptance_criteria: ["x"], order: 0 },
      { id: "b", title: "B", instruction: "b", acceptance_criteria: ["x"], order: 1 },
      // c depends on a, skipping b => not linear
      { id: "c", title: "C", instruction: "c", acceptance_criteria: ["x"], order: 2, depends_on: ["a"] },
    ],
  };
  assert.throws(() => validatePlanHandoff(bad), HandoffValidationError);
});

test("validatePlanHandoff rejects multi-dependency", () => {
  const bad = {
    kind: "plan",
    rationale: "x",
    subtasks: [
      { id: "a", title: "A", instruction: "a", acceptance_criteria: ["x"], order: 0 },
      { id: "b", title: "B", instruction: "b", acceptance_criteria: ["x"], order: 1 },
      { id: "c", title: "C", instruction: "c", acceptance_criteria: ["x"], order: 2, depends_on: ["a", "b"] },
    ],
  };
  assert.throws(() => validatePlanHandoff(bad), HandoffValidationError);
});

test("validatePlanHandoff rejects duplicate subtask ids", () => {
  const bad = {
    kind: "plan",
    rationale: "x",
    subtasks: [
      { id: "a", title: "A", instruction: "a", acceptance_criteria: ["x"], order: 0 },
      { id: "a", title: "A2", instruction: "a2", acceptance_criteria: ["x"], order: 1 },
    ],
  };
  assert.throws(() => validatePlanHandoff(bad), HandoffValidationError);
});

test("validatePlanHandoff rejects subtask missing acceptance_criteria", () => {
  const bad = {
    kind: "plan",
    rationale: "x",
    subtasks: [
      { id: "a", title: "A", instruction: "a", acceptance_criteria: [], order: 0 },
    ],
  };
  assert.throws(() => validatePlanHandoff(bad), HandoffValidationError);
});

test("validatePlanHandoff strips control characters from instruction", () => {
  const dirty = {
    kind: "plan",
    rationale: "ok",
    subtasks: [
      {
        id: "a",
        title: "A",
        instruction: "do the thing\x00\x07with hidden bytes",
        acceptance_criteria: ["x"],
        order: 0,
      },
    ],
  };
  const out = validatePlanHandoff(dirty);
  assert.equal(out.subtasks[0]!.instruction.includes("\x00"), false);
  assert.equal(out.subtasks[0]!.instruction.includes("\x07"), false);
});

test("validatePlanHandoff reassigns order to be monotonic", () => {
  const skipped = {
    kind: "plan",
    rationale: "ok",
    subtasks: [
      { id: "a", title: "A", instruction: "a", acceptance_criteria: ["x"], order: 7 },
      { id: "b", title: "B", instruction: "b", acceptance_criteria: ["x"], order: 9, depends_on: ["a"] },
    ],
  };
  const out = validatePlanHandoff(skipped);
  assert.deepEqual(out.subtasks.map((s) => s.order), [0, 1]);
});

// ---------- Execution handoff ----------

test("validateExecutionHandoff accepts complete payload", () => {
  const out = validateExecutionHandoff({
    kind: "execution",
    subtask_id: "s1",
    output: "wrote the file",
    tool_calls: [],
    notes: "no surprises",
  });
  assert.equal(out.subtask_id, "s1");
});

test("validateExecutionHandoff requires subtask_id", () => {
  assert.throws(
    () => validateExecutionHandoff({ kind: "execution", output: "x", tool_calls: [], notes: "" }),
    HandoffValidationError,
  );
});

test("validateExecutionHandoff caps oversized tool_calls list", () => {
  const fakeCalls = Array.from({ length: 500 }, (_, i) => ({
    call_id: `c${i}`,
    name: "x",
    arguments: {},
    at: new Date().toISOString(),
    authorized: true,
  }));
  const out = validateExecutionHandoff({
    kind: "execution",
    subtask_id: "s1",
    output: "ok",
    tool_calls: fakeCalls,
    notes: "",
  });
  assert.ok(out.tool_calls.length <= 256);
});

// ---------- Review handoff ----------

test("validateReviewHandoff accepts pass verdict", () => {
  const out = validateReviewHandoff({
    kind: "review",
    subtask_id: "s1",
    verdict: "pass",
    rationale: "all criteria met",
  });
  assert.equal(out.verdict, "pass");
});

test("validateReviewHandoff rejects unknown verdict", () => {
  assert.throws(
    () =>
      validateReviewHandoff({
        kind: "review",
        subtask_id: "s1",
        verdict: "maybe",
        rationale: "...",
      }),
    HandoffValidationError,
  );
});

test("validateReviewHandoff preserves suggested_revision on needs_retry", () => {
  const out = validateReviewHandoff({
    kind: "review",
    subtask_id: "s1",
    verdict: "needs_retry",
    rationale: "missing the second test case",
    suggested_revision: "Add a test for the divisible-by-400 case",
  });
  assert.match(out.suggested_revision ?? "", /divisible-by-400/);
});

// ---------- Escalation handoff ----------

test("validateEscalationHandoff requires severity and reason", () => {
  assert.throws(
    () =>
      validateEscalationHandoff({
        kind: "escalation",
        role: "executor",
        context: "x",
      }),
    HandoffValidationError,
  );
});

test("validateEscalationHandoff preserves budget_metric when valid", () => {
  const out = validateEscalationHandoff({
    kind: "escalation",
    severity: "error",
    role: "executor",
    reason: "wall clock exceeded",
    context: "ran 21 minutes",
    budget_metric: "wall_clock_ms",
  });
  assert.equal(out.budget_metric, "wall_clock_ms");
});

test("validateEscalationHandoff drops invalid budget_metric", () => {
  const out = validateEscalationHandoff({
    kind: "escalation",
    severity: "warn",
    role: "x",
    reason: "y",
    context: "z",
    budget_metric: "made_up",
  });
  assert.equal(out.budget_metric, undefined);
});

// ---------- Adversarial sanitization ----------

test("sanitization strips prototype pollution attempts", () => {
  // The validators only copy known fields; __proto__ should never appear.
  const payload = JSON.parse(
    '{"kind":"plan","rationale":"x","subtasks":[{"id":"a","title":"A","instruction":"i","acceptance_criteria":["c"],"order":0,"__proto__":{"polluted":true}}]}',
  );
  const out = validatePlanHandoff(payload);
  // The output's subtasks are constructed fresh; check that no polluted key leaked.
  assert.equal((out.subtasks[0] as unknown as { polluted?: boolean }).polluted, undefined);
  assert.equal((Object.prototype as { polluted?: boolean }).polluted, undefined);
});

test("parseHandoffFromText handles control chars without crashing", () => {
  const text = "```json\n{\"kind\":\"review\",\"subtask_id\":\"s1\",\"verdict\":\"pass\",\"rationale\":\"a\\u0000b\\u0007c\"}\n```";
  const r = parseHandoffFromText(text);
  assert.equal(r.ok, true);
  if (r.ok && r.handoff.kind === "review") {
    assert.equal(r.handoff.rationale.includes("\x00"), false);
  }
});
