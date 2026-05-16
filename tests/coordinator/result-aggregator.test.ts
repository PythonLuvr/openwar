import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateResults } from "../../src/coordinator/result-aggregator.js";
import type { PlanHandoff } from "../../src/types.js";

const plan: PlanHandoff = {
  kind: "plan",
  rationale: "linear",
  subtasks: [
    { id: "a", title: "Build", instruction: "make it", acceptance_criteria: ["x"], order: 0 },
    { id: "b", title: "Test", instruction: "test it", acceptance_criteria: ["y"], order: 1 },
    { id: "c", title: "Doc", instruction: "doc it", acceptance_criteria: ["z"], order: 2 },
  ],
};

test("aggregateResults reports passed/failed/escalated counts", () => {
  const r = aggregateResults({
    plan,
    outcomes: [
      { id: "a", title: "Build", review: { kind: "review", subtask_id: "a", verdict: "pass", rationale: "ok" } },
      { id: "b", title: "Test", review: { kind: "review", subtask_id: "b", verdict: "fail", rationale: "nope" } },
      { id: "c", title: "Doc", escalated: true },
    ],
  });
  assert.equal(r.total_subtasks, 3);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.escalated, 1);
  assert.match(r.text, /Phase 4: Completion/);
  assert.match(r.text, /1\. Build \(passed\)/);
  assert.match(r.text, /2\. Test \(failed\)/);
  assert.match(r.text, /3\. Doc \(escalated\)/);
});

test("aggregateResults handles missing outcomes as skipped", () => {
  const r = aggregateResults({ plan, outcomes: [] });
  assert.match(r.text, /\(skipped\)/);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 0);
});
