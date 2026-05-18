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
