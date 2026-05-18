// v0.10.0: adversarial drift coverage at the SESSION level.
//
// The intent contract is the load-bearing piece of v0.10. tests/chat/
// intent.test.ts proves the parser handles every failure mode correctly.
// This file proves the SESSION MANAGER routes each failure mode correctly:
// drift counter increments, deterministic fallback fires at threshold,
// hard-fail closes the session at HARD_FAIL_THRESHOLD, store records each
// drifted turn as intent="drift" for audit.
//
// Why this matters: a real LLM will drift in ways the mock can't perfectly
// reproduce. The session manager's response to drift IS the v0.10 safety
// margin against the brief's "intent extraction is too load-bearing to be
// wobbly" warning. If a real agent emits broken tool calls in production,
// these tests verify the session handles it gracefully instead of crashing
// or silently proceeding with garbage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-drift-"));
process.env.OPENWAR_HOME = TMP;
process.env.OPENWAR_CHATS_DIR = join(TMP, "chats");
process.env.OPENWAR_CHAT_STRICT = "1";

const { ChatSession } = await import("../../src/chat/session.js");
const { ChatStore, newChatId, readChat } = await import("../../src/state/chat-store.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { DRIFT_THRESHOLD, HARD_FAIL_THRESHOLD } = await import("../../src/chat/intent.js");
type ChatIO = import("../../src/chat/session.js").ChatIO;

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
  delete process.env.OPENWAR_CHATS_DIR;
  delete process.env.OPENWAR_CHAT_STRICT;
});

function capture(): { io: ChatIO; output: () => string } {
  let buf = "";
  return {
    io: { write: (s) => { buf += s; }, prompt: async () => "yes" },
    output: () => buf,
  };
}

