// v0.9.1 heuristics. Pins the conservative threshold constants so accidental
// tuning during refactors gets caught by a failing test. Verifies the three
// recommendation generators behave under sample-size / threshold rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DETECTOR_LOOSE_FIRE_RATE_BAR,
  DETECTOR_LOOSE_MIN_SAMPLES,
  DETECTOR_DISABLED_FIRE_RATE_BAR,
  DETECTOR_DISABLED_MIN_SAMPLES,
  PHASE_BUDGET_MIN_SAMPLES,
  PHASE_BUDGET_FORMULA,
  DEAD_TOOL_MIN_SAMPLES,
  DETECTOR_SAFETY,
  isSafetyCritical,
  recommendDetectorOverrides,
  recommendPhaseBudgets,
  recommendToolUsage,
  generateRecommendations,
} from "../../src/state/heuristics.js";
import type { HistoryReport, DetectorRow, PhaseDistributionRow, ToolUsageRow } from "../../src/state/history.js";

// -----------------------------------------------------------------------
// Constant pinning. Changing these requires updating the test AND a
// CHANGELOG paragraph explaining the real-world observation. See
// src/state/heuristics.ts header.

test("threshold constants are at the v0.9.1 conservative defaults", () => {
  assert.equal(DETECTOR_LOOSE_FIRE_RATE_BAR, 0.85);
  assert.equal(DETECTOR_LOOSE_MIN_SAMPLES, 10);
  assert.equal(DETECTOR_DISABLED_FIRE_RATE_BAR, 0.95);
  assert.equal(DETECTOR_DISABLED_MIN_SAMPLES, 20);
  assert.equal(PHASE_BUDGET_MIN_SAMPLES, 10);
  assert.equal(PHASE_BUDGET_FORMULA, "p90+5");
  assert.equal(DEAD_TOOL_MIN_SAMPLES, 10);
});

test("safety classification: blocker, destructive, completion, confirmation are critical", () => {
  assert.equal(DETECTOR_SAFETY.blocker, true);
  assert.equal(DETECTOR_SAFETY.destructive, true);
  assert.equal(DETECTOR_SAFETY.completion, false);
  assert.equal(DETECTOR_SAFETY.confirmation, false);
  assert.equal(DETECTOR_SAFETY.banned_phrases, false);
  assert.equal(DETECTOR_SAFETY.phase_marker, false);
  // Unknown detectors default to safety_critical (better to under-recommend).
  assert.equal(isSafetyCritical("never_heard_of_this"), true);
});

// -----------------------------------------------------------------------
// recommendDetectorOverrides.

function det(name: string, fires_per_run: number, runs_with_fire = 1, total_fires = 1): DetectorRow {
  return { detector: name, fires_per_run, runs_with_fire, total_fires };
}

test("recommendDetectorOverrides: sample below loose-min returns default with reason", () => {
  const rows = [det("blocker", 0.9)];
  const out = recommendDetectorOverrides(rows, 5); // < 10
  assert.equal(out[0]!.sensitivity, "default");
  assert.match(out[0]!.reason, /below DETECTOR_LOOSE_MIN_SAMPLES/);
});

test("recommendDetectorOverrides: fire_rate below bar at adequate sample returns default", () => {
  const rows = [det("blocker", 0.5)];
  const out = recommendDetectorOverrides(rows, 10);
  assert.equal(out[0]!.sensitivity, "default");
  assert.match(out[0]!.reason, /below DETECTOR_LOOSE_FIRE_RATE_BAR/);
});

test("recommendDetectorOverrides: above loose bar at 10 samples recommends loose", () => {
  const rows = [det("blocker", 0.9)];
  const out = recommendDetectorOverrides(rows, 10);
  assert.equal(out[0]!.sensitivity, "loose");
  assert.match(out[0]!.reason, />= 0\.85/);
});

test("recommendDetectorOverrides: safety_critical capped at loose even above disabled bar", () => {
  // blocker is safety_critical, sample=25, fire_rate=0.97 (above both bars)
  const rows = [det("blocker", 0.97)];
  const out = recommendDetectorOverrides(rows, 25);
  assert.equal(out[0]!.sensitivity, "loose");
  assert.match(out[0]!.reason, /Safety-critical detector capped at loose/);
});

