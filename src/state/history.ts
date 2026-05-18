// v0.9.0: descriptive history over accumulated v0.8 traces. Pure functions
// over event arrays. No I/O, no formatting decisions. The CLI subcommand and
// the inspect --history view both consume the aggregated shapes defined here.
//
// Deterministic by design: every output is sorted, every iteration order is
// explicit. Same trace inputs produce the same numbers bit-for-bit.

import type { TraceEvent } from "./trace.js";
import type { Phase } from "../types.js";

// ---------------------------------------------------------------------------
// Per-run summary, derived from one trace file.

export interface RunSummary {
  brief_id: string;
  started_at: string | null;
  ended_at: string | null;
  // Final phase the run reached, derived from the last phase_enter event.
  final_phase: Phase | null;
  // tool_call counts attributed to each phase.
  tool_calls_by_phase: Record<Phase, number>;
  // total tool_call events (sum of tool_calls_by_phase).
  tool_call_total: number;
  // Per-tool-name counts.
  tool_calls_by_name: Record<string, number>;
  // Per-detector fire counts.
  detector_fires: Record<string, number>;
  // Total duration_ms per phase, summed across exits within this run.
  phase_durations_ms: Record<Phase, number>;
  // Corrupted line numbers, surfaced so the report can disclose them.
  corrupted_lines: number[];
}

// Walk a single trace's events and produce a RunSummary. Tool calls are
// attributed to the most recent phase_enter; if no phase_enter has been seen
// (corrupted leading lines) the call is recorded under "_unknown".
export function summarizeRun(briefId: string, events: TraceEvent[], corrupted_lines: number[] = []): RunSummary {
  const tool_calls_by_phase: Record<string, number> = {};
  const tool_calls_by_name: Record<string, number> = {};
  const detector_fires: Record<string, number> = {};
  const phase_durations_ms: Record<string, number> = {};
  let started_at: string | null = null;
  let ended_at: string | null = null;
  let final_phase: Phase | null = null;
  let currentPhase: Phase | "_unknown" = "_unknown";
  let tool_call_total = 0;

  for (const ev of events) {
    if ("at" in ev && typeof ev.at === "string" && ev.at) {
      if (!started_at) started_at = ev.at;
      ended_at = ev.at;
    }
    switch (ev.type) {
      case "phase_enter":
        currentPhase = ev.phase;
        final_phase = ev.phase;
        break;
      case "phase_exit":
        phase_durations_ms[ev.phase] = (phase_durations_ms[ev.phase] ?? 0) + ev.duration_ms;
        break;
      case "tool_call":
        tool_call_total++;
        tool_calls_by_phase[currentPhase] = (tool_calls_by_phase[currentPhase] ?? 0) + 1;
        tool_calls_by_name[ev.name] = (tool_calls_by_name[ev.name] ?? 0) + 1;
        break;
      case "detector_fired":
        detector_fires[ev.detector] = (detector_fires[ev.detector] ?? 0) + 1;
        break;
    }
  }

  return {
    brief_id: briefId,
    started_at,
    ended_at,
    final_phase,
    tool_calls_by_phase: tool_calls_by_phase as Record<Phase, number>,
    tool_call_total,
    tool_calls_by_name,
    detector_fires,
    phase_durations_ms: phase_durations_ms as Record<Phase, number>,
    corrupted_lines: [...corrupted_lines],
  };
}

// ---------------------------------------------------------------------------
// Aggregation across multiple runs (a project's history).

export interface ToolUsageRow {
  tool: string;
  calls: number;
  last_used: string | null;
  // Dead = zero calls across all runs in the sample. Only meaningful when
  // sample_size >= 3 (otherwise the sample is too small to draw conclusions).
  dead: boolean;
}

export interface PhaseDistributionRow {
  phase: Phase;
  samples: number;
  // Tool calls observed in this phase across runs.
  total_calls: number;
  p50: number;
  p90: number;
  max: number;
  // Total duration_ms attributed to this phase across runs.
  total_duration_ms: number;
  avg_duration_ms: number;
}

export interface DetectorRow {
  detector: string;
  total_fires: number;
  fires_per_run: number;
  runs_with_fire: number;
}

export interface HistoryReport {
  // Schema version for the JSON output. Independent of the OpenWar package
  // version so the report shape can evolve without forcing a major bump.
  schema_version: 1;
  generated_at: string;
  slug: string;
  sample_size: number;
  // brief_ids that fed this report, sorted lexicographically for determinism.
  source_runs: string[];
  // Earliest and latest run timestamps in the sample.
  window_start: string | null;
  window_end: string | null;
  tool_usage: ToolUsageRow[];
  phase_distribution: PhaseDistributionRow[];
  detectors: DetectorRow[];
  // Total corrupted trace lines observed across the sample. Operator may want
  // to investigate if this is non-zero on supposedly-clean runs.
  corrupted_lines_total: number;
  // Plain-text callouts for the operator. Things the math noticed that are
  // worth surfacing in the inspect view.
  notes: string[];
}

export interface AggregateOptions {
  slug: string;
  // Minimum sample size below which we still emit a report but flag it as
  // thin (the `notes` field will mention it). Defaults to 3 to match the
  // dead-tool threshold.
  minSamples?: number;
  // ISO timestamp; runs with started_at older than this are excluded.
  since?: string;
}

