import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlanFromText, scopeWarningsForPlan } from "../../src/coordinator/plan-parser.js";
import { parseBrief } from "../../src/brief.js";

test("parsePlanFromText extracts a valid plan", () => {
  const text = `Here's the plan.\n\n\`\`\`json\n${JSON.stringify({
    kind: "plan",
    rationale: "stepwise",
    subtasks: [
      { id: "a", title: "A", instruction: "do a", acceptance_criteria: ["c"], order: 0 },
    ],
  })}\n\`\`\``;
  const r = parsePlanFromText(text);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.subtasks.length, 1);
});

test("parsePlanFromText fails on no fence", () => {
  const r = parsePlanFromText("just prose");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no_fence");
});

test("parsePlanFromText rejects an execution handoff disguised as a plan", () => {
  const text = `\`\`\`json\n{"kind":"execution","subtask_id":"x","output":"","tool_calls":[],"notes":""}\n\`\`\``;
  const r = parsePlanFromText(text);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "validation");
});

const brief = parseBrief(`---
project: demo
scope_locked: true
authorized_costs:
  - filesystem_read
---

# Objective
x

# Deliverables
- y
`);

test("scopeWarningsForPlan flags unauthorized categories", () => {
  const plan = {
    kind: "plan" as const,
    rationale: "",
    subtasks: [
      {
        id: "a",
        title: "Deploy",
        instruction: "Deploy to prod after testing.",
        acceptance_criteria: ["green build"],
        order: 0,
      },
    ],
  };
  const warns = scopeWarningsForPlan(plan, brief);
  assert.ok(warns.some((w) => w.category === "deploy"));
});

test("scopeWarningsForPlan does not flag authorized categories", () => {
  const fmBrief = parseBrief(`---
project: demo
scope_locked: true
authorized_costs:
  - filesystem_write
---

# Objective
x

# Deliverables
- y
`);
  const plan = {
    kind: "plan" as const,
    rationale: "",
    subtasks: [
      {
        id: "a",
        title: "Write",
        instruction: "Write to disk the new module.",
        acceptance_criteria: ["file exists"],
        order: 0,
      },
    ],
  };
  const warns = scopeWarningsForPlan(plan, fmBrief);
  assert.equal(warns.find((w) => w.category === "filesystem_write"), undefined);
});

test("scopeWarningsForPlan respects wildcard authorization", () => {
  const wildBrief = parseBrief(`---
project: demo
scope_locked: true
authorized_costs:
  - "*"
---

# Objective
x

# Deliverables
- y
`);
  const plan = {
    kind: "plan" as const,
    rationale: "",
    subtasks: [
      {
        id: "a",
        title: "Anything",
        instruction: "Deploy to prod and run a shell command.",
        acceptance_criteria: ["done"],
        order: 0,
      },
    ],
  };
  assert.equal(scopeWarningsForPlan(plan, wildBrief).length, 0);
});
