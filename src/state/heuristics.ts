// v0.9.1: conservative-threshold heuristics. The plumbing is the deliverable.
// The constants are the patch-release dial.
//
// The first usable recommendation arrives somewhere around run 10 for tools,
// later for detectors. Operators on run 1-9 see "no recommendations yet."
// This is intentional: shipping plumbing today lets v0.9.2+ tune values
// against real distributions instead of synthetic guesses.
//
// Pure functions over the v0.9.0 HistoryReport shape. No I/O.

import type { HistoryReport, DetectorRow, PhaseDistributionRow, ToolUsageRow } from "./history.js";

// ---------------------------------------------------------------------------
// Threshold constants.
//
// Patch releases (v0.9.2+) adjust these. Changing a constant must come with a
// paragraph in the CHANGELOG explaining the real-world observation that
// justified the change. Tests in tests/state/heuristics.test.ts pin the
// current values so an accidental tuning during refactors gets caught.

/**
 * Minimum observed fire rate (fires per run) before recommending `loose`
 * for a detector.
 *
 * Lower this only when: real traces show that detectors firing at 0.85+
 * fires/run reliably indicate the detector is noisier than useful for a
 * specific project. Until that observation lands, 0.85 means "fired more
 * often than not"; a detector at 0.6 fires/run is too easily a real signal
 * to start suppressing.
 */
export const DETECTOR_LOOSE_FIRE_RATE_BAR = 0.85;

/**
 * Minimum sample size before considering a detector for `loose`.
 *
 * Lower this only when: a smaller sample reliably surfaces project-specific
 * detector behavior. v0.9.1 starts at 10 because 5-run samples produce
 * noisy quantiles and we'd rather no-op than mis-recommend.
 */
export const DETECTOR_LOOSE_MIN_SAMPLES = 10;

/**
 * Minimum observed fire rate before recommending `disabled` for a
 * non-safety detector.
 *
 * Lower this only when: a detector firing at >0.95 across a large sample
 * is overwhelmingly seen as wrong by operators in real use. Even then,
 * recommending disabled is destructive; the operator can always override.
 */
export const DETECTOR_DISABLED_FIRE_RATE_BAR = 0.95;

/**
 * Minimum sample size before recommending `disabled`.
 *
 * Lower this only when: a smaller sample is somehow more reliable than
 * a larger one. (It isn't. Don't lower this.)
 */
export const DETECTOR_DISABLED_MIN_SAMPLES = 20;

/**
 * Minimum sample size before recommending a phase budget.
 *
 * Lower this only when: quantile math on smaller samples produces stable
 * recommendations in observed real-world distributions. Until then,
 * 10 runs is the floor for p90+5 to mean anything.
 */
export const PHASE_BUDGET_MIN_SAMPLES = 10;

/**
 * Minimum sample size before declaring a tool dead.
 *
 * Higher than v0.9.0's dead-tool threshold of 3 because a learned profile
 * acts on this recommendation; v0.9.0 only displayed it.
 *
 * Lower this only when: 3-9-run samples have empirically caught dead tools
 * that 10+-run samples would have flagged anyway. Until then, 10 is the
 * safe floor before the runner trusts a "dead" verdict.
 */
export const DEAD_TOOL_MIN_SAMPLES = 10;

/**
 * Phase-budget formula identifier. Documented in CHANGELOG so anyone
 * reading the profile knows which formula produced the value. Patch
 * releases that change the formula bump this string and update the
 * profile's `notes` field.
 */
export const PHASE_BUDGET_FORMULA: "p90+5" = "p90+5";

// ---------------------------------------------------------------------------
// Detector safety classification.
//
// `safety_critical: true` blocks the heuristics module from ever recommending
// `disabled` for that detector. Operator can still set sensitivity manually
// in the brief frontmatter; the heuristic just won't propose it.

export const DETECTOR_SAFETY: Record<string, boolean> = {
  blocker: true,
  destructive: true,
  confirmation: false,
  banned_phrases: false,
  phase_marker: false,
  completion: false,
};

export function isSafetyCritical(detector: string): boolean {
  // Unknown detectors default to safety-critical. Better to under-recommend
  // than to disable something the heuristic doesn't know about.
  return DETECTOR_SAFETY[detector] ?? true;
}

// ---------------------------------------------------------------------------
// Recommendation shapes. These mirror the learned-profile schema fields so
// the learn subcommand can assemble a profile by concatenating the outputs
// of the three generators below.

export type Sensitivity = "default" | "loose" | "strict" | "disabled";

export interface DetectorRecommendation {
  detector: string;
  sensitivity: Sensitivity;
  reason: string;
  fire_rate: number;
  sample_size: number;
}

export interface PhaseBudgetRecommendation {
  phase: string;
  tool_calls: number;
  observed_p50: number;
  observed_p90: number;
  sample_size: number;
}

export interface ToolUsageRecommendation {
  tool: string;
  calls: number;
  last_used: string | null;
  dead: boolean;
}

// ---------------------------------------------------------------------------
// Generators. Each takes the relevant slice of a HistoryReport and returns
// a list of recommendations. Sample-size and threshold gates are applied
// here; below the bar means an explicit `default` recommendation rather
// than silence, so the profile is auditable ("we considered it and chose
// default because sample was too small").

