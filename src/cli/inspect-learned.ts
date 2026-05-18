// v0.9.1: `openwar inspect <brief_id> --learned`.
//
// Shows what the brief's learned profile would apply if loaded at session
// start (or what was loaded, for a completed run). Combines:
//   1. The on-disk learned.json for the brief's project slug.
//   2. The trace events from the brief's run (if any) that show what
//      actually got consulted vs. fired.
//
// Reuses the `table()` helper from inspect.ts.

import type { LearnedProfile } from "../state/learned-profile.js";
import type { TraceEvent } from "../state/trace.js";
import { isSafetyCritical } from "../state/heuristics.js";
import { table } from "./inspect.js";

export interface LearnedViewOptions {
  // The brief_id whose run is being inspected. Used in the header.
  briefId: string;
  // Project slug the brief belongs to (from session metadata).
  slug: string;
  // The on-disk profile (or null when there is no profile for this slug).
  profile: LearnedProfile | null;
  // Trace events for the brief; the formatter filters for the v0.9.1
  // learned_* event types to surface consultation history.
  events: readonly TraceEvent[];
  // brief_ids that fed the profile but are missing from the local sessions
  // dir. These get a `?` marker in the source_runs output.
  missing_source_runs?: readonly string[];
}

export function formatLearnedView(opts: LearnedViewOptions): string {
  const out: string[] = [];
  out.push(`Learned profile view`);
  out.push(`  brief_id:       ${opts.briefId}`);
  out.push(`  slug:           ${opts.slug}`);

  if (!opts.profile) {
    out.push("");
    out.push(`No learned profile on disk for "${opts.slug}".`);
    out.push(`Generate one via: openwar learn ${opts.slug}`);
    return out.join("\n") + "\n";
  }
  const p = opts.profile;
  out.push(`  generated_at:   ${p.generated_at}`);
  out.push(`  schema_version: ${p.schema_version}`);
  out.push(`  source_runs:    ${p.source_runs.length}`);
  out.push("");

  // Source runs with missing-on-disk markers (`?`).
  const missing = new Set(opts.missing_source_runs ?? []);
  out.push(`Source runs:`);
  for (const id of p.source_runs) out.push(`  ${missing.has(id) ? "?" : " "} ${id}`);
  if (missing.size > 0) out.push(`  (?) trace file no longer on disk; recommendation still derived from that data point.`);
  out.push("");

  // Detector overrides.
  out.push(`Detector overrides:`);
  const detectorRows = Object.entries(p.detector_overrides)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, o]) => [
      name,
      o.sensitivity,
      isSafetyCritical(name) ? "safety_critical" : "",
      formatNumber(o.fire_rate),
      String(o.sample_size),
      o.reason.length > 60 ? o.reason.slice(0, 57) + "..." : o.reason,
    ]);
  if (detectorRows.length === 0) {
    out.push(`  (none)`);
  } else {
    out.push(indent(table(
      ["detector", "sensitivity", "flag", "fire_rate", "sample", "reason"],
      detectorRows,
    )));
  }
  out.push("");

  // Phase budgets.
  out.push(`Phase budgets:`);
  const budgetRows = Object.entries(p.phase_budgets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([phase, b]) => [
      phase,
      String(b.tool_calls),
      `p50=${formatNumber(b.observed_p50)}`,
      `p90=${formatNumber(b.observed_p90)}`,
      `sample=${b.sample_size}`,
    ]);
  if (budgetRows.length === 0) {
    out.push(`  (none)`);
  } else {
    out.push(indent(table(
      ["phase", "tool_calls", "p50", "p90", "sample"],
      budgetRows,
    )));
  }
  out.push("");

  // Tool usage (dead callouts elevated).
  const deadTools = Object.entries(p.tool_usage).filter(([, t]) => t.dead).map(([name]) => name);
  out.push(`Tool usage:`);
  if (Object.keys(p.tool_usage).length === 0) {
    out.push(`  (no tool usage recorded)`);
  } else {
    const toolRows = Object.entries(p.tool_usage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, t]) => [name, String(t.calls), t.last_used ?? "-", t.dead ? "DEAD" : ""]);
    out.push(indent(table(["tool", "calls", "last_used", "flag"], toolRows)));
    if (deadTools.length > 0) {
      out.push(`  ${deadTools.length} dead tool(s): ${deadTools.join(", ")}. Consider removing from briefs.`);
    }
  }
  out.push("");

  // Consultation summary from trace events (only meaningful for completed
  // runs with a profile applied).
  const consults = opts.events.filter((e) => e.type === "learned_sensitivity_consulted") as Array<Extract<TraceEvent, { type: "learned_sensitivity_consulted" }>>;
  const applied = opts.events.find((e) => e.type === "learned_profile_applied") as Extract<TraceEvent, { type: "learned_profile_applied" }> | undefined;
  out.push(`Consultation summary:`);
  if (!applied && consults.length === 0) {
    out.push(`  (no learned_profile_applied event in this brief's trace; profile may not have been loaded for this run)`);
  } else {
    if (applied) {
      out.push(`  Applied at: ${applied.at}`);
      out.push(`  Counts:     detectors=${applied.applied.detectors} budgets=${applied.applied.phase_budgets} dead=${applied.applied.tool_callouts}`);
    }
    if (consults.length > 0) {
      out.push(`  Detector consultations: ${consults.length}`);
      const firedCount = consults.filter((c) => c.fired).length;
      const suppressedCount = consults.length - firedCount;
      out.push(`    fired:      ${firedCount}`);
      out.push(`    suppressed: ${suppressedCount}`);
    }
  }
  out.push("");

  // Notes.
  out.push(`Notes:`);
  if (p.notes.length === 0) {
    out.push(`  (none)`);
  } else {
    for (const n of p.notes) out.push(`  - ${n}`);
  }
  return out.join("\n") + "\n";
}

function indent(s: string): string {
  return s.split("\n").map((l) => "  " + l).join("\n");
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
