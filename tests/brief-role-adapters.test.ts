import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, validateBrief } from "../src/brief.js";

const BODY = `

# Objective
x

# Deliverables
- y
`;

test("parseBrief still accepts v0.4 flat roles list (back-compat)", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
roles:
  - planner
  - executor
  - reviewer
---
${BODY}`);
  assert.deepEqual(brief.frontmatter.roles, ["planner", "executor", "reviewer"]);
  assert.equal(brief.frontmatter.role_adapters, undefined);
});

test("parseBrief reads v0.5.1 nested-map roles into roles + role_adapters", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
  - shell_exec
roles:
  planner:
    adapter: anthropic
    model: claude-haiku-4-5
  executor:
    adapter: cli-bridge
    binary: claude
    tier: free
  reviewer:
    adapter: anthropic
    model: claude-haiku-4-5
---
${BODY}`);
  assert.deepEqual(brief.frontmatter.roles, ["planner", "executor", "reviewer"]);
  assert.ok(brief.frontmatter.role_adapters);
  assert.equal(brief.frontmatter.role_adapters!.planner!.adapter, "anthropic");
  assert.equal(brief.frontmatter.role_adapters!.planner!.model, "claude-haiku-4-5");
  assert.equal(brief.frontmatter.role_adapters!.executor!.adapter, "cli-bridge");
  assert.equal(brief.frontmatter.role_adapters!.executor!.binary, "claude");
  assert.equal(brief.frontmatter.role_adapters!.executor!.tier, "free");
  assert.equal(brief.frontmatter.role_adapters!.reviewer!.adapter, "anthropic");
});

test("parseBrief reads sibling role_adapters block alongside flat roles", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
  - shell_exec
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  executor:
    adapter: cli-bridge
    binary: claude
---
${BODY}`);
  assert.deepEqual(brief.frontmatter.roles, ["planner", "executor", "reviewer"]);
  assert.ok(brief.frontmatter.role_adapters);
  assert.equal(brief.frontmatter.role_adapters!.executor!.adapter, "cli-bridge");
  assert.equal(brief.frontmatter.role_adapters!.executor!.binary, "claude");
});

test("validateBrief rejects role_adapters entry for a role not in roles list", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
  - shell_exec
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  critic:
    adapter: anthropic
---
${BODY}`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  const issue = r.issues.find((i) => i.field.startsWith("role_adapters.critic"));
  assert.ok(issue);
  assert.match(issue!.message, /not declared in roles/);
});

test("validateBrief rejects unknown adapter id with the known list in the message", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  executor:
    adapter: not-a-real-adapter
---
${BODY}`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  const issue = r.issues.find((i) => i.field === "role_adapters.executor.adapter");
  assert.ok(issue);
  assert.match(issue!.message, /unknown adapter/);
  assert.match(issue!.message, /anthropic/);
});

test("validateBrief rejects cli-bridge role when brief is missing shell_exec", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  executor:
    adapter: cli-bridge
    binary: claude
---
${BODY}`);
  const r = validateBrief(brief);
  assert.equal(r.valid, false);
  const issue = r.issues.find((i) => i.field === "role_adapters.executor.adapter");
  assert.ok(issue);
  assert.match(issue!.message, /shell_exec/);
});

test("validateBrief accepts cli-bridge role when shell_exec is authorized", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
  - shell_exec
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  executor:
    adapter: cli-bridge
    binary: claude
---
${BODY}`);
  const r = validateBrief(brief);
  assert.equal(r.valid, true);
});

test("validateBrief accepts wildcard authorized_costs in place of shell_exec", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - "*"
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  executor:
    adapter: cli-bridge
    binary: claude
---
${BODY}`);
  const r = validateBrief(brief);
  // The "*" auth surfaces a warning elsewhere but is not an error here.
  assert.equal(r.valid, true);
});
