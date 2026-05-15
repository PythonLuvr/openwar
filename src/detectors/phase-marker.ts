import type { Phase, PhaseMarkerDetection } from "../types.js";

// Finds explicit Phase N markers the model declares in its output. The
// runtime tracks these independently of its own phase state so it can
// notice drift (model thinks it's in Phase 1, runtime thinks Phase 0).

const PHASE_HEADER = /(^|\n)\s*#{0,4}\s*phase\s*([0-4])\b[^\n]*/gi;

const PHASE_BY_INDEX: Record<string, Phase> = {
  "0": "intake",
  "1": "execute",
  "2": "blocker",
  "3": "destructive",
  "4": "completion",
};

export function detectPhaseMarkers(output: string): PhaseMarkerDetection {
  const declared: Phase[] = [];
  PHASE_HEADER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PHASE_HEADER.exec(output)) !== null) {
    const phase = PHASE_BY_INDEX[m[2]!];
    if (phase) declared.push(phase);
  }
  return declared.length > 0
    ? { declared, last: declared[declared.length - 1]! }
    : { declared };
}
