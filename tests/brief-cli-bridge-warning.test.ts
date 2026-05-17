// v0.6.2: brief-validator warning when cli-bridge meets bridged-CLI permissions.
//
// The bridged CLI runs as its own subprocess with its own permission layer.
// OpenWar's authorized_costs apply to OpenWar tool calls only; the bridged
// CLI's permissions sit on top. Surface the interaction at lint time so the
// operator pre-authorizes the bridged CLI's paths before running.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, validateBrief } from "../src/brief.js";

const BODY = `

# Objective
x

# Deliverables
- y
`;

test("validateBrief: warns when cli-bridge role + filesystem_write authorized", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
  - filesystem_write
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
  // Valid (warnings don't fail).
  assert.equal(r.valid, true);
  const warning = r.issues.find(
    (i) => i.severity === "warning" && i.field === "role_adapters",
  );
  assert.ok(warning, "expected a warning about bridged-CLI permissions");
  assert.match(warning!.message, /bridged CLI/);
  assert.match(warning!.message, /Phase 2/);
});

test("validateBrief: warns when cli-bridge role + shell_exec only", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
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
  const warning = r.issues.find(
    (i) => i.severity === "warning" && i.field === "role_adapters",
  );
  assert.ok(warning, "shell_exec alone is enough to trigger the warning");
});

test("validateBrief: no warning when cli-bridge role but only filesystem_read", () => {
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
  // shell_exec triggers the warning even on otherwise read-only briefs because
  // shell_exec is itself side-effecting. Test the strictly-read case.
  const brief2 = parseBrief(`---
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
    adapter: anthropic
---
${BODY}`);
  const r2 = validateBrief(brief2);
  const warning2 = r2.issues.find(
    (i) => i.severity === "warning" && i.field === "role_adapters",
  );
  assert.equal(warning2, undefined, "read-only brief with no cli-bridge should not warn");
});

test("validateBrief: no warning when adapter is not cli-bridge even with write auth", () => {
  const brief = parseBrief(`---
project: demo
scope_locked: false
authorized_costs:
  - filesystem_read
  - filesystem_write
roles:
  - planner
  - executor
  - reviewer
role_adapters:
  executor:
    adapter: anthropic
---
${BODY}`);
  const r = validateBrief(brief);
  const warning = r.issues.find(
    (i) => i.severity === "warning" && i.field === "role_adapters",
  );
  assert.equal(warning, undefined, "no cli-bridge means no bridged-permission warning");
});

test("validateBrief: warning fires on wildcard authorized_costs with cli-bridge", () => {
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
  const warning = r.issues.find(
    (i) => i.severity === "warning" && i.field === "role_adapters",
  );
  assert.ok(warning, "wildcard auth implies side effects; warning should fire");
});
