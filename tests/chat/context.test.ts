// v0.10.0 context loader: project memory + learned profile injection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-context-"));
process.env.OPENWAR_HOME = TMP;

const { loadContextForChat } = await import("../../src/chat/context.js");
const { appendMemoryEntry } = await import("../../src/state/memory.js");
const { buildLearnedProfile, saveLearnedProfile } = await import("../../src/state/learned-profile.js");

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
});

test("loadContextForChat: empty project produces empty notes and null summaries", async () => {
  const ctx = await loadContextForChat({ slug: "empty-proj" });
  assert.deepEqual(ctx.notes, []);
  assert.equal(ctx.memorySummary, null);
  assert.equal(ctx.learnedSummary, null);
  assert.equal(ctx.learnedProfile, null);
});

test("loadContextForChat: memory entries surface as notes + summary", async () => {
  await appendMemoryEntry("memproj", "decisions", { summary: "use tailwind", rationale: "matches existing site" });
  await appendMemoryEntry("memproj", "constraints", { rule: "no em-dashes", rationale: "house style" });
  const ctx = await loadContextForChat({ slug: "memproj" });
  assert.ok(ctx.notes.some((n) => /decision: use tailwind/.test(n)));
  assert.ok(ctx.notes.some((n) => /constraint: no em-dashes/.test(n)));
  assert.match(ctx.memorySummary ?? "", /1 prior decision\(s\)/);
});

test("loadContextForChat: learned profile surfaces as note + summary + loaded object", async () => {
  const profile = buildLearnedProfile({
    slug: "lproj",
    source_runs: ["a"],
    detectors: [{ detector: "blocker", sensitivity: "loose", reason: "x", fire_rate: 0.9, sample_size: 12 }],
    phase_budgets: [{ phase: "execute", tool_calls: 18, observed_p50: 8, observed_p90: 13, sample_size: 12 }],
    tools: [{ tool: "shell_exec", calls: 0, last_used: null, dead: true }],
    notes: [],
    generated_at: "2026-05-18T00:00:00Z",
  });
  saveLearnedProfile(profile);
  const ctx = await loadContextForChat({ slug: "lproj" });
  assert.ok(ctx.learnedProfile);
  assert.match(ctx.learnedSummary ?? "", /1 detector adjustment.*1 phase budget.*1 dead-tool callout/);
  assert.ok(ctx.notes.some((n) => /Learned profile loaded/.test(n)));
});

test("loadContextForChat: cap respected (per-category limit)", async () => {
  for (let i = 0; i < 10; i++) {
    await appendMemoryEntry("bigproj", "decisions", { summary: `decision ${i}`, rationale: "x" });
  }
  const ctx = await loadContextForChat({ slug: "bigproj", memoryEntryCap: 3 });
  // perCategory = 1; only 1 decision note should appear.
  const decisionNotes = ctx.notes.filter((n) => n.startsWith("decision:"));
  assert.equal(decisionNotes.length, 1);
});
