import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, validateBrief } from "../src/brief.js";

test("parseBrief parses roles list", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles:
  - planner
  - executor
  - reviewer
---

# Objective
x

# Deliverables
- y
`);
  assert.deepEqual(brief.frontmatter.roles, ["planner", "executor", "reviewer"]);
});

test("parseBrief parses inline comma-separated roles", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles: planner,executor,reviewer
---

# Objective
x

# Deliverables
- y
`);
  assert.deepEqual(brief.frontmatter.roles, ["planner", "executor", "reviewer"]);
});

test("parseBrief parses nested budgets map", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
budgets:
  max_tokens: 100000
  max_wall_clock_minutes: 30
  max_tool_calls_per_subtask: 20
  max_retries_per_subtask: 4
---

# Objective
x

# Deliverables
- y
`);
  assert.equal(brief.frontmatter.budgets?.max_tokens, 100000);
  assert.equal(brief.frontmatter.budgets?.max_wall_clock_minutes, 30);
  assert.equal(brief.frontmatter.budgets?.max_tool_calls_per_subtask, 20);
  assert.equal(brief.frontmatter.budgets?.max_retries_per_subtask, 4);
});

test("validateBrief rejects unknown role id with actionable message", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles:
  - planner
  - mystery
  - executor
---

# Objective
x

# Deliverables
- y
`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  const issue = r.issues.find((i) => i.field === "roles");
  assert.ok(issue);
  assert.match(issue!.message, /unknown role "mystery"/);
});

test("validateBrief requires planner in any multi-agent roles list", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles:
  - executor
  - reviewer
---

# Objective
x

# Deliverables
- y
`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  assert.ok(r.issues.find((i) => /planner/.test(i.message)));
});

test("validateBrief requires executor in any multi-agent roles list", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles:
  - planner
  - reviewer
---

# Objective
x

# Deliverables
- y
`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  assert.ok(r.issues.find((i) => /executor/.test(i.message)));
});

test("validateBrief rejects zero/negative budgets", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
budgets:
  max_tokens: 0
---

# Objective
x

# Deliverables
- y
`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  assert.ok(r.issues.find((i) => i.field === "budgets.max_tokens"));
});

test("validateBrief allows roles to be omitted (single-agent mode)", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
---

# Objective
x

# Deliverables
- y
`);
  const r = validateBrief(brief);
  assert.equal(r.valid, true);
});

test("validateBrief accepts roles: [] as explicit single-agent", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles: []
---

# Objective
x

# Deliverables
- y
`);
  const r = validateBrief(brief);
  // Empty array is treated as single-agent: no requirement to include planner/executor.
  assert.equal(r.valid, true);
});
