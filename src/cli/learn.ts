// v0.9.1: `openwar learn <slug>`.
//
// Reads accumulated trace files via the v0.9.0 history aggregator, applies
// the heuristic recommendation generators with conservative thresholds, and
// either prints the candidate profile (default) or writes it to disk
// (--apply). Authorization: filesystem_read for the dry run, filesystem_write
// for --apply / --reset.
//
// Conservative-defaults posture: with v0.9.1 thresholds, the first 9 runs
// against any project produce a profile that is effectively a no-op. This
// is intentional. v0.9.2+ patch releases tune the thresholds against real
// distributions.

import { existsSync } from "node:fs";
import { buildHistoryReport } from "../state/history-report.js";
import { generateRecommendations } from "../state/heuristics.js";
import {
  buildLearnedProfile,
  saveLearnedProfile,
  deleteLearnedProfile,
  loadLearnedProfile,
  learnedProfilePath,
  LearnedProfileSchemaError,
  type LearnedProfile,
} from "../state/learned-profile.js";
import { stringifyDeterministic } from "../state/history.js";

export interface RunLearnOptions {
  apply?: boolean;
  reset?: boolean;
  since?: string;
  minSamples?: number;
  emitFrontmatter?: boolean;
  // Override the wall-clock for tests (deterministic generated_at).
  now?: string;
}

export interface RunLearnResult {
  // The candidate profile that was generated (or null when --reset was set).
  profile: LearnedProfile | null;
  // The on-disk path that would be written / was written / was deleted.
  path: string;
  // True when --apply landed a write.
  wrote: boolean;
  // True when --reset deleted an existing profile.
  reset: boolean;
  // Diff lines vs. the existing profile (empty when no existing profile or
  // when --reset). One line per detector/budget/tool that changed.
  diff: string[];
  // When this is non-empty, the profile is "effectively no-op" at the
  // current sample size + thresholds. The CLI prints this prominently.
  no_op_reasons: string[];
}

