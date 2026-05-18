// v0.9.0: `openwar history <slug>`.
//
// Read-only. Reads accumulated trace files matching the slug, prints a
// descriptive report. No --apply, no profile-writing, no runtime side effects.
// Authorization: filesystem_read only.

import { buildHistoryReport } from "../state/history-report.js";
import { stringifyDeterministic, type HistoryReport, type RunSummary } from "../state/history.js";
import { table } from "./inspect.js";

export interface HistoryRenderOptions {
  // Set true to emit a deterministic JSON document instead of the table view.
  json?: boolean;
  // Override the minimum sample size for the "thin sample" note. Defaults to
  // 3 (matches dead-tool threshold).
  minSamples?: number;
  // ISO timestamp; runs with started_at older than this are excluded.
  since?: string;
}

export interface HistoryRunResult {
  // The report itself (also written to the output sink as text or JSON).
  report: HistoryReport;
  // Run summaries the report aggregated over. Useful in tests.
  runs: RunSummary[];
  // Sessions whose trace files don't exist (v0.7.x or earlier runs).
  traceless_brief_ids: string[];
}

export function runHistory(slug: string, write: (s: string) => void, opts: HistoryRenderOptions = {}): HistoryRunResult {
  const buildOpts: { slug: string; minSamples?: number; since?: string } = { slug };
  if (opts.minSamples !== undefined) buildOpts.minSamples = opts.minSamples;
  if (opts.since !== undefined) buildOpts.since = opts.since;
  const { report, runs, traceless_brief_ids } = buildHistoryReport(buildOpts);

  if (opts.json) {
    write(stringifyDeterministic(report) + "\n");
    return { report, runs, traceless_brief_ids };
  }

  write(formatHistoryReport(report, { traceless_brief_ids }));
  return { report, runs, traceless_brief_ids };
}

export interface FormatOptions {
  traceless_brief_ids?: string[];
}

// Plain-text formatter. The dashboard and `inspect --history` both reuse it
// (rendered inside a <pre> tag for the web view) so the column shape is the
// single source of truth.
export function formatHistoryReport(report: HistoryReport, fopts: FormatOptions = {}): string {
  const out: string[] = [];
  out.push(`OpenWar history report (descriptive; v0.9.0)`);
  out.push(`  slug:           ${report.slug}`);
  out.push(`  sample_size:    ${report.sample_size}`);
  out.push(`  window:         ${report.window_start ?? "n/a"} -> ${report.window_end ?? "n/a"}`);
  out.push(`  generated_at:   ${report.generated_at}`);
  out.push(`  schema_version: ${report.schema_version}`);
  out.push("");

  if (report.sample_size === 0) {
    out.push(`No traces found for project "${report.slug}".`);
    if (fopts.traceless_brief_ids && fopts.traceless_brief_ids.length > 0) {
      out.push(`(${fopts.traceless_brief_ids.length} session(s) match the slug but have no trace file; likely pre-v0.8 runs.)`);
    } else {
      out.push(`Run a brief whose project: matches "${report.slug}" to start accumulating history.`);
    }
    return out.join("\n") + "\n";
  }

  out.push(`Source runs (${report.source_runs.length}):`);
  for (const id of report.source_runs) out.push(`  ${id}`);
  if (fopts.traceless_brief_ids && fopts.traceless_brief_ids.length > 0) {
    out.push("");
    out.push(`Excluded (no trace file; pre-v0.8 runs): ${fopts.traceless_brief_ids.join(", ")}`);
  }
  out.push("");

  out.push(`Tool usage:`);
  if (report.tool_usage.length === 0) {
    out.push(`  (no tool calls recorded across sample)`);
  } else {
    const rows = report.tool_usage.map((t) => [
      t.tool,
      String(t.calls),
      t.last_used ?? "-",
      t.dead ? "DEAD" : "",
    ]);
    out.push(indent(table(["tool", "calls", "last_used", "flag"], rows)));
  }
  out.push("");

  out.push(`Phase distribution:`);
  if (report.phase_distribution.length === 0) {
    out.push(`  (no phase events recorded)`);
  } else {
    const rows = report.phase_distribution.map((p) => [
      p.phase,
      String(p.samples),
      String(p.total_calls),
      formatNumber(p.p50),
      formatNumber(p.p90),
      String(p.max),
      `${p.total_duration_ms}ms`,
      `${p.avg_duration_ms}ms`,
    ]);
    out.push(indent(table(
      ["phase", "samples", "total_calls", "p50", "p90", "max", "total_dur", "avg_dur"],
      rows,
    )));
  }
  out.push("");

  out.push(`Detector fires:`);
  if (report.detectors.length === 0) {
    out.push(`  (no detector fires recorded)`);
  } else {
    const rows = report.detectors.map((d) => [
      d.detector,
      String(d.total_fires),
      String(d.runs_with_fire),
      formatNumber(d.fires_per_run),
    ]);
    out.push(indent(table(
      ["detector", "total_fires", "runs_w_fire", "fires_per_run"],
      rows,
    )));
  }
  out.push("");

  if (report.corrupted_lines_total > 0) {
    out.push(`Corrupted trace lines (skipped): ${report.corrupted_lines_total}`);
    out.push("");
  }

  out.push(`Notes:`);
  for (const n of report.notes) out.push(`  - ${n}`);
  return out.join("\n") + "\n";
}

function indent(s: string): string {
  return s.split("\n").map((l) => "  " + l).join("\n");
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}
