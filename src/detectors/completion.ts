import type { CompletionDetection } from "../types.js";

// Detects whether the model has declared Phase 4 / completion.

const PATTERNS: RegExp[] = [
  /(^|\n)\s*#{1,4}\s*phase\s*4\b[^\n]*/i,
  /(^|\n)\s*phase\s*4\s*[:\-]/i,
  /(^|\n)\s*#{1,4}\s*completion\b[^\n]*/i,
  /\ball\s+deliverables?\s+(?:are\s+)?(?:complete|delivered|shipped)\b/i,
  /\bbrief (?:is )?complete\b/i,
];

export function detectCompletion(output: string): CompletionDetection {
  for (const p of PATTERNS) {
    if (p.test(output)) {
      return { complete: true, matched_pattern: p.source };
    }
  }
  return { complete: false };
}
