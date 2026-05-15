import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, validateBrief, renderBriefForAgent, generateBriefId } from "../src/brief.js";

test("parseBrief parses minimal frontmatter", () => {
  const raw = `---
project: demo
scope_locked: false
---

# Objective

Ship it.

# Deliverables

- Thing
`;
  const brief = parseBrief(raw);
  assert.equal(brief.frontmatter.project, "demo");
  assert.equal(brief.frontmatter.scope_locked, false);
  assert.match(brief.sections.objective, /Ship it/);
  assert.match(brief.sections.deliverables, /Thing/);
});

test("parseBrief parses authorized_costs list", () => {
  const raw = `---
project: demo
scope_locked: true
authorized_costs:
  - api_calls
  - filesystem_write
---

# Objective

x

# Deliverables

y
`;
  const brief = parseBrief(raw);
  assert.deepEqual(brief.frontmatter.authorized_costs, ["api_calls", "filesystem_write"]);
  assert.equal(brief.frontmatter.scope_locked, true);
});

test("parseBrief accepts mode override", () => {
  const raw = `---
project: demo
scope_locked: false
mode: auto
---

# Objective

x

# Deliverables

y
`;
  const brief = parseBrief(raw);
  assert.equal(brief.frontmatter.mode, "auto");
});

test("parseBrief rejects unclosed frontmatter", () => {
  const raw = `---
project: demo

# Objective
`;
  assert.throws(() => parseBrief(raw), /frontmatter/i);
});

test("validateBrief flags missing required sections", () => {
  const raw = `---
project: demo
scope_locked: false
---

# Constraints

none
`;
  const brief = parseBrief(raw);
  const result = validateBrief(brief);
  assert.equal(result.valid, false);
  const fields = result.issues.filter((i) => i.severity === "error").map((i) => i.field);
  assert.ok(fields.includes("Objective"));
  assert.ok(fields.includes("Deliverables"));
});

test("validateBrief enforces project slug format", () => {
  const raw = `---
project: Bad Project Slug
scope_locked: false
---

# Objective

x

# Deliverables

y
`;
  const brief = parseBrief(raw);
  const result = validateBrief(brief);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((i) => i.field === "project"));
});

test("renderBriefForAgent emits all populated sections", () => {
  const raw = `---
project: demo
scope_locked: true
authorized_costs:
  - api_calls
---

# Objective

Build a thing.

# Deliverables

- a
- b

# Tools required

filesystem
`;
  const brief = parseBrief(raw);
  const rendered = renderBriefForAgent(brief);
  assert.match(rendered, /Brief: demo/);
  assert.match(rendered, /scope_locked: true/);
  assert.match(rendered, /authorized_costs: api_calls/);
  assert.match(rendered, /## Objective/);
  assert.match(rendered, /Build a thing/);
  assert.match(rendered, /## Tools required/);
  assert.match(rendered, /filesystem/);
});

test("generateBriefId matches expected shape", () => {
  const id = generateBriefId(new Date("2026-03-05T12:00:00Z"));
  assert.match(id, /^2026-03-05-[a-z0-9]{6}$/);
});