function mkSession(adapter: MockAdapter, chatId = newChatId()) {
  const store = new ChatStore({
    chatId,
    enabled: true,
    openwarVersion: "0.10.0",
    agentAdapter: "mock",
    agentModel: "mock",
    execAdapter: "mock",
    execModel: "mock",
    projectSlug: "drift-test",
  });
  const { io, output } = capture();
  const session = new ChatSession({
    io,
    agentAdapter: adapter,
    execAdapter: adapter,
    projectSlug: "drift-test",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  return { session, output, chatId };
}

// -----------------------------------------------------------------------
// no_tool_call (free-text-only response)

test("drift: 3 consecutive free-text turns fire the deterministic fallback question", async () => {
  const adapter = new MockAdapter([
    "i think we should do x",
    "yeah definitely",
    "let me think about it more",
  ]);
  const { session, output } = mkSession(adapter);
  await session.handleUserInput("hey");
  assert.equal(session.getDriftCount(), DRIFT_THRESHOLD);
  assert.match(output(), /I'm having trouble understanding/);
});

// -----------------------------------------------------------------------
// 5 drift turns -> hard-fail closes the session cleanly

test("drift: HARD_FAIL_THRESHOLD drift turns close the session with hard_fail_intent_drift reason", async () => {
  // 5 free-text turns; the session needs HARD_FAIL_THRESHOLD (5) drifts
  // across multiple user-input cycles to reach hard-fail.
  const adapter = new MockAdapter([
    "free 1", "free 2", "free 3", "free 4", "free 5",
  ]);
  const { session, output, chatId } = mkSession(adapter);
  // Cycle 1: 3 drifts -> fallback shown, drift_count=3.
  await session.handleUserInput("hey");
  assert.equal(session.getDriftCount(), DRIFT_THRESHOLD);
  // Cycle 2: 1 drift -> silent return, drift_count=4.
  await session.handleUserInput("ok let's keep trying");
  assert.equal(session.getDriftCount(), 4);
  // Cycle 3: 1 drift -> hits HARD_FAIL_THRESHOLD (5) -> hard-fail message.
  await session.handleUserInput("one more time");
  assert.match(output(), /not able to make progress/);
  // Chat-store recorded the hard-fail end reason.
  const { events } = readChat(chatId);
  const ended = events.find((e) => e.type === "chat_session_ended");
  assert.ok(ended);
  if (ended?.type === "chat_session_ended") {
    assert.equal(ended.reason, "hard_fail_intent_drift");
  }
  // Drift count crossed the hard-fail threshold.
  assert.ok(session.getDriftCount() >= HARD_FAIL_THRESHOLD);
});

// -----------------------------------------------------------------------
// Each drifted turn stored as intent="drift" for audit

test("drift: each drift turn persists to chat-store with intent='drift'", async () => {
  const adapter = new MockAdapter([
    "free 1", "free 2", "free 3",
  ]);
  const { session, chatId } = mkSession(adapter);
  await session.handleUserInput("hey");
  const { events } = readChat(chatId);
  const agentTurns = events.filter((e) => e.type === "agent_turn") as Array<{ type: string; intent: string }>;
  assert.equal(agentTurns.length, 3);
  for (const t of agentTurns) assert.equal(t.intent, "drift");
});

// -----------------------------------------------------------------------
// Recovery: drift then a successful tool call resets the counter

test("drift: a successful intent call resets the drift counter", async () => {
  const adapter = new MockAdapter([
    "free 1",
    "free 2",
    // Third turn: agent recovers with a real tool call.
    { text: "", tool_calls: [{ id: "c1", name: "ask_clarification", arguments: { questions: ["what?"] } }] },
  ]);
  const { session } = mkSession(adapter);
  await session.handleUserInput("hey");
  assert.equal(session.getDriftCount(), 0, "drift counter should reset after a successful intent");
});

// -----------------------------------------------------------------------
// Multiple tool calls in one turn

test("drift: multiple tool calls in one turn counts as drift, not as a valid intent", async () => {
  const adapter = new MockAdapter([
    {
      text: "",
      tool_calls: [
        { id: "a", name: "ask_clarification", arguments: { questions: ["x?"] } },
        { id: "b", name: "propose_plan", arguments: { plan_text: "p", draft_brief: { deliverables: ["d"], intended_actions: [] } } },
      ],
    },
    "free text follow-up",
    "and another free text",
  ]);
  const { session } = mkSession(adapter);
  await session.handleUserInput("hey");
  assert.equal(session.getDriftCount(), DRIFT_THRESHOLD);
});

// -----------------------------------------------------------------------
// Hallucinated tool name

test("drift: hallucinated fifth-intent tool counts as drift", async () => {
  const adapter = new MockAdapter([
    { text: "", tool_calls: [{ id: "x", name: "execute_immediately", arguments: { go: true } }] },
    "free 2", "free 3",
  ]);
  const { session } = mkSession(adapter);
  await session.handleUserInput("hey");
  assert.equal(session.getDriftCount(), DRIFT_THRESHOLD);
});

// -----------------------------------------------------------------------
// Malformed arguments

test("drift: propose_plan with malformed draft_brief counts as drift", async () => {
  const adapter = new MockAdapter([
    {
      text: "",
      tool_calls: [{
        id: "x",
        name: "propose_plan",
        arguments: { plan_text: "x", draft_brief: { deliverables: "not an array" } },
      }],
    },
    "free 2", "free 3",
  ]);
  const { session } = mkSession(adapter);
  await session.handleUserInput("hey");
  assert.equal(session.getDriftCount(), DRIFT_THRESHOLD);
});

// -----------------------------------------------------------------------
// Fabricated approval

test("drift: start_execution with no plan pending and no user approval counts as drift", async () => {
  // No plan ever proposed; agent jumps straight to start_execution claiming
  // approval. parseIntent's lastUserTurn verification flags it as
  // fabricated_approval -> drift.
  const adapter = new MockAdapter([
    { text: "", tool_calls: [{ id: "x", name: "start_execution", arguments: { approval_phrase: "user said yes" } }] },
    "free 2", "free 3",
  ]);
  const { session } = mkSession(adapter);
  // User's input is "what tools do you have" -- clearly not approval.
  await session.handleUserInput("what tools do you have");
  assert.equal(session.getDriftCount(), DRIFT_THRESHOLD);
});

// -----------------------------------------------------------------------
// start_execution without a pending plan (post-approval-parsed path)

test("drift recovery surface: start_execution with valid approval but no pending plan surfaces a graceful message", async () => {
  // Agent emits start_execution. User's last turn IS "yes" so parseIntent
  // accepts. But no propose_plan ran, so pendingBrief is null. The session
  // manager should print the "lost track" message and wait rather than
  // crash or execute garbage.
  const adapter = new MockAdapter([
    { text: "", tool_calls: [{ id: "x", name: "start_execution", arguments: { approval_phrase: "yes" } }] },
  ]);
  const { session, output } = mkSession(adapter);
  await session.handleUserInput("yes");
  assert.match(output(), /lost track of the plan/);
  // No execution happened.
  assert.equal(session.getPendingBrief(), null);
});

// -----------------------------------------------------------------------
// Drift WITHIN a propose_plan -> approve cycle: agent drifts AFTER approval

test("drift: agent drifts after execution; session does not crash, waits for user", async () => {
  const adapter = new MockAdapter([
    // Turn 1: propose plan.
    {
      text: "",
      tool_calls: [{
        id: "p",
        name: "propose_plan",
        arguments: {
          plan_text: "step 1",
          draft_brief: {
            deliverables: ["d"],
            intended_actions: [{ description: "read", category: "filesystem_read" }],
          },
        },
      }],
    },
    // Turn 2 (after approval, post-execution): agent drifts instead of
    // summarizing. The loop should hit DRIFT_THRESHOLD and surface the
    // fallback question.
    "free 1", "free 2", "free 3",
  ]);
  const { session, output } = mkSession(adapter);
  await session.handleUserInput("do the thing");
  assert.match(output(), /Plan:/);
  await session.handleUserInput("yes");
  // After executeRun + driveAgentUntilWaitState, agent drifts to fallback.
  assert.match(output(), /I'm having trouble understanding/);
});
