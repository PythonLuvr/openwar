// v0.8: openwar replay <brief_id>
//
// Replays a completed session by feeding its recorded assistant turns through
// CURRENT detector code. The original trace is reference data, not the
// script: replay emits fresh "[replay]" events. This is what makes replay
// useful for detector regression testing (run new detector code against old
// transcripts) and for showing runs to operators without making LLM calls.
//
// Replay is deliberately NOT bit-identical to the original. Timestamps are
// fresh; banner output reflects current detector matches, not the original
// session's. A Phase 2 halt detected in the transcript also halts replay,
// so reviewers see where the run actually stopped.

import { readSession } from "../state/persist.js";
import { readTranscript } from "../state/transcript.js";
import { readTrace } from "../state/trace.js";
import { snapshot } from "../detectors/index.js";

export interface ReplayOptions {
  briefId: string;
  // Optional sink for output. Defaults to process.stdout.
  write?: (line: string) => void;
}

export interface ReplayResult {
  // Total number of assistant turns processed.
  assistant_turns: number;
  // Names of detectors that fired in this replay (re-running current code).
  detectors_fired: string[];
  // True when replay short-circuited at a Phase 2 blocker (same as the run).
  halted_at_blocker: boolean;
  // True when replay short-circuited at completion detection.
  completed: boolean;
  // Number of "drift" events: detector results that differ between the
  // recorded trace and this replay. Surfaces regressions; 0 means current
  // detector code agrees with what was recorded.
  drift_count: number;
}

export function runReplay(opts: ReplayOptions): ReplayResult {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const briefId = opts.briefId;

  const session = readSession(briefId);
  if (!session) {
    write(`openwar replay: no session found for "${briefId}"\n`);
    return { assistant_turns: 0, detectors_fired: [], halted_at_blocker: false, completed: false, drift_count: 0 };
  }
  const transcript = readTranscript(briefId);
  const { events: originalEvents, empty: traceEmpty } = readTrace(briefId);
  if (traceEmpty) {
    write(`[replay] No trace for "${briefId}". Replaying against transcript only; detector drift comparison disabled.\n`);
  }

  // Build a set of detector names that fired in the original trace, by
  // assistant-turn index. The trace doesn't tag the turn index, so we
  // approximate: the original trace's `detector_fired` events appear in
  // assistant-turn order. We collect them as a flat sequence and pop as we
  // replay; mismatches count as drift.
  const originalDetectorSequence: string[] = [];
  for (const ev of originalEvents) {
    if (ev.type === "detector_fired") originalDetectorSequence.push(ev.detector);
  }
  let originalCursor = 0;

  write(`[replay] Session ${briefId}\n`);
  write(`[replay] Project: ${session.meta.project}\n`);
  write(`[replay] Replayed at: ${new Date().toISOString()}\n`);
  write(`[replay] Detectors will be re-run against the current code; original results in trace.ndjson\n\n`);

  const authorizedCosts = session.brief.frontmatter.authorized_costs;
  const detectorsFired: string[] = [];
  let halted = false;
  let completed = false;
  let driftCount = 0;
  let turnIndex = 0;

  for (const entry of transcript) {
    if (entry.message.role !== "assistant") continue;
    turnIndex++;
    const text = entry.message.content;
    const turnPhase = entry.message.meta?.phase;
    const snap = snapshot(text, { authorized_costs: authorizedCosts });

    const fired: string[] = [];
    if (snap.confirmation?.found) fired.push("confirmation");
    if (snap.blocker?.blocked) fired.push("blocker");
    if (snap.destructive?.destructive) fired.push("destructive");
    if (snap.banned_phrases && snap.banned_phrases.count > 0) fired.push("banned_phrases");
    if (snap.phase_marker && snap.phase_marker.declared.length > 0) fired.push("phase_marker");
    if (snap.completion?.complete) fired.push("completion");

    if (fired.length > 0) {
      write(`[replay] turn ${turnIndex}: ${fired.join(", ")}\n`);
    } else {
      write(`[replay] turn ${turnIndex}: (no detectors fired)\n`);
    }
    detectorsFired.push(...fired);

    // Drift comparison against the original sequence. The runtime instruments
    // detector firings ONLY in execute-phase turns (see phases/execute.ts), so
    // we restrict the comparison to those. Turns without meta.phase (legacy
    // transcripts pre-v0.4) are skipped from drift accounting; they still
    // print their fires for informational purposes.
    if (!traceEmpty && turnPhase === "execute") {
      const expected = originalDetectorSequence.slice(originalCursor, originalCursor + fired.length);
      const expectedSet = new Set(expected);
      const firedSet = new Set(fired);
      const onlyNow = [...firedSet].filter((d) => !expectedSet.has(d));
      const onlyThen = [...expectedSet].filter((d) => !firedSet.has(d));
      if (onlyNow.length > 0 || onlyThen.length > 0) {
        driftCount++;
        if (onlyNow.length > 0) write(`[replay]   drift: now fires ${onlyNow.join(", ")} (was not in original trace)\n`);
        if (onlyThen.length > 0) write(`[replay]   drift: original fired ${onlyThen.join(", ")} (current code does not)\n`);
      }
      originalCursor += fired.length;
    }

    if (snap.blocker?.blocked) {
      write(`[replay] Phase 2 detected at turn ${turnIndex}: ${snap.blocker.reason ?? "unspecified"}\n`);
      write(`[replay] HALT (matches original run shape)\n`);
      halted = true;
      break;
    }
    if (snap.completion?.complete) {
      write(`[replay] Phase 4 detected at turn ${turnIndex}\n`);
      completed = true;
      break;
    }
  }

  write(`\n[replay] summary\n`);
  write(`[replay]   assistant_turns:  ${turnIndex}\n`);
  write(`[replay]   detectors_fired:  ${detectorsFired.length}\n`);
  write(`[replay]   halted_at_blocker: ${halted}\n`);
  write(`[replay]   completed:        ${completed}\n`);
  write(`[replay]   drift_count:      ${driftCount}${driftCount > 0 ? "  (current detectors disagree with recorded trace)" : ""}\n`);

  return {
    assistant_turns: turnIndex,
    detectors_fired: detectorsFired,
    halted_at_blocker: halted,
    completed,
    drift_count: driftCount,
  };
}
