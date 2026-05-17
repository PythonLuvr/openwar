import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OW_HOME = mkdtempSync(join(tmpdir(), "openwar-rolevis-test-"));
process.env.OPENWAR_HOME = OW_HOME;

const { categoriesForRole, renderMemoryForRole } =
  await import("../../src/roles/memory-visibility.js");
const { appendMemoryEntry } = await import("../../src/state/memory.js");

test.after(() => {
  rmSync(OW_HOME, { recursive: true, force: true });
});

test("categoriesForRole: executor only sees constraints + knowledge", () => {
  assert.deepEqual(categoriesForRole("executor"), ["constraints", "knowledge"]);
});

test("categoriesForRole: planner sees all three", () => {
  assert.deepEqual(categoriesForRole("planner"), ["decisions", "knowledge", "constraints"]);
});

test("categoriesForRole: reviewer sees all three", () => {
  assert.deepEqual(categoriesForRole("reviewer"), ["decisions", "knowledge", "constraints"]);
});

test("categoriesForRole: critic sees all three", () => {
  assert.deepEqual(categoriesForRole("critic"), ["decisions", "knowledge", "constraints"]);
});

test("categoriesForRole: null (single-agent) sees all three", () => {
  assert.deepEqual(categoriesForRole(null), ["decisions", "knowledge", "constraints"]);
});

test("renderMemoryForRole: executor view omits the decisions section", async () => {
  await appendMemoryEntry("vis-p1", "decisions", { summary: "use Postgres", rationale: "we know it" });
  await appendMemoryEntry("vis-p1", "knowledge", { content: "deploys are nightly" });
  await appendMemoryEntry("vis-p1", "constraints", { rule: "no schema drops in prod" });

  const exec = await renderMemoryForRole("vis-p1", "executor");
  assert.ok(!exec.includes("Memory: decisions"));
  assert.ok(exec.includes("Memory: knowledge"));
  assert.ok(exec.includes("Memory: constraints"));
});

test("renderMemoryForRole: planner view includes all three sections", async () => {
  const planner = await renderMemoryForRole("vis-p1", "planner");
  assert.ok(planner.includes("Memory: decisions"));
  assert.ok(planner.includes("Memory: knowledge"));
  assert.ok(planner.includes("Memory: constraints"));
});
