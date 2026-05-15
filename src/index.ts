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
