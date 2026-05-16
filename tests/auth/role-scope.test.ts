import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRoleScope, RoleScopeViolation } from "../../src/auth/role-scope.js";
import {
  checkAuthorizationWithRole,
} from "../../src/auth/check.js";
import {
  plannerDefinition,
  executorDefinition,
  reviewerDefinition,
  criticDefinition,
} from "../../src/roles/index.js";
import type { ToolDefinition } from "../../src/tools/types.js";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "read",
  input_schema: { type: "object" },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

const writeTool: ToolDefinition = {
  name: "write_file",
  description: "write",
  input_schema: { type: "object" },
  origin: "native",
  authorization_categories: ["filesystem_write"],
};

const shellTool: ToolDefinition = {
  name: "shell_exec",
  description: "shell",
  input_schema: { type: "object" },
  origin: "native",
  authorization_categories: ["shell_exec"],
};

test("planner cannot call any tool", () => {
  for (const t of [readTool, writeTool, shellTool]) {
    const r = checkRoleScope({ tool: t, role: plannerDefinition });
    assert.equal(r.in_scope, false, `planner must not have access to ${t.name}`);
  }
});

test("reviewer can read_file, cannot write_file or shell_exec", () => {
  assert.equal(checkRoleScope({ tool: readTool, role: reviewerDefinition }).in_scope, true);
  assert.equal(checkRoleScope({ tool: writeTool, role: reviewerDefinition }).in_scope, false);
  assert.equal(checkRoleScope({ tool: shellTool, role: reviewerDefinition }).in_scope, false);
});

test("critic has same scope as reviewer", () => {
  assert.equal(checkRoleScope({ tool: readTool, role: criticDefinition }).in_scope, true);
  assert.equal(checkRoleScope({ tool: writeTool, role: criticDefinition }).in_scope, false);
});

test("executor inherits brief authorization via wildcard scope", () => {
  for (const t of [readTool, writeTool, shellTool]) {
    const r = checkRoleScope({ tool: t, role: executorDefinition });
    assert.equal(r.in_scope, true, `executor wildcard should include ${t.name}`);
  }
});

test("checkAuthorizationWithRole returns role_scope_violation for planner+write_file", () => {
  const r = checkAuthorizationWithRole({
    tool: writeTool,
    role: plannerDefinition,
    authorizedCosts: ["filesystem_write"],
  });
  assert.equal(r.kind, "role_scope_violation");
});

test("checkAuthorizationWithRole returns needs_operator when role passes but brief lacks auth", () => {
  const r = checkAuthorizationWithRole({
    tool: shellTool,
    role: executorDefinition,
    authorizedCosts: ["filesystem_read"], // does not cover shell_exec
  });
  assert.equal(r.kind, "needs_operator");
});

test("checkAuthorizationWithRole returns allowed when both role and brief cover the tool", () => {
  const r = checkAuthorizationWithRole({
    tool: writeTool,
    role: executorDefinition,
    authorizedCosts: ["filesystem_write"],
  });
  assert.equal(r.kind, "allowed");
});

test("session approval covers brief-level auth gap", () => {
  const r = checkAuthorizationWithRole({
    tool: shellTool,
    role: executorDefinition,
    authorizedCosts: [],
    sessionApproved: ["shell_exec"],
  });
  assert.equal(r.kind, "allowed");
});

test("RoleScopeViolation carries the failing categories", () => {
  const e = new RoleScopeViolation("planner", "write_file", ["filesystem_write"]);
  assert.match(e.message, /Role "planner" attempted to call "write_file"/);
  assert.deepEqual(e.missing_categories, ["filesystem_write"]);
});
