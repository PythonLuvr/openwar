// v0.10.0 session manager: drives MockAdapter scripts through the full
// clarify -> propose -> approve -> execute -> summarize -> save loop.
// Also covers slash commands, drift hard-fail, and resume-from-events.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-session-"));
process.env.OPENWAR_HOME = TMP;
process.env.OPENWAR_CHATS_DIR = join(TMP, "chats");
process.env.OPENWAR_CHAT_STRICT = "1";

const { ChatSession, runnerIoFromChatIo } = await import("../../src/chat/session.js");
const { ChatStore, newChatId, readChat, nullChatStore } = await import("../../src/state/chat-store.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
type ChatIO = import("../../src/chat/session.js").ChatIO;
type ExecuteOutcome = import("../../src/chat/session.js").ExecuteOutcome;
type Brief = import("../../src/types.js").Brief;

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
  delete process.env.OPENWAR_CHATS_DIR;
  delete process.env.OPENWAR_CHAT_STRICT;
});

function captureIO(scriptedAnswers: string[] = []): { io: ChatIO; output: () => string; capturedPrompts: string[] } {
  let out = "";
  const prompts: string[] = [];
  let answerCursor = 0;
  return {
    io: {
      write: (s) => { out += s; },
      prompt: async (q) => {
        prompts.push(q);
        return scriptedAnswers[answerCursor++] ?? "yes";
      },
    },
    output: () => out,
    capturedPrompts: prompts,
  };
}

function mkStore(chatId: string, enabled = true) {
  return enabled
    ? new ChatStore({
        chatId,
        enabled: true,
        openwarVersion: "0.10.0",
        agentAdapter: "mock",
        agentModel: "mock",
        execAdapter: "mock",
        execModel: "mock",
        projectSlug: "demo",
      })
    : nullChatStore();
}

const PROPOSE_CALL = {
  id: "p1",
  name: "propose_plan",
  arguments: {
    plan_text: "Read the page.\nAdd testimonials section.\nShow diff.",
    draft_brief: {
      deliverables: ["testimonials section in index.html"],
      intended_actions: [
        { description: "read files", category: "filesystem_read" },
        { description: "write files", category: "filesystem_write" },
      ],
    },
  },
};

const SUMMARIZE_CALL = {
  id: "s1",
  name: "summarize_result",
  arguments: { summary: "Done. Added testimonials.", offer_save: true },
};

// -----------------------------------------------------------------------

test("session: clarify -> propose -> approve -> execute -> summarize happy path", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([
    // Turn 1: user said "add testimonials"; agent asks clarification.
    {
      text: "",
      tool_calls: [{
        id: "c1",
        name: "ask_clarification",
        arguments: { questions: ["which file?", "where in the page?", "how many?"] },
      }],
    },
    // Turn 2: user answered; agent proposes plan.
    { text: "got it. here is the plan.", tool_calls: [PROPOSE_CALL] },
    // Turn 3: user approves (handled outside agent loop, not visible to mock).
    // Turn 4: after execution completes, agent summarizes.
    { text: "", tool_calls: [SUMMARIZE_CALL] },
  ]);
  const { io, output } = captureIO();
  let executeCalled = false;
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async (brief: Brief): Promise<ExecuteOutcome> => {
      executeCalled = true;
      assert.ok(brief.frontmatter.authorized_costs.includes("filesystem_write"));
      // Destructive auto-grant invariant: no git_push, deploy, etc.
      for (const cat of ["git_push", "deploy", "external_message"]) {
        assert.equal(brief.frontmatter.authorized_costs.includes(cat), false);
      }
      return { completed: true, halted: false };
    },
  });

  // Turn 1.
  await session.handleUserInput("add testimonials");
  assert.match(output(), /which file\?/);

  // Turn 2.
  await session.handleUserInput("/index.html, mid-page, three placeholders");
  assert.match(output(), /Plan:/);
  assert.match(output(), /Proceed\?/);
  // Refused list should NOT appear since the plan only declared safe categories.

  // Turn 3: user approves; this triggers execution + then drives the agent
  // until the next wait state, which is summarize.
  await session.handleUserInput("yes");
  assert.equal(executeCalled, true);
  assert.match(output(), /Done\. Added testimonials/);
  assert.match(output(), /Want to save this conversation as a reusable brief/);
});

test("session: drift -> deterministic fallback question after threshold", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  // Agent emits only free text three times in a row. After three the
  // fallback fires.
  const agent = new MockAdapter([
    "free text 1, no tool call",
    "free text 2, still no tool call",
    "free text 3, still nothing",
  ]);
  const { io, output } = captureIO();
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  await session.handleUserInput("hey");
  assert.match(output(), /I'm having trouble understanding/);
  assert.equal(session.getDriftCount(), 3);
});

test("session: /help prints command list", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([]);
  const { io, output } = captureIO();
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  await session.handleUserInput("/help");
  assert.match(output(), /\/save/);
  assert.match(output(), /\/quit/);
});

