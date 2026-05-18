// v0.9.1 runner integration: brief with learned_profile: <slug> loads the
// profile at session start, threads sensitivity through the detector pass,
// emits the three new trace events. Missing profile is a soft warning.
// Brief-explicit behavior wins over learned profile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v091-runint-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v091-runint-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { run } = await import("../../src/runner.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { createScriptedIO } = await import("../../src/io.js");
const { readTrace } = await import("../../src/state/trace.js");
const { buildLearnedProfile, saveLearnedProfile } = await import("../../src/state/learned-profile.js");

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

const BRIEF_WITH = (id: string, slug: string, project = "runner-int") => `---
project: ${project}
brief_id: ${id}
scope_locked: false
authorized_costs:
  - generation_credits
learned_profile: ${slug}
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

const BRIEF_PLAIN = (id: string, project = "runner-int") => `---
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

function seedProfile(slug: string): void {
  const p = buildLearnedProfile({
    slug,
    source_runs: ["dummy"],
    detectors: [
      { detector: "banned_phrases", sensitivity: "loose", reason: "x", fire_rate: 0.9, sample_size: 12 },
    ],
    phase_budgets: [
      { phase: "execute", tool_calls: 14, observed_p50: 8, observed_p90: 9, sample_size: 12 },
    ],
    tools: [],
    notes: [],
    generated_at: "2026-05-18T00:00:00Z",
  });
  saveLearnedProfile(p);
}

test("runner: brief with learned_profile loads the profile and emits learned_profile_applied", async () => {
  seedProfile("runner-int");
  const id = "2026-05-18-li1";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF_WITH(id, "runner-int"), adapter, io, mode: "auto", ephemeral: false });
  const { events } = readTrace(id);
  const applied = events.find((e) => e.type === "learned_profile_applied") as
    | Extract<typeof events[number], { type: "learned_profile_applied" }>
    | undefined;
  assert.ok(applied, "expected learned_profile_applied event");
  assert.equal(applied.slug, "runner-int");
  assert.equal(applied.schema_version, 1);
  // banned_phrases override = 1 non-default detector.
  assert.equal(applied.applied.detectors, 1);
  // 1 phase budget.
  assert.equal(applied.applied.phase_budgets, 1);
});

test("runner: emits learned_budget_consulted at execute phase enter", async () => {
  const id = "2026-05-18-li2";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF_WITH(id, "runner-int"), adapter, io, mode: "auto", ephemeral: false });
  const { events } = readTrace(id);
  const budgetConsult = events.find((e) => e.type === "learned_budget_consulted") as
    | Extract<typeof events[number], { type: "learned_budget_consulted" }>
    | undefined;
  assert.ok(budgetConsult);
  assert.equal(budgetConsult.phase, "execute");
  assert.equal(budgetConsult.source, "learned");
  assert.equal(budgetConsult.recommended, 14);
  assert.equal(budgetConsult.active, 14);
});

test("runner: applied event fires exactly once per session", async () => {
  const id = "2026-05-18-li3";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF_WITH(id, "runner-int"), adapter, io, mode: "auto", ephemeral: false });
  const { events } = readTrace(id);
  const appliedCount = events.filter((e) => e.type === "learned_profile_applied").length;
  assert.equal(appliedCount, 1);
});

test("runner: missing profile is a soft warning, run still completes", async () => {
  const id = "2026-05-18-li4";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  const result = await run({
    briefSource: BRIEF_WITH(id, "no-such-slug"),
    adapter,
    io,
    mode: "auto",
    ephemeral: false,
  });
  assert.equal(result.completed, true);
  const { events } = readTrace(id);
  // No learned_profile_applied event since nothing loaded.
  assert.equal(events.some((e) => e.type === "learned_profile_applied"), false);
});

test("runner: plain brief (no learned_profile) emits no learned_* events", async () => {
  const id = "2026-05-18-li5";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF_PLAIN(id), adapter, io, mode: "auto", ephemeral: false });
  const { events } = readTrace(id);
  assert.equal(events.some((e) => e.type.startsWith("learned_")), false);
});

test("runner: detector sensitivity applies during execute (banned_phrases loose suppresses single-hit)", async () => {
  // The profile sets banned_phrases=loose. We craft an assistant turn that
  // would fire banned_phrases under default but should be suppressed under
  // loose (count must be >= 2). Then verify no detector_fired event for
  // banned_phrases.
  const id = "2026-05-18-li6";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([
    CONF,
    // One banned phrase. Loose suppresses since count < 2.
    `Step 1: That's absolutely true.\n\nStep 2: proceeding.`,
    COMP,
    "Final.",
  ]);
  await run({ briefSource: BRIEF_WITH(id, "runner-int"), adapter, io, mode: "auto", ephemeral: false });
  const { events } = readTrace(id);
  const bannedFire = events.find(
    (e) => e.type === "detector_fired" && (e as { detector?: string }).detector === "banned_phrases",
  );
  assert.equal(bannedFire, undefined, "expected banned_phrases suppressed under loose; instead it fired");
  // And the consultation record should be present.
  const consult = events.find(
    (e) => e.type === "learned_sensitivity_consulted" &&
      (e as { detector?: string }).detector === "banned_phrases",
  ) as Extract<typeof events[number], { type: "learned_sensitivity_consulted" }> | undefined;
  assert.ok(consult);
  assert.equal(consult.sensitivity, "loose");
  assert.equal(consult.fired, false);
});