export function recommendDetectorOverrides(
  detectors: readonly DetectorRow[],
  sampleSize: number,
): DetectorRecommendation[] {
  const out: DetectorRecommendation[] = [];
  for (const d of detectors) {
    const safetyCritical = isSafetyCritical(d.detector);
    // Step down through the bars in strict-first order: disabled, loose,
    // default. Below the loose bar gets an explicit default with reason.
    if (
      !safetyCritical &&
      sampleSize >= DETECTOR_DISABLED_MIN_SAMPLES &&
      d.fires_per_run >= DETECTOR_DISABLED_FIRE_RATE_BAR
    ) {
      out.push({
        detector: d.detector,
        sensitivity: "disabled",
        reason: `Fires per run ${d.fires_per_run} >= ${DETECTOR_DISABLED_FIRE_RATE_BAR} over ${sampleSize} runs. Non-safety detector eligible for disabled.`,
        fire_rate: d.fires_per_run,
        sample_size: sampleSize,
      });
      continue;
    }
    if (
      sampleSize >= DETECTOR_LOOSE_MIN_SAMPLES &&
      d.fires_per_run >= DETECTOR_LOOSE_FIRE_RATE_BAR
    ) {
      out.push({
        detector: d.detector,
        sensitivity: "loose",
        reason: safetyCritical
          ? `Fires per run ${d.fires_per_run} >= ${DETECTOR_LOOSE_FIRE_RATE_BAR} over ${sampleSize} runs. Safety-critical detector capped at loose (disabled not allowed).`
          : `Fires per run ${d.fires_per_run} >= ${DETECTOR_LOOSE_FIRE_RATE_BAR} over ${sampleSize} runs.`,
        fire_rate: d.fires_per_run,
        sample_size: sampleSize,
      });
      continue;
    }
    out.push({
      detector: d.detector,
      sensitivity: "default",
      reason:
        sampleSize < DETECTOR_LOOSE_MIN_SAMPLES
          ? `Sample size ${sampleSize} below DETECTOR_LOOSE_MIN_SAMPLES (${DETECTOR_LOOSE_MIN_SAMPLES}); no override yet.`
          : `Fires per run ${d.fires_per_run} below DETECTOR_LOOSE_FIRE_RATE_BAR (${DETECTOR_LOOSE_FIRE_RATE_BAR}); detector is operating within expected range.`,
      fire_rate: d.fires_per_run,
      sample_size: sampleSize,
    });
  }
  return out;
}

export function recommendPhaseBudgets(
  phases: readonly PhaseDistributionRow[],
): PhaseBudgetRecommendation[] {
  const out: PhaseBudgetRecommendation[] = [];
  for (const p of phases) {
    if (p.samples < PHASE_BUDGET_MIN_SAMPLES) continue;
    // v0.9.1 formula: p90 + 5. Documented in PHASE_BUDGET_FORMULA constant.
    // Why p90 instead of p50+IQR: long-tail distributions are likely; p50
    // alone under-budgets the realistic-ceiling case. +5 absorbs a small
    // buffer without inflating budgets on tight runs. Tune in v0.9.2+.
    const recommended = Math.ceil(p.p90) + 5;
    out.push({
      phase: p.phase,
      tool_calls: recommended,
      observed_p50: p.p50,
      observed_p90: p.p90,
      sample_size: p.samples,
    });
  }
  return out;
}

export function recommendToolUsage(
  tools: readonly ToolUsageRow[],
  sampleSize: number,
): ToolUsageRecommendation[] {
  return tools.map((t) => ({
    tool: t.tool,
    calls: t.calls,
    last_used: t.last_used,
    // Override v0.9.0's threshold (3) with the higher learned-profile
    // threshold (10). Runtime acts on `dead`; bar has to be conservative.
    dead: t.calls === 0 && sampleSize >= DEAD_TOOL_MIN_SAMPLES,
  }));
}

// ---------------------------------------------------------------------------
// Composite: build the recommendations needed by the learn subcommand from
// a single HistoryReport. The CLI assembles the actual JSON profile around
// these arrays.

export interface AllRecommendations {
  detectors: DetectorRecommendation[];
  phase_budgets: PhaseBudgetRecommendation[];
  tools: ToolUsageRecommendation[];
  // Operator-facing summary lines: which thresholds tripped, which didn't,
  // and why. These end up in the profile's `notes` field.
  notes: string[];
}

export function generateRecommendations(report: HistoryReport): AllRecommendations {
  const detectors = recommendDetectorOverrides(report.detectors, report.sample_size);
  const phase_budgets = recommendPhaseBudgets(report.phase_distribution);
  const tools = recommendToolUsage(report.tool_usage, report.sample_size);

  const notes: string[] = [];
  notes.push(
    `v0.9.1 conservative thresholds active: LOOSE bar=${DETECTOR_LOOSE_FIRE_RATE_BAR}/${DETECTOR_LOOSE_MIN_SAMPLES} runs, DISABLED bar=${DETECTOR_DISABLED_FIRE_RATE_BAR}/${DETECTOR_DISABLED_MIN_SAMPLES} runs, BUDGET min=${PHASE_BUDGET_MIN_SAMPLES} runs, formula=${PHASE_BUDGET_FORMULA}, DEAD bar=${DEAD_TOOL_MIN_SAMPLES} runs.`,
  );
  if (report.sample_size < DETECTOR_LOOSE_MIN_SAMPLES) {
    notes.push(
      `Sample size ${report.sample_size} is below every recommendation threshold. Profile is effectively a no-op; rerun after more runs accumulate.`,
    );
  }
  const anyNonDefault = detectors.some((d) => d.sensitivity !== "default");
  const anyBudget = phase_budgets.length > 0;
  const anyDead = tools.some((t) => t.dead);
  if (!anyNonDefault && !anyBudget && !anyDead) {
    notes.push(`No actionable recommendations at current sample size + threshold bars. This is expected behavior for early use of v0.9.1.`);
  }
  return { detectors, phase_budgets, tools, notes };
}
