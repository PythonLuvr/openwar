import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listRoles,
  listRoleIds,
  getRole,
  registerRole,
  _resetRegistryToBuiltIns,
} from "../../src/roles/registry.js";
import { buildSystemPrompt } from "../../src/roles/prompt-overlay.js";
import { plannerDefinition } from "../../src/roles/planner.js";
import { parseBrief } from "../../src/brief.js";

test("registry exposes all four built-in roles", () => {
  _resetRegistryToBuiltIns();
  const ids = listRoleIds().sort();
  assert.deepEqual(ids, ["critic", "executor", "planner", "reviewer"]);
});

test("getRole returns the role definition by id", () => {
  _resetRegistryToBuiltIns();
  const p = getRole("planner");
  assert.ok(p);
  assert.equal(p!.id, "planner");
});

test("registerRole adds a custom role visible via listRoles", () => {
  _resetRegistryToBuiltIns();
  registerRole({
    id: "documenter",
    description: "Writes docs.",
    prompt_overlay: "doc only",
    tool_categories: ["filesystem_write"],
    allow_read_file: true,
  });
  const ids = listRoleIds();
  assert.ok(ids.includes("documenter"));
  const def = getRole("documenter");
  assert.equal(def?.tool_categories[0], "filesystem_write");
});

test("registerRole rejects empty id", () => {
  assert.throws(() =>
    registerRole({
      id: "",
      description: "x",
      prompt_overlay: "y",
      tool_categories: [],
    } as unknown as Parameters<typeof registerRole>[0]),
  );
});

test("buildSystemPrompt composes framework + brief + role + extra", () => {
  _resetRegistryToBuiltIns();
  const brief = parseBrief(`---
project: demo
scope_locked: false
---

# Objective
ship it.

# Deliverables
- one thing
`);
  const out = buildSystemPrompt({
    framework: "FRAMEWORK_DOC_VERBATIM",
    brief,
    role: plannerDefinition,
    extra: "PER_INVOCATION_EXTRA",
  });
  assert.match(out, /FRAMEWORK_DOC_VERBATIM/);
  assert.match(out, /Brief \(verbatim from the operator\)/);
  assert.match(out, /Role: planner/);
  assert.match(out, /PER_INVOCATION_EXTRA/);
});

test("role overlays do not override framework hard rules", () => {
  // Hard rules live in the framework section. Roles never include
  // "Phase 3" rewrites or banned-phrase changes; verify by string match.
  _resetRegistryToBuiltIns();
  for (const r of listRoles()) {
    assert.equal(/override the framework/i.test(r.prompt_overlay), false);
    assert.equal(/ignore Phase 3/i.test(r.prompt_overlay), false);
  }
});