test("recommendDetectorOverrides: non-safety detector above disabled bar gets disabled", () => {
  const rows = [det("banned_phrases", 0.98)];
  const out = recommendDetectorOverrides(rows, 25);
  assert.equal(out[0]!.sensitivity, "disabled");
  assert.match(out[0]!.reason, /Non-safety detector eligible for disabled/);
});

test("recommendDetectorOverrides: non-safety above bar but below disabled sample-min stays loose", () => {
  // sample=15: above loose-min (10), below disabled-min (20). fire_rate=0.97.
  const rows = [det("banned_phrases", 0.97)];
  const out = recommendDetectorOverrides(rows, 15);
  assert.equal(out[0]!.sensitivity, "loose");
});

// -----------------------------------------------------------------------
// recommendPhaseBudgets.

function phase(p: string, samples: number, p50 = 0, p90 = 0): PhaseDistributionRow {
  return { phase: p as PhaseDistributionRow["phase"], samples, total_calls: 0, p50, p90, max: p90, total_duration_ms: 0, avg_duration_ms: 0 };
}

test("recommendPhaseBudgets: omits phases below sample-min", () => {
  const rows = [phase("execute", 5, 10, 15)];
  const out = recommendPhaseBudgets(rows);
  assert.equal(out.length, 0);
});

test("recommendPhaseBudgets: applies p90+5 formula at 10+ samples", () => {
  const rows = [phase("execute", 10, 8, 12)];
  const out = recommendPhaseBudgets(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tool_calls, 17); // ceil(12) + 5
  assert.equal(out[0]!.observed_p50, 8);
  assert.equal(out[0]!.observed_p90, 12);
  assert.equal(out[0]!.sample_size, 10);
});

test("recommendPhaseBudgets: ceils non-integer p90", () => {
  const rows = [phase("execute", 10, 8, 12.4)];
  const out = recommendPhaseBudgets(rows);
  assert.equal(out[0]!.tool_calls, 18); // ceil(12.4) + 5
});

// -----------------------------------------------------------------------
// recommendToolUsage.

test("recommendToolUsage: dead flag requires DEAD_TOOL_MIN_SAMPLES", () => {
  const tools: ToolUsageRow[] = [{ tool: "read_file", calls: 5, last_used: "t", dead: false }];
  const below = recommendToolUsage(tools, 5);
  assert.equal(below[0]!.dead, false);
  const above = recommendToolUsage(tools, 10);
  assert.equal(above[0]!.dead, false); // calls > 0
});

test("recommendToolUsage: dead only when calls=0 AND sample>=10", () => {
  const tools: ToolUsageRow[] = [{ tool: "shell_exec", calls: 0, last_used: null, dead: false }];
  assert.equal(recommendToolUsage(tools, 5)[0]!.dead, false);
  assert.equal(recommendToolUsage(tools, 10)[0]!.dead, true);
  assert.equal(recommendToolUsage(tools, 100)[0]!.dead, true);
});

// -----------------------------------------------------------------------
// generateRecommendations composite.

function emptyReport(sample: number): HistoryReport {
  return {
    schema_version: 1,
    generated_at: "t",
    slug: "test",
    sample_size: sample,
    source_runs: [],
    window_start: null,
    window_end: null,
    tool_usage: [],
    phase_distribution: [],
    detectors: [],
    corrupted_lines_total: 0,
    notes: [],
  };
}

test("generateRecommendations: empty report with sub-threshold sample produces no-op notes", () => {
  const out = generateRecommendations(emptyReport(3));
  assert.ok(out.notes.some((n) => /conservative thresholds active/.test(n)));
  assert.ok(out.notes.some((n) => /below every recommendation threshold/.test(n)));
  assert.ok(out.notes.some((n) => /No actionable recommendations/.test(n)));
});

test("generateRecommendations: at 10+ runs with no triggers still emits no-op note", () => {
  const out = generateRecommendations(emptyReport(15));
  assert.ok(out.notes.some((n) => /No actionable recommendations/.test(n)));
});

test("generateRecommendations: emits the threshold-summary note on every call", () => {
  const out = generateRecommendations(emptyReport(100));
  const summary = out.notes.find((n) => /LOOSE bar=/.test(n))!;
  assert.match(summary, /LOOSE bar=0\.85\/10 runs/);
  assert.match(summary, /DISABLED bar=0\.95\/20 runs/);
  assert.match(summary, /BUDGET min=10 runs/);
  assert.match(summary, /formula=p90\+5/);
  assert.match(summary, /DEAD bar=10 runs/);
});
