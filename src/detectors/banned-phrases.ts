import type { BannedPhraseDetection } from "../types.js";
import type { Sensitivity } from "../state/heuristics.js";

// Surfaces voice-rule violations from the framework as soft warnings.
// Counts occurrences case-insensitively. Skips matches inside fenced code
// blocks so users discussing the rule itself don't trigger it.

const BANNED: RegExp[] = [
  /\bcertainly\b/gi,
  /\babsolutely\b/gi,
  /\bgreat question\b/gi,
  /\bof course\b/gi,
  /\bi(?:'d| would) be happy to\b/gi,
  /\bas an ai\b/gi,
  /\bit(?:'s| is) important to note\b/gi,
  /\bfeel free to\b/gi,
  /\bleverage\b/gi,
  /\butilize\b/gi,
  /\bfacilitate\b/gi,
];

export function detectBannedPhrases(output: string, sensitivity: Sensitivity = "default"): BannedPhraseDetection {
  const stripped = stripCodeFences(output);
  const hits: string[] = [];
  let count = 0;
  for (const re of BANNED) {
    const matches = stripped.match(re);
    if (matches) {
      count += matches.length;
      hits.push(...matches.map((m) => m.toLowerCase()));
    }
  }
  // v0.9.1: `loose` raises the count floor to >= 2 so a single rhetorical
  // "absolutely" doesn't trip the warning. The detector still records the
  // hits; it just won't surface as fired unless the count exceeds 1.
  if (sensitivity === "loose" && count < 2) {
    return { count: 0, phrases: [] };
  }
  return { count, phrases: Array.from(new Set(hits)) };
}

function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}
