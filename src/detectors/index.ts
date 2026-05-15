import type { DetectorSnapshot } from "../types.js";
import { detectConfirmationSummary } from "./confirmation-summary.js";
import { detectBlocker } from "./blocker.js";
import { detectDestructive } from "./destructive.js";
import { detectBannedPhrases } from "./banned-phrases.js";
import { detectPhaseMarkers } from "./phase-marker.js";
import { detectCompletion } from "./completion.js";

export {
  detectConfirmationSummary,
  detectBlocker,
  detectDestructive,
  detectBannedPhrases,
  detectPhaseMarkers,
  detectCompletion,
};

// Convenience: run every detector against a single agent turn.
export function snapshot(
  output: string,
  ctx: { authorized_costs?: string[] } = {},
): DetectorSnapshot {
  return {
    confirmation: detectConfirmationSummary(output),
    blocker: detectBlocker(output),
    destructive: detectDestructive(output, ctx.authorized_costs ?? []),
    banned_phrases: detectBannedPhrases(output),
    phase_marker: detectPhaseMarkers(output),
    completion: detectCompletion(output),
  };
}
