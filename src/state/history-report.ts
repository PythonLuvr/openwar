// v0.9.0: report builder. Joins session metadata (for project-slug filtering)
// with the per-session trace files (the actual event stream), then hands the
// aggregated event arrays to history.ts for the math.

import { listSessions } from "./persist.js";
import { readTrace } from "./trace.js";
import { summarizeRun, aggregateRuns, type HistoryReport, type RunSummary } from "./history.js";

export interface BuildReportOptions {
  slug: string;
  since?: string;
  minSamples?: number;
}

export interface BuildReportResult {
  report: HistoryReport;
  // Per-run summaries used to build the report. Surface for callers that want
  // to render per-run breakdowns alongside the aggregate.
  runs: RunSummary[];
  // brief_ids that matched the slug but had no trace file (v0.7.x sessions).
  // Reported so the operator can see why their sample is thinner than
  // expected.
  traceless_brief_ids: string[];
}

export function buildHistoryReport(opts: BuildReportOptions): BuildReportResult {
  const sessions = listSessions().filter((s) => s.project === opts.slug);
  const runs: RunSummary[] = [];
  const traceless_brief_ids: string[] = [];
  for (const s of sessions) {
    const { events, empty, corrupted_lines } = readTrace(s.brief_id);
    if (empty) {
      traceless_brief_ids.push(s.brief_id);
      continue;
    }
    runs.push(summarizeRun(s.brief_id, events, corrupted_lines));
  }
  const aggregateOpts: { slug: string; minSamples?: number; since?: string } = { slug: opts.slug };
  if (opts.minSamples !== undefined) aggregateOpts.minSamples = opts.minSamples;
  if (opts.since !== undefined) aggregateOpts.since = opts.since;
  const report = aggregateRuns(runs, aggregateOpts);
  return { report, runs, traceless_brief_ids };
}
