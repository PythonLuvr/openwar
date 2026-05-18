import type { CompletionDetection } from "../types.js";
import type { Sensitivity } from "../state/heuristics.js";

// Detects whether the model has declared Phase 4 / completion.

// Explicit Phase 4 marker (header form). These always fire.
const EXPLICIT_PATTERNS: RegExp[] = [
  /(^|\n)\s*#{1,4}\s*phase\s*4\b[^\n]*/i,
  /(^|\n)\s*phase\s*4\s*[:\-]/i,
  /(^|\n)\s*#{1,4}\s*completion\b[^\n]*/i,
];

// Heuristic phrases. Fire on default; suppressed under `loose`.
const HEURISTIC_PATTERNS: RegExp[] = [
  /\ball\s+deliverables?\s+(?:are\s+)?(?:complete|delivered|shipped)\b/i,
  /\bbrief (?:is )?complete\b/i,
];

export function detectCompletion(output: string, sensitivity: Sensitivity = "default"): CompletionDetection {
  for (const p of EXPLICIT_PATTERNS) {
    if (p.test(output)) {
      return { complete: true, matched_pattern: p.source };
    }
  }
  // v0.9.1: `loose` requires explicit Phase 4 marker. Skip heuristic phrases.
  if (sensitivity === "loose") {
    return { complete: false };
  }
  for (const p of HEURISTIC_PATTERNS) {
    if (p.test(output)) {
      return { complete: true, matched_pattern: p.source };
    }
  }
  return { complete: false };
}
