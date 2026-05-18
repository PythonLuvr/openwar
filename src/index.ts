// Public library surface. War Room and other integrators import from here.

export * from "./types.js";
export { parseBrief, validateBrief, renderBriefForAgent, generateBriefId } from "./brief.js";
export { run } from "./runner.js";
export { loadFrameworkDoc } from "./framework.js";

export {
  AnthropicAdapter,
  OpenAIAdapter,
  GeminiAdapter,
  GrokAdapter,
  OpenAICompatAdapter,
  MockAdapter,
  makeAdapter,
  listAdapters,
} from "./adapters/index.js";
export type { AdapterId } from "./adapters/index.js";

export {
  snapshot,
  detectConfirmationSummary,
  detectBlocker,
  detectDestructive,
  detectBannedPhrases,
  detectPhaseMarkers,
  detectCompletion,
} from "./detectors/index.js";

export {
  writeSession,
  readSession,
  listSessions,
  sessionExists,
  openwarHome,
  sessionsDir,
  sessionFile,
  appendTranscript,
  readTranscript,
} from "./state/index.js";

export { createTerminalIO, createScriptedIO } from "./io.js";

// v0.8: trace + inspect surface. Integrators (War Room) consume these to
// render OpenWar runs in their own observability stacks. OpenWar itself
// stays silent on the wire; integrators push trace data wherever they want.
export {
  Tracer,
  nullTracer,
  readTrace,
  readTraceFromPath,
  TRACE_SCHEMA_VERSION,
  aggregatePhaseTimings,
  aggregateRoleCost,
  aggregateDetectorCounts,
  type TraceEvent,
  type TraceEventType,
} from "./state/trace.js";
export {
  formatTrace,
  formatTiming,
  formatCost,
  formatDetectors,
  formatTools,
  formatMcp,
} from "./cli/inspect.js";
export { runReplay, type ReplayOptions, type ReplayResult } from "./cli/replay.js";

// v0.9.0: descriptive history over accumulated traces. Integrators can
// build their own reporting on top of these. v0.9.1 will add prescriptive
// adaptation; this release is read-only.
export {
  summarizeRun,
  aggregateRuns,
  quantile,
  stringifyDeterministic,
  type RunSummary,
  type HistoryReport,
  type ToolUsageRow,
  type PhaseDistributionRow,
  type DetectorRow,
} from "./state/history.js";
export { buildHistoryReport, type BuildReportOptions, type BuildReportResult } from "./state/history-report.js";
export { runHistory, formatHistoryReport, type HistoryRenderOptions, type HistoryRunResult } from "./cli/history.js";

// v0.9.1: adaptive autonomy plumbing. Heuristic recommendations, learned
// profile schema, runtime overrides. Conservative defaults; tune in v0.9.2+.
export {
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
  type Sensitivity,
  type DetectorRecommendation,
  type PhaseBudgetRecommendation,
  type ToolUsageRecommendation,
  type AllRecommendations,
} from "./state/heuristics.js";
export {
  LEARNED_PROFILE_SCHEMA_VERSION,
  LearnedProfileSchemaError,
  learnedProfilePath,
  loadLearnedProfile,
  saveLearnedProfile,
  deleteLearnedProfile,
  profileExists,
  buildLearnedProfile,
  sensitivityMapFromProfile,
  type LearnedProfile,
  type DetectorSensitivityMap,
} from "./state/learned-profile.js";
export { runLearn, type RunLearnOptions, type RunLearnResult } from "./cli/learn.js";
export { formatLearnedView, type LearnedViewOptions } from "./cli/inspect-learned.js";
