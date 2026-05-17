import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OW_HOME = mkdtempSync(join(tmpdir(), "openwar-memtools-test-"));
process.env.OPENWAR_HOME = OW_HOME;

const { READ_PROJECT_MEMORY_DEFINITION, readProjectMemoryExecutor } =
  await import("../../src/tools/native/read_project_memory.js");
const { WRITE_PROJECT_MEMORY_DEFINITION, writeProjectMemoryExecutor } =
  await import("../../src/tools/native/write_project_memory.js");
const { SandboxContext } = await import("../../src/sandbox/types.js");
const { NATIVE_TOOLS } = await import("../../src/tools/native/index.js");

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

test("memory tools: registered in NATIVE_TOOLS", () => {
  assert.ok(NATIVE_TOOLS.has("read_project_memory"));
  assert.ok(NATIVE_TOOLS.has("write_project_memory"));
});

test("memory tools: definitions declare correct auth categories", () => {
  assert.deepEqual(READ_PROJECT_MEMORY_DEFINITION.authorization_categories, ["filesystem_read"]);
  assert.deepEqual(WRITE_PROJECT_MEMORY_DEFINITION.authorization_categories, ["filesystem_write"]);
});

test("write_project_memory: rejects when no project slug in context", async () => {
  const res = await writeProjectMemoryExecutor(
    {
      id: "c1",
      name: "write_project_memory",
      arguments: { category: "decisions", entry: { summary: "x", rationale: "y" } },
    },
    ctx(),
  );
  assert.equal(res.success, false);
  assert.equal(res.error?.code, "NO_PROJECT");
});

test("write_project_memory: rejects unknown category", async () => {
  const res = await writeProjectMemoryExecutor(
    {
      id: "c2",
      name: "write_project_memory",
      arguments: { category: "songs", entry: { content: "x" } },
    },
    ctx({ project_slug: "p1" }),
  );
  assert.equal(res.success, false);
  assert.equal(res.error?.code, "INVALID_ARGS");
});

test("write_project_memory: rejects decisions entry missing summary", async () => {
  const res = await writeProjectMemoryExecutor(
    {
      id: "c3",
      name: "write_project_memory",
      arguments: { category: "decisions", entry: { rationale: "y" } },
    },
    ctx({ project_slug: "p1" }),
  );
  assert.equal(res.success, false);
  assert.equal(res.error?.code, "INVALID_ENTRY");
});

test("write_project_memory: writes a decisions entry and stamps brief_id from ctx", async () => {
  const res = await writeProjectMemoryExecutor(
    {
      id: "c4",
      name: "write_project_memory",
      arguments: { category: "decisions", entry: { summary: "use SQLite", rationale: "single file" } },
    },
    ctx({ project_slug: "tool-test-p1", brief_id: "2026-05-17-MT" }),
  );
  assert.equal(res.success, true);
  const written = JSON.parse(res.content).written;
  assert.equal(written.category, "decisions");
  assert.equal(written.summary, "use SQLite");
  assert.equal(written.brief_id, "2026-05-17-MT");
});

test("read_project_memory: returns written entries", async () => {
  await writeProjectMemoryExecutor(
    {
      id: "w1",
      name: "write_project_memory",
      arguments: {
        category: "knowledge",
        entry: { content: "we deploy via blue/green" },
      },
    },
    ctx({ project_slug: "tool-test-p2", brief_id: "B1" }),
  );
  const res = await readProjectMemoryExecutor(
    {
      id: "r1",
      name: "read_project_memory",
      arguments: { category: "knowledge" },
    },
    ctx({ project_slug: "tool-test-p2" }),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.count, 1);
  assert.equal(body.entries[0].content, "we deploy via blue/green");
});

test("read_project_memory: query filters substring case-insensitively", async () => {
  await writeProjectMemoryExecutor(
    { id: "w1", name: "write_project_memory", arguments: { category: "knowledge", entry: { content: "the API rate limit is 60/min" } } },
    ctx({ project_slug: "tool-test-p3" }),
  );
  await writeProjectMemoryExecutor(
    { id: "w2", name: "write_project_memory", arguments: { category: "knowledge", entry: { content: "logs are in CloudWatch" } } },
    ctx({ project_slug: "tool-test-p3" }),
  );
  const res = await readProjectMemoryExecutor(
    { id: "r1", name: "read_project_memory", arguments: { category: "knowledge", query: "RATE" } },
    ctx({ project_slug: "tool-test-p3" }),
  );
  assert.equal(res.success, true);
  const body = JSON.parse(res.content);
  assert.equal(body.count, 1);
});

test("read_project_memory: rejects when no project slug in context", async () => {
  const res = await readProjectMemoryExecutor(
    { id: "r1", name: "read_project_memory", arguments: { category: "decisions" } },
    ctx(),
  );
  assert.equal(res.success, false);
  assert.equal(res.error?.code, "NO_PROJECT");
});
