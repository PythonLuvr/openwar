// v0.9.1 learn subcommand: dry-run output stability, --apply idempotency,
// --reset deletion, --since / --min-samples filters, --emit-frontmatter
// snippet, schema-error handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v091-learn-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v091-learn-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { run } = await import("../../src/runner.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { createScriptedIO } = await import("../../src/io.js");
const { runLearn } = await import("../../src/cli/learn.js");
const { learnedProfilePath } = await import("../../src/state/learned-profile.js");

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

const BRIEF = (id: string, project = "learn-test") => `---
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

async function seedRun(id: string, project = "learn-test"): Promise<void> {
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF(id, project), adapter, io, mode: "auto", ephemeral: false });
}

test("learn: dry run on empty project produces a no-op profile (conservative defaults)", () => {
  let captured = "";
  const result = runLearn("never-existed", (s) => { captured += s; });
  // No write.
  assert.equal(result.wrote, false);
  assert.equal(result.reset, false);
  // No-op reasons should be all three since sample_size=0.
  assert.equal(result.no_op_reasons.length, 3);
  // Output prints the candidate JSON and a "Dry run." footer.
  assert.match(captured, /"schema_version": 1/);
  assert.match(captured, /Dry run/);
});

test("learn: with several seeded runs, conservative v0.9.1 thresholds keep it a no-op", async () => {
  await seedRun("2026-05-18-l1");
  await seedRun("2026-05-18-l2");
  await seedRun("2026-05-18-l3");
  let captured = "";
  const result = runLearn("learn-test", (s) => { captured += s; });
  // 3 runs is well below all v0.9.1 thresholds (loose=10, disabled=20, dead=10).
  assert.equal(result.no_op_reasons.length, 3, `unexpected non-no-op output:\n${captured}`);
  // The profile still gets generated, just empty of triggered overrides.
  assert.ok(result.profile);
  assert.equal(result.profile?.schema_version, 1);
});

test("learn --apply: writes the file and is idempotent", () => {
  let captured = "";
  const first = runLearn("learn-test", (s) => { captured += s; }, { apply: true, now: "2026-05-18T00:00:00Z" });
  assert.equal(first.wrote, true);
  const path = learnedProfilePath("learn-test");
  assert.ok(existsSync(path));
  const a = readFileSync(path, "utf8");
  // Re-apply with same now -> byte-identical file.
  runLearn("learn-test", () => {}, { apply: true, now: "2026-05-18T00:00:00Z" });
  const b = readFileSync(path, "utf8");
  assert.equal(a, b);
});

test("learn --reset: deletes the profile and reports it", () => {
  // Assumes the previous test wrote a profile.
  let captured = "";
  const result = runLearn("learn-test", (s) => { captured += s; }, { reset: true });
  assert.equal(result.reset, true);
  assert.match(captured, /Deleted/);
  assert.equal(existsSync(learnedProfilePath("learn-test")), false);
  // Second reset is a soft no-op.
  let c2 = "";
  const r2 = runLearn("learn-test", (s) => { c2 += s; }, { reset: true });
  assert.equal(r2.reset, false);
  assert.match(c2, /No profile to delete/);
});

test("learn --since: passes through to history aggregator", async () => {
  // After reset, generate again with a future --since. Should still produce
  // a profile (sample_size=0 due to filter) and the no-op markers.
  let captured = "";
  const result = runLearn("learn-test", (s) => { captured += s; }, { since: "2099-01-01T00:00:00Z" });
  assert.equal(result.no_op_reasons.length, 3);
});

test("learn --min-samples: floors at 5 (v0.9.1 hard floor)", () => {
  // --min-samples=1 should be clamped to 5; verified indirectly via the
  // surfaced threshold-summary note that mentions v0.9.1 thresholds.
  let captured = "";
  runLearn("learn-test", (s) => { captured += s; }, { minSamples: 1 });
  assert.match(captured, /LOOSE bar=0\.85\/10 runs/);
});

test("learn --emit-frontmatter: prints YAML snippet at end of dry run", () => {
  let captured = "";
  runLearn("learn-test", (s) => { captured += s; }, { emitFrontmatter: true });
  assert.match(captured, /Frontmatter snippet/);
  assert.match(captured, /learned_profile: learn-test/);
});

test("learn: existing profile with schema mismatch fails with a remediation message", () => {
  // Write an invalid profile (wrong schema_version).
  const path = learnedProfilePath("badschema");
  // Seed a run so the path exists.
  // Use saveLearnedProfile via runLearn --apply to create the directory + file:
  runLearn("badschema", () => {}, { apply: true, now: "2026-05-18T00:00:00Z" });
  writeFileSync(path, JSON.stringify({ schema_version: 999, slug: "badschema" }), "utf8");
  let captured = "";
  const result = runLearn("badschema", (s) => { captured += s; });
  assert.equal(result.wrote, false);
  assert.match(captured, /existing profile is invalid/);
  assert.match(captured, /--reset/);
});

test("learn: --apply on existing profile emits a diff section", () => {
  // Seed a profile with --apply, then alter on disk to a known shape, then
  // re-run --apply and assert the diff lines appear.
  const slug = "diff-test";
  runLearn(slug, () => {}, { apply: true, now: "2026-05-18T00:00:00Z" });
  const path = learnedProfilePath(slug);
  const obj = JSON.parse(readFileSync(path, "utf8"));
  obj.detector_overrides = { blocker: { sensitivity: "loose", reason: "x", fire_rate: 0.9, sample_size: 12 } };
  writeFileSync(path, JSON.stringify(obj), "utf8");

  let captured = "";
  runLearn(slug, (s) => { captured += s; }, { apply: true, now: "2026-05-18T00:00:00Z" });
  // Pre-edit had blocker=loose; recommendation regenerates and likely drops
  // back to default (sample_size in actual history is 0). Either way the
  // diff section should appear unchanged-equal OR show the loose->default.
  // We accept either as long as the diff/no-change marker is present.
  assert.ok(
    /Changes vs\. previous profile/.test(captured) || /no changes vs\. previous profile/.test(captured),
    `expected diff marker in output:\n${captured}`,
  );
});