export function runLearn(slug: string, write: (s: string) => void, opts: RunLearnOptions = {}): RunLearnResult {
  const path = learnedProfilePath(slug);

  // --reset: delete and exit early.
  if (opts.reset) {
    const existed = deleteLearnedProfile(slug);
    write(existed ? `Deleted ${path}\n` : `No profile to delete at ${path}\n`);
    return { profile: null, path, wrote: false, reset: existed, diff: [], no_op_reasons: [] };
  }

  // Load existing for diff comparison. Schema errors surface as a hard
  // error here: the operator should regenerate rather than overlay on top
  // of a malformed file.
  let existing: LearnedProfile | null = null;
  try {
    existing = loadLearnedProfile(slug);
  } catch (err) {
    if (err instanceof LearnedProfileSchemaError) {
      write(`existing profile is invalid: ${err.message}\n`);
      write(`re-run with --reset to remove it, or fix ${err.path} by hand.\n`);
      return { profile: null, path, wrote: false, reset: false, diff: [], no_op_reasons: [err.message] };
    }
    throw err;
  }

  // v0.9.1 floor for --min-samples is 5. The brief sets DETECTOR_LOOSE_MIN
  // at 10, so 5 is the absolute floor below which a profile can do nothing
  // useful. We clamp here rather than error so the operator's intent ("be
  // more lenient with samples") still lands at the safest available value.
  const minSamples = opts.minSamples !== undefined ? Math.max(opts.minSamples, 5) : 10;

  // History aggregation reuses the v0.9.0 module exactly.
  const buildOpts: { slug: string; minSamples?: number; since?: string } = { slug, minSamples };
  if (opts.since !== undefined) buildOpts.since = opts.since;
  const { report } = buildHistoryReport(buildOpts);
  const recs = generateRecommendations(report);

  const profile = buildLearnedProfile({
    slug,
    source_runs: report.source_runs,
    detectors: recs.detectors,
    phase_budgets: recs.phase_budgets,
    tools: recs.tools,
    notes: recs.notes,
    ...(opts.now ? { generated_at: opts.now } : {}),
  });

  // Compute the "no-op" check. A profile is effectively a no-op when there
  // are no non-default detectors, no phase budgets, and no dead tools.
  const no_op_reasons: string[] = [];
  const anyNonDefault = Object.values(profile.detector_overrides).some((o) => o.sensitivity !== "default");
  const anyBudgets = Object.keys(profile.phase_budgets).length > 0;
  const anyDead = Object.values(profile.tool_usage).some((t) => t.dead);
  if (!anyNonDefault) no_op_reasons.push("no detectors above the sensitivity threshold");
  if (!anyBudgets) no_op_reasons.push("no phases at the budget min-samples threshold");
  if (!anyDead) no_op_reasons.push("no tools at the dead-tool min-samples threshold");

  const diff = diffProfile(existing, profile);

  // --apply: write the file, surface what changed.
  if (opts.apply) {
    const wpath = saveLearnedProfile(profile);
    write(`Wrote ${wpath}\n`);
    if (diff.length > 0) {
      write(`\nChanges vs. previous profile:\n`);
      for (const line of diff) write(`  ${line}\n`);
    } else if (!existing) {
      write(`(new profile; ${profile.source_runs.length} source run(s).)\n`);
    } else {
      write(`(no changes vs. previous profile.)\n`);
    }
    if (no_op_reasons.length === 3) {
      write(`\nNote: this profile is effectively a no-op at current sample size and v0.9.1 thresholds (${no_op_reasons.join("; ")}). Rerun once more traces accumulate.\n`);
    }
    return { profile, path: wpath, wrote: true, reset: false, diff, no_op_reasons };
  }

  // Dry run: print candidate as deterministic JSON, then summary.
  write(stringifyDeterministic(profile) + "\n");
  write(`\nDry run. Apply with: openwar learn ${slug} --apply\n`);
  if (no_op_reasons.length === 3) {
    write(`Note: this profile would be a no-op at current sample size and v0.9.1 thresholds (${no_op_reasons.join("; ")}).\n`);
  }
  if (diff.length > 0) {
    write(`\nChanges vs. existing profile at ${path}:\n`);
    for (const line of diff) write(`  ${line}\n`);
  } else if (existing) {
    write(`\n(No changes vs. existing profile at ${path}.)\n`);
  } else if (!existsSync(path)) {
    write(`\n(No existing profile at ${path}.)\n`);
  }

  if (opts.emitFrontmatter) {
    write(`\nFrontmatter snippet to paste into a brief:\n`);
    write(`---\nlearned_profile: ${slug}\n---\n`);
  }

  return { profile, path, wrote: false, reset: false, diff, no_op_reasons };
}

// Build a human-readable diff between two profiles. Determinism: walk keys in
// sorted order so the output is byte-stable for byte-stable inputs.
function diffProfile(prev: LearnedProfile | null, next: LearnedProfile): string[] {
  if (!prev) return [];
  const lines: string[] = [];
  const detectorKeys = sortedUnion(Object.keys(prev.detector_overrides), Object.keys(next.detector_overrides));
  for (const k of detectorKeys) {
    const a = prev.detector_overrides[k]?.sensitivity ?? "(absent)";
    const b = next.detector_overrides[k]?.sensitivity ?? "(absent)";
    if (a !== b) lines.push(`detector ${k}: ${a} -> ${b}`);
  }
  const budgetKeys = sortedUnion(Object.keys(prev.phase_budgets), Object.keys(next.phase_budgets));
  for (const k of budgetKeys) {
    const a = prev.phase_budgets[k]?.tool_calls ?? "(absent)";
    const b = next.phase_budgets[k]?.tool_calls ?? "(absent)";
    if (a !== b) lines.push(`budget ${k}: ${a} -> ${b}`);
  }
  const toolKeys = sortedUnion(Object.keys(prev.tool_usage), Object.keys(next.tool_usage));
  for (const k of toolKeys) {
    const a = prev.tool_usage[k]?.dead;
    const b = next.tool_usage[k]?.dead;
    if (a !== b) lines.push(`tool ${k} dead: ${String(a ?? "(absent)")} -> ${String(b ?? "(absent)")}`);
  }
  return lines;
}

function sortedUnion(a: readonly string[], b: readonly string[]): string[] {
  return Array.from(new Set([...a, ...b])).sort();
}
