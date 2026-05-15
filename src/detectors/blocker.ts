import type { BlockerDetection } from "../types.js";

// Detects whether a model turn declares it is blocked under Phase 2.
// Two paths to a positive:
//   1. Explicit "Phase 2" header.
//   2. Heuristic phrases the framework documents (Hit a wall, blocked, etc.)
//      combined with a stop signal (need, missing, cannot proceed).

const EXPLICIT_PATTERNS: RegExp[] = [
  /(^|\n)\s*#{1,4}\s*phase\s*2\b[^\n]*/i,
  /(^|\n)\s*phase\s*2\s*[:\-]/i,
  /(^|\n)\s*blocker\s*[:\-]/i,
];

const HEURISTIC_PATTERNS: RegExp[] = [
  /\bhit a wall\b/i,
  /\bi(?:'m| am)\s+blocked\b/i,
  /\bi\s+can(?:not|'t)\s+proceed\b/i,
  /\bi\s+cannot\s+continue\b/i,
  /\bcannot\s+resolve\s+this\b/i,
  /\bneed (?:the operator|your|operator)\s+(?:input|call|decision|help)/i,
  /\bstopping (?:here|until)\b/i,
  /\bwaiting (?:for|on)\s+(?:operator|your\s+(?:call|input))/i,
];

export function detectBlocker(output: string): BlockerDetection {
  for (const p of EXPLICIT_PATTERNS) {
    const m = p.exec(output);
    if (m) {
      return {
        blocked: true,
        reason: extractReason(output, m.index),
        matched_pattern: p.source,
      };
    }
  }

  // Heuristic: require at least one signal phrase AND that the output ends
  // in something that reads like a halt (not just a passing mention).
  for (const p of HEURISTIC_PATTERNS) {
    if (p.test(output)) {
      // Reject if the phrase appears inside a quoted block or code fence.
      if (isInsideCodeFence(output, p)) continue;
      return {
        blocked: true,
        reason: extractReason(output, output.search(p)),
        matched_pattern: p.source,
      };
    }
  }

  return { blocked: false, reason: null };
}

function extractReason(output: string, fromIndex: number): string {
  // Grab up to 4 lines starting from the matched line.
  const rest = output.slice(fromIndex);
  const lines = rest.split("\n").slice(0, 8);
  return lines.join("\n").trim().slice(0, 600);
}

function isInsideCodeFence(text: string, pattern: RegExp): boolean {
  const m = pattern.exec(text);
  if (!m) return false;
  const before = text.slice(0, m.index);
  const fences = before.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}
