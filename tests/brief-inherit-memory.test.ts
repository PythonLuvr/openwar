import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief } from "../src/brief.js";

const BODY = `

# Objective
x

# Deliverables
- y
`;

test("inherit_memory: default omitted is undefined (treated as false at runtime)", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
---
${BODY}`);
  assert.equal(brief.frontmatter.inherit_memory, undefined);
});

test("inherit_memory: true is parsed", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
inherit_memory: true
---
${BODY}`);
  assert.equal(brief.frontmatter.inherit_memory, true);
});

test("inherit_memory: false is parsed as undefined (no field set)", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
inherit_memory: false
---
${BODY}`);
  // Parser only sets the field when truthy; false omitted keeps the frontmatter slim.
  assert.equal(brief.frontmatter.inherit_memory, undefined);
});
