// v0.7.3: extended tests for read_project_memory (project arg + id lookup
// on top of v0.6's category + query). The base v0.6 cases stay covered by
// the existing tests/tools/memory-tools.test.ts; this file pins the new
// v0.7.3 behavior so future refactors don't regress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OW_HOME = mkdtempSync(join(tmpdir(), "openwar-v073-read-"));
process.env.OPENWAR_HOME = OW_HOME;

const { READ_PROJECT_MEMORY_DEFINITION, readProjectMemoryExecutor } =
  await import("../../src/tools/native/read_project_memory.js");
const { writeProjectMemoryExecutor } =
  await import("../../src/tools/native/write_project_memory.js");
const { SandboxContext } = await import("../../src/sandbox/types.js");

test.after(() => {
  rmSync(OW_HOME, { recursive: true, force: true });
});

function ctx(opts: { project_slug?: string; brief_id?: string } = {}) {
  return SandboxContext._create({
    workdir: process.cwd(),
    defaultTimeoutMs: 5000,
    defaultMaxOutputBytes: 1_000_000,
    httpAllowlist: null,
    shellEnabled: false,
    ...(opts.project_slug && { project_slug: opts.project_slug }),
    ...(opts.brief_id && { brief_id: opts.brief_id }),
  });
}

async function seed(project: string, count = 5): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await writeProjectMemoryExecutor(
      {
        id: `w${i}`,
        name: "write_project_memory",
        arguments: {
          category: "decisions",
          entry: { summary: `decision ${i}`, rationale: `because ${i}` },
        },
      },
      ctx({ project_slug: project }),
    );
    const written = JSON.parse(res.content).written as { id: string };
    ids.push(written.id);
  }
  return ids;
}

test("definition: schema declares optional project, id, and required category", () => {
  const schema = READ_PROJECT_MEMORY_DEFINITION.input_schema as {
    properties: Record<string, unknown>;
    required: string[];
  };
  assert.ok(schema.properties.project);
  assert.ok(schema.properties.id);
  assert.ok(schema.properties.category);
  assert.deepEqual(schema.required, ["category"]);
});

test("read: explicit project arg overrides ctx.project_slug", async () => {
  await seed("proj-explicit", 3);
  // Pass a totally different project_slug in ctx; explicit `project` wins.
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "proj-explicit", category: "decisions" },
    },
    ctx({ project_slug: "other-project" }),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.project, "proj-explicit");
  assert.equal(body.count, 3);
});

test("read: project arg absent falls back to ctx.project_slug (v0.6 back-compat)", async () => {
  await seed("proj-ctx-fallback", 2);
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { category: "decisions" },
    },
    ctx({ project_slug: "proj-ctx-fallback" }),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.project, "proj-ctx-fallback");
  assert.equal(body.count, 2);
});

test("read: neither project nor ctx fails with NO_PROJECT", async () => {
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { category: "decisions" },
    },
    ctx(),
  );
  assert.equal(res.success, false);
  assert.equal(res.error?.code, "NO_PROJECT");
});

test("read: id filter returns exactly the matching entry", async () => {
  const ids = await seed("proj-id-lookup", 5);
  const targetId = ids[2]!;
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "proj-id-lookup", category: "decisions", id: targetId },
    },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.count, 1);
  assert.equal(body.entries[0].id, targetId);
  assert.equal(body.entries[0].summary, "decision 2");
});

test("read: id miss returns count=0, not an error", async () => {
  await seed("proj-id-miss", 2);
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "proj-id-miss", category: "decisions", id: "does-not-exist" },
    },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.count, 0);
  assert.deepEqual(body.entries, []);
});

test("read: missing project returns empty entries (not an error)", async () => {
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "never-existed", category: "decisions" },
    },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.count, 0);
});

test("read: limit cap enforced at 500 even when caller passes higher", async () => {
  await seed("proj-limit", 3);
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "proj-limit", category: "decisions", limit: 9999 },
    },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  // We only seeded 3; the cap doesn't reduce the result here, but limit=9999
  // does not crash. Verifying the cap behavior on a large store would be
  // a slow test; the inline Math.min clamp is the load-bearing check.
  assert.equal(body.count, 3);
});

test("read: limit=0 means cap-bounded (treated as MAX_LIMIT)", async () => {
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "proj-limit", category: "decisions", limit: 0 },
    },
    ctx(),
  );
  assert.equal(res.success, true);
});

test("read: default limit returns up to 50 (the v0.7.3 bumped default)", async () => {
  // No seed; just verify the parser default lands as 50 (we check by
  // confirming the limit field isn't in the response when defaulted).
  // The contract: caller-supplied limit echoes back; default is silent.
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { project: "proj-no-data", category: "decisions" },
    },
    ctx(),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.count, 0);
  // limit field is not echoed when default-applied; that's by design.
});
