// v0.10.0 intent contract. Adversarial fixtures: off-topic mid-conversation,
// premature approval, hallucinated tools, free-text drift, fabricated user
// approval. The parser must reject each cleanly. The session manager builds
// drift detection on top of these results.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTENT_TOOL_NAMES,
  INTENT_TOOL_DEFINITIONS,
  isIntentName,
  parseIntent,
  looksLikeApproval,
  reminderForDriftCount,
  DRIFT_THRESHOLD,
  HARD_FAIL_THRESHOLD,
  DRIFT_FALLBACK_QUESTION,
  HARD_FAIL_MESSAGE,
  REMINDER_AFTER_DRIFT,
} from "../../src/chat/intent.js";
import type { ToolCall } from "../../src/tools/types.js";

// -----------------------------------------------------------------------
// Tool surface

test("intent surface: exactly four tools (no fifth, no missing)", () => {
  assert.equal(INTENT_TOOL_NAMES.length, 4);
  assert.deepEqual(
    [...INTENT_TOOL_NAMES].sort(),
    ["ask_clarification", "propose_plan", "start_execution", "summarize_result"].sort(),
  );
  assert.equal(INTENT_TOOL_DEFINITIONS.length, 4);
  for (const t of INTENT_TOOL_DEFINITIONS) {
    assert.ok(isIntentName(t.name));
    assert.equal(t.authorization_categories.length, 0);
    assert.equal(t.origin, "native");
  }
});

test("isIntentName: rejects unknown / hallucinated tools", () => {
  assert.equal(isIntentName("propose_plan"), true);
  assert.equal(isIntentName("execute_immediately"), false); // hallucinated 5th intent
  assert.equal(isIntentName("ProposePlan"), false); // case-sensitive
  assert.equal(isIntentName(""), false);
});

// -----------------------------------------------------------------------
// Parser: happy paths

function call(name: string, args: unknown): ToolCall {
  return { id: "c1", name, arguments: args };
}

test("parseIntent: ask_clarification with valid questions", () => {
  const r = parseIntent([call("ask_clarification", { questions: ["which file?", "what styling?"] })]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.intent, "ask_clarification");
  assert.deepEqual((r.intent as { questions: string[] }).questions, ["which file?", "what styling?"]);
});

test("parseIntent: propose_plan with valid draft_brief", () => {
  const r = parseIntent([call("propose_plan", {
    plan_text: "Read index.html. Add testimonials section. Show diff.",
    draft_brief: {
      deliverables: ["testimonials section added to index.html"],
      intended_actions: [
        { description: "read files", category: "filesystem_read" },
        { description: "write files", category: "filesystem_write" },
      ],
    },
  })]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.intent, "propose_plan");
});

test("parseIntent: start_execution with matching user approval verifies", () => {
  const r = parseIntent(
    [call("start_execution", { approval_phrase: "yes" })],
    { lastUserTurn: "yes" },
  );
  assert.equal(r.ok, true);
});

