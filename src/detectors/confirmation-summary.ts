import type { ConfirmationDetection } from "../types.js";

// Detects whether a model turn contains a Confirmation Summary in OpenWar's
// shape. Looks for:
//   1. An explicit Phase 0 / Confirmation Summary marker, OR
//   2. The presence of all five required subsections.
//
// Pure. Pattern-based. No LLM judging.

const PHASE_0_MARKERS = [
  /(^|\n)\s*#{1,4}\s*phase\s*0\b[^\n]*/i,
  /(^|\n)\s*#{1,4}\s*confirmation\s+summary\b[^\n]*/i,
  /(^|\n)\s*confirmation\s+summary\s*[:\-]/i,
];

// Each section heading allows several spellings. The regex captures the body
// from the heading line until the next heading or end-of-string.
const SECTION_PATTERNS: Array<{
  key: keyof ConfirmationDetection["sections"];
  patterns: RegExp[];
}> = [
  {
    key: "objective",
    patterns: [/(^|\n)\s*(?:#{1,4}\s*|\*{1,2})?(?:objective|goal)s?\b\*{0,2}\s*[:\-]?/i],
  },
  {
    key: "deliverables",
    patterns: [/(^|\n)\s*(?:#{1,4}\s*|\*{1,2})?deliverables?\b\*{0,2}\s*[:\-]?/i],
  },
  {
    key: "constraints",
    patterns: [/(^|\n)\s*(?:#{1,4}\s*|\*{1,2})?constraints?\b\*{0,2}\s*[:\-]?/i],
  },
  {
    key: "tools_required",
    patterns: [/(^|\n)\s*(?:#{1,4}\s*|\*{1,2})?tools?(?:\s+required)?\b\*{0,2}\s*[:\-]?/i],
  },
  {
    key: "unknowns",
    patterns: [
      /(^|\n)\s*(?:#{1,4}\s*|\*{1,2})?(?:unknowns?|notes?\s*\/\s*unknowns?|open\s+questions?)\b\*{0,2}\s*[:\-]?/i,
    ],
  },
];

const MODE_QUESTION_PATTERNS = [
  /per[\s\-]?step/i,
  /auto[\s\-]?pilot/i,
  /which\s+(?:execution\s+)?mode/i,
];

export function detectConfirmationSummary(output: string): ConfirmationDetection {
  const hasMarker = PHASE_0_MARKERS.some((p) => p.test(output));
  const sections: ConfirmationDetection["sections"] = {};

  let foundSections = 0;
  for (const { key, patterns } of SECTION_PATTERNS) {
    for (const p of patterns) {
      const m = p.exec(output);
      if (m) {
        const idx = m.index + m[0].length;
        sections[key] = extractUntilNextHeading(output, idx);
        foundSections++;
        break;
      }
    }
  }

  // Found = explicit marker, OR all 4 required sections (unknowns optional).
  const requiredHit =
    sections.objective !== undefined &&
    sections.deliverables !== undefined &&
    sections.constraints !== undefined &&
    sections.tools_required !== undefined;

  const found = hasMarker || requiredHit;

  const asked_for_mode = MODE_QUESTION_PATTERNS.some((p) => p.test(output)) &&
    /\?/.test(output);

  void foundSections;
  return { found, sections, asked_for_mode };
}

function extractUntilNextHeading(text: string, fromIndex: number): string {
  const rest = text.slice(fromIndex);
  // Stop at next markdown heading (#, ##, ###) on a fresh line.
  const stop = /\n#{1,4}\s+\S/.exec(rest);
  const chunk = stop ? rest.slice(0, stop.index) : rest;
  return chunk.trim();
}