export function aggregateRuns(runs: RunSummary[], opts: AggregateOptions): HistoryReport {
  const minSamples = opts.minSamples ?? 3;
  // Determinism: filter, then sort by brief_id ascending.
  const filtered = (opts.since
    ? runs.filter((r) => r.started_at !== null && r.started_at >= opts.since!)
    : runs.slice()
  ).sort((a, b) => a.brief_id.localeCompare(b.brief_id));

  const sample_size = filtered.length;
  const source_runs = filtered.map((r) => r.brief_id);
  const window_start = filtered.reduce<string | null>((acc, r) => {
    if (!r.started_at) return acc;
    if (!acc || r.started_at < acc) return r.started_at;
    return acc;
  }, null);
  const window_end = filtered.reduce<string | null>((acc, r) => {
    if (!r.ended_at) return acc;
    if (!acc || r.ended_at > acc) return r.ended_at;
    return acc;
  }, null);

  // --- Tool usage. -------------------------------------------------------
  const toolCalls = new Map<string, { calls: number; last_used: string | null }>();
  for (const r of filtered) {
    for (const [name, count] of Object.entries(r.tool_calls_by_name)) {
      const existing = toolCalls.get(name);
      if (!existing) {
        toolCalls.set(name, { calls: count, last_used: r.ended_at });
        continue;
      }
      existing.calls += count;
      if (r.ended_at && (!existing.last_used || r.ended_at > existing.last_used)) {
        existing.last_used = r.ended_at;
      }
    }
  }
  const allToolNames = [...toolCalls.keys()].sort();
  const tool_usage: ToolUsageRow[] = allToolNames.map((name) => {
    const row = toolCalls.get(name)!;
    return {
      tool: name,
      calls: row.calls,
      last_used: row.last_used,
      dead: row.calls === 0 && sample_size >= 3,
    };
  });

  // --- Phase distribution. ----------------------------------------------
  // Group per-run tool-call counts by phase, then compute quantiles.
  const phaseGroups = new Map<Phase, number[]>();
  const phaseDurations = new Map<Phase, number[]>();
  for (const r of filtered) {
    for (const [p, c] of Object.entries(r.tool_calls_by_phase) as [Phase, number][]) {
      if (!phaseGroups.has(p)) phaseGroups.set(p, []);
      phaseGroups.get(p)!.push(c);
    }
    for (const [p, d] of Object.entries(r.phase_durations_ms) as [Phase, number][]) {
      if (!phaseDurations.has(p)) phaseDurations.set(p, []);
      phaseDurations.get(p)!.push(d);
    }
  }
  const allPhases = new Set<Phase>([...phaseGroups.keys(), ...phaseDurations.keys()]);
  const phase_distribution: PhaseDistributionRow[] = [...allPhases]
    .sort((a, b) => a.localeCompare(b))
    .map((phase) => {
      const calls = (phaseGroups.get(phase) ?? []).slice().sort((a, b) => a - b);
      const durations = (phaseDurations.get(phase) ?? []);
      const total_duration_ms = durations.reduce((acc, d) => acc + d, 0);
      const callSamples = calls.length;
      return {
        phase,
        samples: callSamples,
        total_calls: calls.reduce((acc, n) => acc + n, 0),
        p50: callSamples > 0 ? quantile(calls, 0.5) : 0,
        p90: callSamples > 0 ? quantile(calls, 0.9) : 0,
        max: callSamples > 0 ? calls[callSamples - 1]! : 0,
        total_duration_ms,
        avg_duration_ms: durations.length > 0 ? Math.round(total_duration_ms / durations.length) : 0,
      };
    });

  // --- Detectors. -------------------------------------------------------
  const detectorTotals = new Map<string, number>();
  const detectorRunsWithFire = new Map<string, number>();
  for (const r of filtered) {
    for (const [d, c] of Object.entries(r.detector_fires)) {
      detectorTotals.set(d, (detectorTotals.get(d) ?? 0) + c);
      if (c > 0) detectorRunsWithFire.set(d, (detectorRunsWithFire.get(d) ?? 0) + 1);
    }
  }
  const detectors: DetectorRow[] = [...detectorTotals.keys()]
    .sort()
    .map((d) => {
      const total = detectorTotals.get(d) ?? 0;
      return {
        detector: d,
        total_fires: total,
        fires_per_run: sample_size > 0 ? round2(total / sample_size) : 0,
        runs_with_fire: detectorRunsWithFire.get(d) ?? 0,
      };
    });

  // --- Notes. -----------------------------------------------------------
  const notes: string[] = [];
  if (sample_size < minSamples) {
    notes.push(`Thin sample: ${sample_size} run(s) is below the ${minSamples}-run threshold. Take recommendations as indicative only.`);
  }
  const deadTools = tool_usage.filter((t) => t.dead);
  if (deadTools.length > 0) {
    notes.push(`Dead tools (zero calls across sample): ${deadTools.map((t) => t.tool).join(", ")}. Consider trimming from briefs.`);
  }
  const corrupted_lines_total = filtered.reduce((acc, r) => acc + r.corrupted_lines.length, 0);
  if (corrupted_lines_total > 0) {
    notes.push(`${corrupted_lines_total} corrupted trace line(s) skipped during aggregation across ${filtered.filter((r) => r.corrupted_lines.length > 0).length} run(s).`);
  }
  notes.push("v0.9.0 is descriptive only. No runtime behavior changes from this report. v0.9.1 will add recommendations and a learned profile.");

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    slug: opts.slug,
    sample_size,
    source_runs,
    window_start,
    window_end,
    tool_usage,
    phase_distribution,
    detectors,
    corrupted_lines_total,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Quantile / helper math. Linear interpolation between the two surrounding
// points; matches numpy default. Pre-sorted input required.

export function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = pos - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Deterministic JSON serializer. Walks the value and emits object keys in
// sorted order. Used by the --json output so byte-identical inputs produce
// byte-identical outputs.

export function stringifyDeterministic(value: unknown): string {
  return JSON.stringify(value, (_, v) => sortKeys(v), 2);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v; // arrays preserve order
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const keys = Object.keys(v).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = (v as Record<string, unknown>)[k];
    return out;
  }
  return v;
}