test("session: /quit ends the session and writes a chat_session_ended event", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([]);
  const { io } = captureIO();
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  const outcome = await session.handleUserInput("/quit");
  assert.equal(outcome, "ended");
  const { events } = readChat(chatId);
  assert.ok(events.some((e) => e.type === "chat_session_ended"));
});

test("session: /save without a compiled brief tells the user to describe first", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([]);
  const { io, output } = captureIO();
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  await session.handleUserInput("/save");
  assert.match(output(), /no compiled brief in this session yet/);
});

test("session: /save after a compiled brief writes the saved-brief file", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([
    { text: "", tool_calls: [PROPOSE_CALL] },
    { text: "", tool_calls: [SUMMARIZE_CALL] },
  ]);
  const { io, output } = captureIO();
  let executed = false;
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => { executed = true; return { completed: true, halted: false }; },
  });
  await session.handleUserInput("add testimonials");   // -> propose_plan
  await session.handleUserInput("yes");                // -> approve + execute + summarize
  assert.ok(executed);
  await session.handleUserInput("/save my-custom-name");
  assert.match(output(), /saved to/);
  // Confirms chat-store event recorded.
  const { events } = readChat(chatId);
  assert.ok(events.some((e) => e.type === "brief_saved"));
});

test("session: rejecting a plan clears pending state and the agent can repropose", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([
    // Turn 1: propose plan.
    { text: "", tool_calls: [PROPOSE_CALL] },
    // Turn 2 (after rejection): agent asks clarification.
    {
      text: "",
      tool_calls: [{
        id: "c2",
        name: "ask_clarification",
        arguments: { questions: ["what should I change?"] },
      }],
    },
  ]);
  const { io, output } = captureIO();
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  await session.handleUserInput("do the thing");
  assert.match(output(), /Plan:/);
  await session.handleUserInput("change it"); // not approval -> rejection path
  // After rejection, pendingBrief is cleared.
  assert.equal(session.getPendingBrief(), null);
  // Agent ran a follow-up clarification turn.
  assert.match(output(), /what should I change/);
});

test("session: /history prints the conversation buffer in order", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([
    { text: "got it", tool_calls: [{ id: "c1", name: "ask_clarification", arguments: { questions: ["x?"] } }] },
  ]);
  const { io, output } = captureIO();
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  await session.handleUserInput("hello");
  await session.handleUserInput("/history");
  // Both user and agent turns appear.
  assert.match(output(), /\[user\] hello/);
  assert.match(output(), /\[agent\] got it/);
});

test("session: resume from prior events restores conversation buffer", () => {
  const chatId = newChatId();
  const store = mkStore(chatId, false);
  const session = new ChatSession({
    io: { write: () => {}, prompt: async () => "" },
    agentAdapter: new MockAdapter([]),
    execAdapter: new MockAdapter([]),
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
    resumeEvents: [
      { type: "chat_session_started", chat_id: chatId, schema_version: 1, started_at: "t0", openwar_version: "0.10.0", agent_adapter: "mock", agent_model: "mock", exec_adapter: "mock", exec_model: "mock", project_slug: "demo" },
      { type: "user_turn", at: "t1", content: "prior request" },
      { type: "agent_turn", at: "t2", content: "prior reply", intent: "ask_clarification" },
    ],
  });
  const buffer = session.getBuffer();
  assert.equal(buffer.turns.length, 2);
  assert.equal(buffer.turns[0]!.role, "user");
  assert.equal(buffer.turns[0]!.content, "prior request");
});

test("runnerIoFromChatIo: maps ChatIO methods to RunnerIO contract", async () => {
  let written = "";
  const chatIo: ChatIO = {
    write: (s) => { written += s; },
    prompt: async () => "yes",
  };
  const rio = runnerIoFromChatIo(chatIo);
  rio.write("hello");
  rio.banner("BANNER");
  rio.warn("careful");
  const confirmed = await rio.confirm("ok?");
  assert.equal(confirmed, true);
  assert.match(written, /hello/);
  assert.match(written, /--- BANNER ---/);
  assert.match(written, /warning: careful/);
});

test("session: streamTraceEvent routes destructive events to the operator and back to runtime", async () => {
  const chatId = newChatId();
  const store = mkStore(chatId);
  const agent = new MockAdapter([]);
  const { io, capturedPrompts } = captureIO(["yes"]);
  const session = new ChatSession({
    io,
    agentAdapter: agent,
    execAdapter: agent,
    projectSlug: "demo",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
  });
  const result = await session.streamTraceEvent({
    type: "detector_fired",
    detector: "destructive",
    payload: { action: "git_push", destructive: true, authorized: false },
    at: "t",
  });
  assert.ok(result);
  assert.equal(result?.destructiveResponse, "yes");
  // Prompt text included the consequence sentence.
  assert.match(capturedPrompts[0]!, /publish this change/);
});
