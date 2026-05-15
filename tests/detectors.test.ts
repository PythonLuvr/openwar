import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectConfirmationSummary,
  detectBlocker,
  detectDestructive,
  detectBannedPhrases,
  detectPhaseMarkers,
  detectCompletion,
} from "../src/detectors/index.js";

// ---------- confirmation summary ----------

test("confirmation summary detected via explicit Phase 0 marker", () => {
  const out = `## Phase 0: Brief intake

Here is what I heard.

**Objective**: Ship X.
**Deliverables**: A, B, C.
**Constraints**: No Y.
**Tools required**: Filesystem.
**Unknowns**: None.

Which mode would you like, gated or auto-pilot?`;
  const det = detectConfirmationSummary(out);
  assert.equal(det.found, true);
  assert.ok(det.sections.objective);
  assert.ok(det.sections.deliverables);
  assert.equal(det.asked_for_mode, true);
});

test("confirmation summary detected via section headings only", () => {
  const out = `Sure, here is what I heard:

Objective: Build a thing.

Deliverables: One module.

Constraints: No new deps.

Tools required: fs.

Unknowns: none.`;
  const det = detectConfirmationSummary(out);
  assert.equal(det.found, true);
});

test("confirmation summary NOT detected on a plain reply", () => {
  const out = "Sounds good, I will get started right away.";
  const det = detectConfirmationSummary(out);
  assert.equal(det.found, false);
});

// ---------- blocker ----------

test("blocker detected on explicit Phase 2 marker", () => {
  const out = `## Phase 2: Blocker

I cannot proceed because the database is unreachable.`;
  const det = detectBlocker(out);
  assert.equal(det.blocked, true);
  assert.match(det.reason ?? "", /Phase 2/i);
});

test("blocker detected on heuristic phrase", () => {
  const out = "I tried three variations and hit a wall. I need your call on the schema.";
  const det = detectBlocker(out);
  assert.equal(det.blocked, true);
});

test("blocker NOT detected on normal step", () => {
  const out = "Step 2 done. Moving to step 3.";
  const det = detectBlocker(out);
  assert.equal(det.blocked, false);
});

test("blocker skips matches inside code fences", () => {
  const out =
    "Here is a sample output:\n\n```\nI'm blocked at line 12\n```\n\nbut everything is fine.";
  const det = detectBlocker(out);
  assert.equal(det.blocked, false);
});

// ---------- destructive ----------

test("destructive intent detected: git force push", () => {
  const out = "Next I'll force-push to main so the rebase lands cleanly.";
  const det = detectDestructive(out);
  assert.equal(det.destructive, true);
  assert.equal(det.action, "git_history_rewrite");
  assert.equal(det.authorized, false);
});

test("destructive intent detected: paid API call", () => {
  const out = "I'll call the OpenAI API for the rewrite now.";
  const det = detectDestructive(out, []);
  assert.equal(det.destructive, true);
  assert.equal(det.authorized, false);
});

test("destructive intent authorized when category in list", () => {
  const out = "I'll generate the image via the Higgsfield API now.";
  const det = detectDestructive(out, ["generation_credits"]);
  assert.equal(det.destructive, true);
  assert.equal(det.authorized, true);
});

test("destructive intent wildcard authorization", () => {
  const out = "I'll deploy to production.";
  const det = detectDestructive(out, ["*"]);
  assert.equal(det.destructive, true);
  assert.equal(det.authorized, true);
});

test("destructive not detected without intent verb", () => {
  const out = "Force-push is risky; we should avoid it.";
  const det = detectDestructive(out);
  assert.equal(det.destructive, false);
});

test("destructive ignores negated intent", () => {
  for (const out of [
    "I will not force-push to main.",
    "I won't deploy to prod without approval.",
    "I cannot delete the database without your sign-off.",
    "Instead of force-pushing, I will rebase locally only.",
  ]) {
    const det = detectDestructive(out);
    assert.equal(det.destructive, false, `expected non-destructive: ${out}`);
  }
});

test("destructive deploy intent detected", () => {
  const out = "I'll deploy to prod once tests pass.";
  const det = detectDestructive(out);
  assert.equal(det.destructive, true);
  assert.equal(det.action, "deploy");
});

// ---------- banned phrases ----------

test("banned phrases counted, code fences ignored", () => {
  const out = "Certainly, I leverage the cache. Of course this is fine.\n```\nleverage the cache\n```";
  const det = detectBannedPhrases(out);
  assert.equal(det.count, 3);
  assert.ok(det.phrases.includes("certainly"));
  assert.ok(det.phrases.includes("leverage"));
  assert.ok(det.phrases.includes("of course"));
});

test("banned phrases zero on clean prose", () => {
  const out = "Got it. I'll run that and report back.";
  const det = detectBannedPhrases(out);
  assert.equal(det.count, 0);
});

// ---------- phase markers ----------

test("phase markers collected in order", () => {
  const out = `## Phase 0
intake
## Phase 1
exec
## Phase 4
done`;
  const det = detectPhaseMarkers(out);
  assert.deepEqual(det.declared, ["intake", "execute", "completion"]);
  assert.equal(det.last, "completion");
});

// ---------- completion ----------

test("completion detected on Phase 4 marker", () => {
  const out = "## Phase 4: Completion\n\nAll three deliverables shipped.";
  const det = detectCompletion(out);
  assert.equal(det.complete, true);
});

test("completion not detected mid-execution", () => {
  const out = "Step 2 of 5 done.";
  const det = detectCompletion(out);
  assert.equal(det.complete, false);
});
