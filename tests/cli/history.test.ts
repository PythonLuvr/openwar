// v0.9.0 history CLI subcommand. Drives runs through the mock adapter so
// real trace files accumulate, then verifies the history report aggregates
// them correctly. Also covers --json output and the brief-scoped inspect
// --history flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v09-hist-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v09-hist-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { run } = await import("../../src/runner.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { createScriptedIO } = await import("../../src/io.js");
const { runHistory, formatHistoryReport } = await import("../../src/cli/history.js");
const { buildHistoryReport } = await import("../../src/state/history-report.js");

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

const BRIEF = (id: string, project = "history-test") => `---
project: ${project}
brief_id: ${id}
scope_locked: false
authorized_costs:
  - generation_credits
---

# Objective
Smoke.

# Deliverables
- one

# Constraints
None.

# Tools required
Text.

# Notes / unknowns
None.
`;

const CONF = `## Phase 0: Brief intake

**Confirmation Summary**

Objective: smoke
Deliverables: one
Constraints: none
Tools required: text
Unknowns: none

Ready, gated or auto-pilot?
`;
const COMP = `## Phase 4: Completion

Delivered: x.
Unresolved: none.
Open: none.

All deliverables shipped.`;

async function seedRun(id: string, project = "history-test"): Promise<void> {
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF(id, project), adapter, io, mode: "auto", ephemeral: false });
}

test("history: empty project reports zero samples without erroring", () => {
  let captured = "";
  const result = runHistory("never-existed", (s) => { captured += s; });
  assert.equal(result.report.sample_size, 0);
  assert.equal(result.runs.length, 0);
  assert.match(captured, /No traces found for project "never-existed"/);
});

test("history: aggregates across multiple seeded runs", async () => {
  await seedRun("2026-05-18-h1");
  await seedRun("2026-05-18-h2");
  await seedRun("2026-05-18-h3");
  let captured = "";
  const result = runHistory("history-test", (s) => { captured += s; });
  assert.equal(result.report.sample_size, 3);
  assert.deepEqual(result.report.source_runs.sort(), ["2026-05-18-h1", "2026-05-18-h2", "2026-05-18-h3"]);
  // Phase distribution should at least record intake + execute + completion + done.
  const phases = result.report.phase_distribution.map((p) => p.phase);
  assert.ok(phases.includes("execute"));
});

test("history: --json mode emits valid JSON that round-trips", () => {
  let captured = "";
  runHistory("history-test", (s) => { captured += s; }, { json: true });
  const parsed = JSON.parse(captured) as { schema_version: number; slug: string; sample_size: number };
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.slug, "history-test");
  assert.ok(parsed.sample_size >= 3);
});

test("history: --json output is deterministic across invocations of the same data", () => {
  let a = "";
  let b = "";
  runHistory("history-test", (s) => { a += s; }, { json: true });
  runHistory("history-test", (s) => { b += s; }, { json: true });
  // generated_at will differ; strip it before comparing the rest.
  const stripTs = (s: string) => s.replace(/"generated_at":\s*"[^"]+"/, '"generated_at":"<TS>"');
  assert.equal(stripTs(a), stripTs(b));
});

test("history: --since filter narrows the window", () => {
  let captured = "";
  // Filter to a future date; expect zero samples.
  runHistory("history-test", (s) => { captured += s; }, { since: "2099-01-01T00:00:00Z" });
  assert.match(captured, /sample_size:\s+0/);
});

test("history: --min-samples raises the thin-sample threshold", () => {
  let captured = "";
  runHistory("history-test", (s) => { captured += s; }, { minSamples: 100 });
  assert.match(captured, /Thin sample/);
});

test("history: text formatter contains tool usage section and notes", () => {
  let captured = "";
  runHistory("history-test", (s) => { captured += s; });
  assert.match(captured, /Tool usage:/);
  assert.match(captured, /Phase distribution:/);
  assert.match(captured, /Detector fires:/);
  assert.match(captured, /Notes:/);
  // v0.9.0 footer note about descriptive-only scope.
  assert.match(captured, /descriptive only/);
});

test("history: project with no traces but with traceless sessions reports them", () => {
  // No way to make a session without a trace in v0.8+, so call formatHistoryReport
  // directly with handcrafted traceless_brief_ids to verify the zero-sample
  // fallback path mentions them.
  const { report } = buildHistoryReport({ slug: "empty-project" });
  const out = formatHistoryReport(report, { traceless_brief_ids: ["legacy-id-1", "legacy-id-2"] });
  assert.match(out, /2 session\(s\) match the slug but have no trace file/);
  assert.match(out, /pre-v0\.8 runs/);
});