test("parseIntent: summarize_result with summary + offer_save", () => {
  const r = parseIntent([call("summarize_result", { summary: "Added testimonials.", offer_save: true })]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal((r.intent as { offer_save: boolean }).offer_save, true);
});

// -----------------------------------------------------------------------
// Parser: adversarial cases

test("parseIntent: empty tool-call list -> no_tool_call (free-text drift)", () => {
  const r = parseIntent([]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_tool_call");
});

test("parseIntent: two tool calls in one turn -> multiple_tool_calls", () => {
  const r = parseIntent([
    call("ask_clarification", { questions: ["x"] }),
    call("propose_plan", { plan_text: "p", draft_brief: { deliverables: ["d"], intended_actions: [] } }),
  ]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "multiple_tool_calls");
});

test("parseIntent: hallucinated fifth intent -> unknown_tool", () => {
  const r = parseIntent([call("execute_immediately", { go: true })]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "unknown_tool");
  assert.match(r.detail, /ask_clarification.*propose_plan/);
});

test("parseIntent: ask_clarification with empty questions -> invalid_args", () => {
  const r = parseIntent([call("ask_clarification", { questions: [] })]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "invalid_args");
});

test("parseIntent: ask_clarification with non-string questions -> invalid_args", () => {
  const r = parseIntent([call("ask_clarification", { questions: [1, 2, 3] })]);
  assert.equal(r.ok, false);
});

test("parseIntent: propose_plan missing draft_brief -> invalid_args", () => {
  const r = parseIntent([call("propose_plan", { plan_text: "x" })]);
  assert.equal(r.ok, false);
});

test("parseIntent: propose_plan with empty deliverables -> invalid_args", () => {
  const r = parseIntent([call("propose_plan", {
    plan_text: "x",
    draft_brief: { deliverables: [], intended_actions: [] },
  })]);
  assert.equal(r.ok, false);
});

test("parseIntent: propose_plan with malformed intended_actions -> invalid_args", () => {
  const r = parseIntent([call("propose_plan", {
    plan_text: "x",
    draft_brief: { deliverables: ["d"], intended_actions: [{ description: "no category" }] },
  })]);
  assert.equal(r.ok, false);
});

test("parseIntent: start_execution + non-approval user turn -> fabricated_approval", () => {
  const r = parseIntent(
    [call("start_execution", { approval_phrase: "yes" })],
    { lastUserTurn: "could you also draft a tweet about this?" },
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "fabricated_approval");
});

test("parseIntent: start_execution + clear rejection -> fabricated_approval", () => {
  const r = parseIntent(
    [call("start_execution", { approval_phrase: "they said yes" })],
    { lastUserTurn: "no, wait, let me think about this" },
  );
  assert.equal(r.ok, false);
});

test("parseIntent: start_execution with no lastUserTurn skips verification (replay path)", () => {
  const r = parseIntent([call("start_execution", { approval_phrase: "yes" })]);
  assert.equal(r.ok, true);
});

test("parseIntent: summarize_result with non-boolean offer_save -> invalid_args", () => {
  const r = parseIntent([call("summarize_result", { summary: "done", offer_save: "yes" })]);
  assert.equal(r.ok, false);
});

// -----------------------------------------------------------------------
// looksLikeApproval

test("looksLikeApproval: clear yes phrases", () => {
  for (const phrase of ["yes", "yeah", "yep", "go ahead", "ok", "proceed", "do it", "sounds good", "ship it", "approved", "looks good", "commit and push"]) {
    assert.equal(looksLikeApproval(phrase), true, `expected ${phrase} to be approval`);
  }
});

test("looksLikeApproval: clear no phrases", () => {
  for (const phrase of ["no", "nope", "not yet", "wait", "don't do that", "stop", "cancel", "abort"]) {
    assert.equal(looksLikeApproval(phrase), false, `expected ${phrase} to be rejection`);
  }
});

test("looksLikeApproval: rejection beats approval in same string (yes is in 'yes do NOT do that')", () => {
  // The "no" / "don't" rejection wins.
  assert.equal(looksLikeApproval("don't do that"), false);
});

test("looksLikeApproval: ambiguous turns are NOT approval", () => {
  for (const phrase of ["maybe?", "could you also...", "hmm", "what about X first", ""]) {
    assert.equal(looksLikeApproval(phrase), false, `${phrase} should not count as approval`);
  }
});

// -----------------------------------------------------------------------
// Drift constants

test("drift: thresholds at the documented values", () => {
  assert.equal(DRIFT_THRESHOLD, 3);
  assert.equal(HARD_FAIL_THRESHOLD, 5);
  assert.ok(HARD_FAIL_THRESHOLD > DRIFT_THRESHOLD);
});

test("drift fallback messages are plain-language (no jargon)", () => {
  // Non-devs should not see "tool call" or "intent" jargon.
  assert.equal(/tool call|intent/i.test(DRIFT_FALLBACK_QUESTION), false);
  assert.equal(/tool call|intent/i.test(HARD_FAIL_MESSAGE), false);
});

test("reminderForDriftCount: returns escalating reminders", () => {
  // 1, 2, 3 walk through the array.
  assert.equal(reminderForDriftCount(1), REMINDER_AFTER_DRIFT[0]);
  assert.equal(reminderForDriftCount(2), REMINDER_AFTER_DRIFT[1]);
  assert.equal(reminderForDriftCount(3), REMINDER_AFTER_DRIFT[2]);
  // Beyond the list, stays at the last (final) reminder.
  assert.equal(reminderForDriftCount(10), REMINDER_AFTER_DRIFT[REMINDER_AFTER_DRIFT.length - 1]);
});

test("REMINDER_AFTER_DRIFT entries reference the four tool names", () => {
  // Reminders should name the actual tool names so the model has explicit
  // anchors. At least one reminder should list all four.
  const allFour = REMINDER_AFTER_DRIFT.some((r) =>
    INTENT_TOOL_NAMES.every((name) => r.includes(name)),
  );
  assert.ok(allFour, "expected at least one reminder to name all four tools");
});
