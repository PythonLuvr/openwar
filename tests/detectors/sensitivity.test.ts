// v0.9.1 detector sensitivity refactor. Verifies each detector honors the
// sensitivity parameter and that the snapshot dispatcher enforces the
// safety_critical gate on `disabled`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBlocker } from "../../src/detectors/blocker.js";
import { detectDestructive } from "../../src/detectors/destructive.js";
import { detectBannedPhrases } from "../../src/detectors/banned-phrases.js";
import { detectConfirmationSummary } from "../../src/detectors/confirmation-summary.js";
import { detectCompletion } from "../../src/detectors/completion.js";
import { snapshotWithConsultations } from "../../src/detectors/index.js";

// -----------------------------------------------------------------------
// blocker

test("blocker default: heuristic phrase fires", () => {
  const r = detectBlocker("Sorry, I cannot proceed without the database credentials.");
  assert.equal(r.blocked, true);
});

test("blocker loose: heuristic phrase is suppressed; only explicit marker fires", () => {
  const r = detectBlocker("Sorry, I cannot proceed without the database credentials.", "loose");
  assert.equal(r.blocked, false);
});

test("blocker loose: explicit Phase 2 marker still fires", () => {
  const r = detectBlocker("## Phase 2\n\nI cannot proceed; missing input.", "loose");
  assert.equal(r.blocked, true);
});

// -----------------------------------------------------------------------
// destructive

test("destructive default: intent + action fires without imminent marker", () => {
  const r = detectDestructive("I'll delete the file backup.txt and proceed.", []);
  assert.equal(r.destructive, true);
});

test("destructive loose: requires imminent-action marker", () => {
  // No imminent marker. Suppressed under loose.
  const r = detectDestructive("I'll delete the file backup.txt and proceed.", [], "loose");
  assert.equal(r.destructive, false);
});

test("destructive loose: imminent marker present, fires", () => {
  const r = detectDestructive("I'll delete the file backup.txt now and proceed.", [], "loose");
  assert.equal(r.destructive, true);
});

// -----------------------------------------------------------------------
// banned_phrases

test("banned_phrases default: single hit reports count=1", () => {
  const r = detectBannedPhrases("That's absolutely true.");
  assert.equal(r.count, 1);
});

test("banned_phrases loose: single hit suppressed (count<2)", () => {
  const r = detectBannedPhrases("That's absolutely true.", "loose");
  assert.equal(r.count, 0);
});

test("banned_phrases loose: 2+ hits still report", () => {
  const r = detectBannedPhrases("That's absolutely true and certainly clear.", "loose");
  assert.equal(r.count, 2);
});

// -----------------------------------------------------------------------
// confirmation

test("confirmation default: four-section match counts as found", () => {
  const out = `
Objective: foo
Deliverables: bar
Constraints: none
Tools: text
`;
  const r = detectConfirmationSummary(out);
  assert.equal(r.found, true);
});

test("confirmation loose: requires explicit marker (four-section path suppressed)", () => {
  const out = `
Objective: foo
Deliverables: bar
Constraints: none
Tools: text
`;
  const r = detectConfirmationSummary(out, "loose");
  assert.equal(r.found, false);
});

test("confirmation loose: explicit Confirmation Summary header still fires", () => {
  const out = `## Confirmation Summary\n\nObjective: x`;
  const r = detectConfirmationSummary(out, "loose");
  assert.equal(r.found, true);
});

// -----------------------------------------------------------------------
// completion

test("completion default: heuristic phrase fires", () => {
  const r = detectCompletion("All deliverables shipped.");
  assert.equal(r.complete, true);
});

test("completion loose: heuristic phrase suppressed", () => {
  const r = detectCompletion("All deliverables shipped.", "loose");
  assert.equal(r.complete, false);
});

test("completion loose: explicit Phase 4 marker fires", () => {
  const r = detectCompletion("## Phase 4: Completion\n\nDone.", "loose");
  assert.equal(r.complete, true);
});

// -----------------------------------------------------------------------
// snapshot dispatcher: safety_critical gate + bypass behavior

test("snapshot: disabled on safety-critical detector is force-defaulted (NOT bypassed)", () => {
  const out = `I cannot proceed; the input is missing.`;
  const { snapshot, consultations } = snapshotWithConsultations(out, {
    sensitivities: { blocker: "disabled" },
  });
  // blocker is safety_critical; "disabled" is ignored. Detector runs at
  // default and fires.
  assert.equal(snapshot.blocker?.blocked, true);
  // Consultation record shows the original sensitivity (disabled) was
  // requested, with bypassed=false.
  const c = consultations.find((c) => c.detector === "blocker")!;
  assert.equal(c.sensitivity, "disabled");
  assert.equal(c.bypassed, false);
  assert.equal(c.fired, true);
});

test("snapshot: disabled on non-safety detector bypasses entirely", () => {
  const out = `That's absolutely true.`;
  const { snapshot, consultations } = snapshotWithConsultations(out, {
    sensitivities: { banned_phrases: "disabled" },
  });
  assert.equal(snapshot.banned_phrases, undefined);
  const c = consultations.find((c) => c.detector === "banned_phrases")!;
  assert.equal(c.bypassed, true);
  assert.equal(c.fired, false);
});

test("snapshot: default sensitivity emits no consultation record", () => {
  const { consultations } = snapshotWithConsultations("Plain text.", {});
  assert.equal(consultations.length, 0);
});

test("snapshot: loose sensitivity records consultation with sensitivity=loose", () => {
  const out = `That's absolutely true.`;
  const { consultations } = snapshotWithConsultations(out, {
    sensitivities: { banned_phrases: "loose" },
  });
  const c = consultations.find((c) => c.detector === "banned_phrases")!;
  assert.equal(c.sensitivity, "loose");
  assert.equal(c.bypassed, false);
  // Under loose, the single hit is suppressed -> fired=false.
  assert.equal(c.fired, false);
});

test("snapshot: backward compatibility -- no sensitivities behaves identically to v0.8", () => {
  const out = `## Phase 4: Completion\n\nDone.`;
  const v8Style = snapshotWithConsultations(out, {});
  assert.equal(v8Style.snapshot.completion?.complete, true);
  assert.equal(v8Style.consultations.length, 0);
});
