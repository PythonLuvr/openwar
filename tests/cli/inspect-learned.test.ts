// v0.9.1 inspect --learned formatter. Renders the on-disk profile plus
// consultation history from the trace events. Reuses table() from inspect.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v091-il-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v091-il-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { formatLearnedView } = await import("../../src/cli/inspect-learned.js");
const { buildLearnedProfile } = await import("../../src/state/learned-profile.js");
type TraceEvent = import("../../src/state/trace.js").TraceEvent;

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

test("formatLearnedView: no profile produces a clear generate-one message", () => {
  const out = formatLearnedView({
    briefId: "b1",
    slug: "missing",
    profile: null,
    events: [],
  });
  assert.match(out, /No learned profile/);
  assert.match(out, /openwar learn missing/);
});

test("formatLearnedView: profile with overrides renders detector + budget + tool sections", () => {
  const profile = buildLearnedProfile({
    slug: "test",
    source_runs: ["a", "b"],
    detectors: [
      { detector: "blocker", sensitivity: "loose", reason: "FP rate 0.91", fire_rate: 0.91, sample_size: 12 },
      { detector: "banned_phrases", sensitivity: "disabled", reason: "noisy", fire_rate: 0.97, sample_size: 22 },
    ],
    phase_budgets: [
      { phase: "execute", tool_calls: 18, observed_p50: 8, observed_p90: 13, sample_size: 12 },
    ],
    tools: [
      { tool: "read_file", calls: 42, last_used: "2026-05-18T00:00:00Z", dead: false },
      { tool: "shell_exec", calls: 0, last_used: null, dead: true },
    ],
    notes: ["v0.9.1 conservative thresholds active"],
    generated_at: "2026-05-18T00:00:00Z",
  });
  const out = formatLearnedView({ briefId: "b", slug: "test", profile, events: [] });
  // Header.
  assert.match(out, /slug:\s+test/);
  assert.match(out, /schema_version:\s+1/);
  // Detector section with safety_critical flag on blocker.
  assert.match(out, /blocker\s+loose\s+safety_critical/);
  assert.match(out, /banned_phrases\s+disabled/);
  // Budget section.
  assert.match(out, /execute\s+18/);
  // Tool section + dead callout.
  assert.match(out, /shell_exec\s+0\s+-\s+DEAD/);
  assert.match(out, /1 dead tool\(s\): shell_exec/);
  // No consultation history -> the "may not have been loaded" hint.
  assert.match(out, /no learned_profile_applied event in this brief's trace/);
});

test("formatLearnedView: consultation history surfaces fired vs suppressed counts", () => {
  const profile = buildLearnedProfile({
    slug: "test",
    source_runs: ["a"],
    detectors: [
      { detector: "banned_phrases", sensitivity: "loose", reason: "x", fire_rate: 0.9, sample_size: 12 },
    ],
    phase_budgets: [],
    tools: [],
    notes: [],
    generated_at: "2026-05-18T00:00:00Z",
  });
  const events: TraceEvent[] = [
    { type: "learned_profile_applied", at: "t", slug: "test", schema_version: 1, applied: { detectors: 1, phase_budgets: 0, tool_callouts: 0 } },
    { type: "learned_sensitivity_consulted", at: "t", detector: "banned_phrases", sensitivity: "loose", fired: false },
    { type: "learned_sensitivity_consulted", at: "t", detector: "banned_phrases", sensitivity: "loose", fired: false },
    { type: "learned_sensitivity_consulted", at: "t", detector: "banned_phrases", sensitivity: "loose", fired: true },
  ];
  const out = formatLearnedView({ briefId: "b", slug: "test", profile, events });
  assert.match(out, /Applied at: t/);
  assert.match(out, /Detector consultations: 3/);
  assert.match(out, /fired:\s+1/);
  assert.match(out, /suppressed: 2/);
});

test("formatLearnedView: missing source_runs are marked with ?", () => {
  const profile = buildLearnedProfile({
    slug: "test",
    source_runs: ["a", "b", "c"],
    detectors: [],
    phase_budgets: [],
    tools: [],
    notes: [],
    generated_at: "t",
  });
  const out = formatLearnedView({
    briefId: "b",
    slug: "test",
    profile,
    events: [],
    missing_source_runs: ["b"],
  });
  // The `?` marker should appear on the line for source_run b only.
  const lines = out.split("\n");
  const bLine = lines.find((l) => l.includes("b") && !l.includes("brief_id") && !l.includes("slug"));
  assert.ok(bLine && /\?/.test(bLine));
  // Disclosure paragraph appears.
  assert.match(out, /trace file no longer on disk/);
});
