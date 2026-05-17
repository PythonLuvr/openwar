import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OW_HOME = mkdtempSync(join(tmpdir(), "openwar-memory-test-"));
process.env.OPENWAR_HOME = OW_HOME;

const {
  appendMemoryEntry,
  readMemory,
  removeMemoryEntry,
  renderMemoryForPrompt,
  MEMORY_CATEGORIES,
} = await import("../../src/state/memory.js");
const { memoryFile, projectDir } = await import("../../src/state/paths.js");

test.after(() => {
  rmSync(OW_HOME, { recursive: true, force: true });
});

test("memory: appendMemoryEntry writes a JSONL line and creates the project dir", async () => {
  const entry = await appendMemoryEntry("proj-a", "decisions", {
    summary: "use Postgres",
    rationale: "we already have ops for it",
  });
  assert.equal(entry.category, "decisions");
  assert.match(entry.id, /^mem-/);
  assert.ok(existsSync(projectDir("proj-a")));
  const file = memoryFile("proj-a", "decisions");
  const raw = readFileSync(file, "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  const parsed = JSON.parse(raw.trim()) as { summary: string; category: string };
  assert.equal(parsed.summary, "use Postgres");
  assert.equal(parsed.category, "decisions");
});

test("memory: readMemory returns reverse-chronological entries with default limit", async () => {
  for (let i = 0; i < 25; i++) {
    await appendMemoryEntry("proj-b", "knowledge", { content: `note ${i}` });
  }
  const { entries } = await readMemory("proj-b", { category: "knowledge" });
  // Default limit is 20. Reverse-chronological: last 20 (notes 5-24) with 24 first.
  assert.equal(entries.length, 20);
  assert.ok(entries[0]!.category === "knowledge");
  assert.equal((entries[0] as { content: string }).content, "note 24");
  assert.equal((entries[19] as { content: string }).content, "note 5");
});

test("memory: limit=0 means unlimited", async () => {
  const { entries } = await readMemory("proj-b", { category: "knowledge", limit: 0 });
  assert.equal(entries.length, 25);
});

test("memory: query does case-insensitive substring match against primary text", async () => {
  await appendMemoryEntry("proj-c", "constraints", { rule: "no force-push to main" });
  await appendMemoryEntry("proj-c", "constraints", { rule: "require code review on prod migrations" });
  await appendMemoryEntry("proj-c", "constraints", { rule: "tag releases with semver" });
  const { entries } = await readMemory("proj-c", { category: "constraints", query: "MIGRATION" });
  assert.equal(entries.length, 1);
  assert.match((entries[0] as { rule: string }).rule, /migration/i);
});

test("memory: corrupted JSONL lines are skipped and reported", async () => {
  const file = memoryFile("proj-d", "decisions");
  // Write a valid line, a corrupted line, then a valid line directly.
  await appendMemoryEntry("proj-d", "decisions", { summary: "A", rationale: "first" });
  appendFileSync(file, "this is not json\n", "utf8");
  await appendMemoryEntry("proj-d", "decisions", { summary: "B", rationale: "third" });
  const { entries, corrupted_lines } = await readMemory("proj-d", { category: "decisions" });
  assert.equal(entries.length, 2);
  assert.deepEqual(corrupted_lines, [2]);
});

test("memory: removeMemoryEntry deletes by id, preserves others, preserves corrupted lines", async () => {
  const a = await appendMemoryEntry("proj-e", "knowledge", { content: "keep me" });
  const b = await appendMemoryEntry("proj-e", "knowledge", { content: "remove me" });
  const file = memoryFile("proj-e", "knowledge");
  appendFileSync(file, "garbage\n", "utf8");
  const c = await appendMemoryEntry("proj-e", "knowledge", { content: "keep me too" });
  const removed = await removeMemoryEntry("proj-e", "knowledge", b.id);
  assert.equal(removed, true);
  const { entries, corrupted_lines } = await readMemory("proj-e", { category: "knowledge", limit: 0 });
  const ids = entries.map((e) => e.id);
  assert.deepEqual(ids, [c.id, a.id]); // reverse chronological
  assert.equal(corrupted_lines.length, 1); // the garbage line is still there
});

test("memory: removeMemoryEntry returns false when id not found", async () => {
  const removed = await removeMemoryEntry("proj-e", "knowledge", "does-not-exist");
  assert.equal(removed, false);
});

test("memory: readMemory returns empty when no file exists yet", async () => {
  const { entries, corrupted_lines } = await readMemory("never-written-to", { category: "decisions" });
  assert.deepEqual(entries, []);
  assert.deepEqual(corrupted_lines, []);
});

test("memory: renderMemoryForPrompt formats per-category sections and respects cap", async () => {
  for (let i = 0; i < 5; i++) {
    await appendMemoryEntry("proj-f", "decisions", {
      summary: `decision ${i}`,
      rationale: `because ${i}`,
    });
  }
  for (let i = 0; i < 3; i++) {
    await appendMemoryEntry("proj-f", "constraints", { rule: `rule ${i}` });
  }
  const out = await renderMemoryForPrompt("proj-f", { perCategoryLimit: 2 });
  assert.match(out, /Project memory/);
  assert.match(out, /Memory: decisions/);
  assert.match(out, /Memory: constraints/);
  // Knowledge category is empty for this project; should be omitted.
  assert.ok(!out.includes("Memory: knowledge"));
  // Cap=2 per category. Decisions section should have at most 2 entries.
  const decisionsSection = out.split("Memory: decisions")[1]?.split("Memory:")[0] ?? "";
  const decisionIds = decisionsSection.match(/\[mem-/g);
  assert.equal(decisionIds?.length, 2);
});

test("memory: renderMemoryForPrompt only emits requested categories", async () => {
  await appendMemoryEntry("proj-g", "decisions", { summary: "x", rationale: "y" });
  await appendMemoryEntry("proj-g", "knowledge", { content: "z" });
  const out = await renderMemoryForPrompt("proj-g", { categories: ["knowledge"] });
  assert.match(out, /Memory: knowledge/);
  assert.ok(!out.includes("Memory: decisions"));
});

test("memory: MEMORY_CATEGORIES exposes the canonical list", () => {
  assert.deepEqual([...MEMORY_CATEGORIES], ["decisions", "knowledge", "constraints"]);
});
