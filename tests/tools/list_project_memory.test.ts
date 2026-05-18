// v0.7.3: tests for list_project_memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OW_HOME = mkdtempSync(join(tmpdir(), "openwar-v073-list-"));
process.env.OPENWAR_HOME = OW_HOME;

const { LIST_PROJECT_MEMORY_DEFINITION, listProjectMemoryExecutor } =
  await import("../../src/tools/native/list_project_memory.js");
const { writeProjectMemoryExecutor } =
  await import("../../src/tools/native/write_project_memory.js");
const { SandboxContext } = await import("../../src/sandbox/types.js");
const { NATIVE_TOOLS } = await import("../../src/tools/native/index.js");

test.after(() => {
  rmSync(OW_HOME, { recursive: true, force: true });
});

function ctx(opts: { project_slug?: string } = {}) {
  return SandboxContext._create({
    workdir: process.cwd(),
    defaultTimeoutMs: 5000,
    defaultMaxOutputBytes: 1_000_000,
    httpAllowlist: null,
    shellEnabled: false,
    ...(opts.project_slug && { project_slug: opts.project_slug }),
  });
}

async function write(project: string, category: "decisions" | "knowledge" | "constraints", entry: Record<string, unknown>): Promise<string> {
  const res = await writeProjectMemoryExecutor(
    { id: "w", name: "write_project_memory", arguments: { category, entry } },
    ctx({ project_slug: project }),
  );
  return JSON.parse(res.content).written.id;
}

test("registered: list_project_memory appears in NATIVE_TOOLS", () => {
  assert.ok(NATIVE_TOOLS.has("list_project_memory"));
});

test("definition: project is required, category is optional", () => {
  const schema = LIST_PROJECT_MEMORY_DEFINITION.input_schema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.deepEqual(schema.required, ["project"]);
  assert.ok(schema.properties.category);
  assert.ok(schema.properties.since);
  assert.ok(schema.properties.limit);
});

test("list: all categories returns per-category counts including empty ones", async () => {
  // Seed only decisions; knowledge and constraints stay empty.
  await write("proj-all-cats", "decisions", { summary: "d1", rationale: "r1" });
  await write("proj-all-cats", "decisions", { summary: "d2", rationale: "r2" });
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "proj-all-cats" } },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content) as {
    project: string;
    categories: Array<{ category: string; count: number; entries: unknown[] }>;
  };
  assert.equal(body.project, "proj-all-cats");
  assert.equal(body.categories.length, 3);
  const byCat = Object.fromEntries(body.categories.map((c) => [c.category, c]));
  assert.equal(byCat.decisions!.count, 2);
  assert.equal(byCat.knowledge!.count, 0);
  assert.equal(byCat.constraints!.count, 0);
  assert.deepEqual(byCat.knowledge!.entries, []);
});

test("list: single-category mode returns just that one", async () => {
  await write("proj-single", "knowledge", { content: "deploys nightly" });
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "proj-single", category: "knowledge" } },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content) as { categories: Array<{ category: string }> };
  assert.equal(body.categories.length, 1);
  assert.equal(body.categories[0]!.category, "knowledge");
});

test("list: summary_or_excerpt uses category-specific accessor", async () => {
  await write("proj-summary", "decisions", { summary: "use Postgres", rationale: "ops familiarity" });
  await write("proj-summary", "knowledge", { content: "Deploys happen at 02:00 UTC nightly via the runbook in docs/" });
  await write("proj-summary", "constraints", { rule: "no force-push to main", rationale: "history is the audit log" });
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "proj-summary" } },
    ctx(),
  );
  const body = JSON.parse(res.content) as {
    categories: Array<{ category: string; entries: Array<{ summary_or_excerpt: string }> }>;
  };
  const dec = body.categories.find((c) => c.category === "decisions")!;
  const kn = body.categories.find((c) => c.category === "knowledge")!;
  const co = body.categories.find((c) => c.category === "constraints")!;
  assert.equal(dec.entries[0]!.summary_or_excerpt, "use Postgres");
  assert.match(kn.entries[0]!.summary_or_excerpt, /Deploys happen at 02:00 UTC nightly/);
  assert.equal(co.entries[0]!.summary_or_excerpt, "no force-push to main");
});

test("list: summary_or_excerpt truncates at 200 chars with ellipsis", async () => {
  const longContent = "x".repeat(500);
  await write("proj-truncate", "knowledge", { content: longContent });
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "proj-truncate", category: "knowledge" } },
    ctx(),
  );
  const body = JSON.parse(res.content) as {
    categories: Array<{ entries: Array<{ summary_or_excerpt: string }> }>;
  };
  const excerpt = body.categories[0]!.entries[0]!.summary_or_excerpt;
  assert.equal(excerpt.length, 200);
  assert.equal(excerpt.endsWith("..."), true);
});

test("list: since filter excludes older entries", async () => {
  await write("proj-since", "decisions", { summary: "d1", rationale: "old" });
  // Wait one ms so timestamps differ.
  await new Promise((r) => setTimeout(r, 5));
  const cutoff = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await write("proj-since", "decisions", { summary: "d2", rationale: "new" });
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "proj-since", category: "decisions", since: cutoff } },
    ctx(),
  );
  const body = JSON.parse(res.content) as {
    categories: Array<{ count: number; entries: Array<{ summary_or_excerpt: string }> }>;
  };
  assert.equal(body.categories[0]!.count, 1);
  assert.equal(body.categories[0]!.entries[0]!.summary_or_excerpt, "d2");
});

test("list: requires project arg", async () => {
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { category: "decisions" } },
    ctx(),
  );
  assert.equal(res.success, false);
  assert.equal(res.error?.code, "INVALID_ARGS");
});

test("list: each entry carries id, at, category, summary_or_excerpt", async () => {
  await write("proj-shape", "decisions", { summary: "x", rationale: "y" });
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "proj-shape", category: "decisions" } },
    ctx(),
  );
  const body = JSON.parse(res.content) as {
    categories: Array<{ entries: Array<Record<string, unknown>> }>;
  };
  const entry = body.categories[0]!.entries[0]!;
  assert.equal(typeof entry.id, "string");
  assert.equal(typeof entry.at, "string");
  assert.equal(entry.category, "decisions");
  assert.equal(typeof entry.summary_or_excerpt, "string");
  // brief_id is optional (not set in our seed)
});

test("list: missing project returns three empty category sections", async () => {
  const res = await listProjectMemoryExecutor(
    { id: "l1", name: "list_project_memory", arguments: { project: "never-existed-q" } },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content) as { categories: Array<{ count: number }> };
  assert.equal(body.categories.length, 3);
  for (const c of body.categories) assert.equal(c.count, 0);
});
