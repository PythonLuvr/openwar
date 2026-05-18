// v0.10.0 INTEGRATION: full chat lifecycle end-to-end.
//
// One test exercising:
//   fresh chat -> conversation (clarify + propose) -> approval -> execution
//   against a mock adapter -> summarize -> save as brief -> re-parse the
//   saved brief through openwar's brief parser -> assert it runs (mock-
//   adapter) and produces the chat_session_compiled trace event.
//
// This is the headline test for v0.10.0. If the structural plumbing breaks
// anywhere in the chain, this fails before any unit test does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-integration-"));
process.env.OPENWAR_HOME = TMP;
process.env.OPENWAR_SESSIONS_DIR = join(TMP, "sessions");
process.env.OPENWAR_CHATS_DIR = join(TMP, "chats");

const { ChatSession } = await import("../../src/chat/session.js");
const { ChatStore, newChatId, readChat } = await import("../../src/state/chat-store.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { run } = await import("../../src/runner.js");
const { parseBrief } = await import("../../src/brief.js");
const { readTrace } = await import("../../src/state/trace.js");
const { savedBriefPath } = await import("../../src/state/paths.js");
const { createScriptedIO } = await import("../../src/io.js");
type ChatIO = import("../../src/chat/session.js").ChatIO;
type Brief = import("../../src/types.js").Brief;

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_CHATS_DIR;
});

test("FULL CYCLE: chat -> propose -> approve -> execute -> summarize -> save -> replay", async () => {
  const chatId = newChatId();
  const store = new ChatStore({
    chatId,
    enabled: true,
    openwarVersion: "0.10.0",
    agentAdapter: "mock",
    agentModel: "mock",
    execAdapter: "mock",
    execModel: "mock",
    projectSlug: "integration-demo",
  });

  // Conversation-agent script: clarification -> propose -> summarize.
  const agentAdapter = new MockAdapter([
    {
      text: "",
      tool_calls: [{
        id: "c1",
        name: "ask_clarification",
        arguments: { questions: ["which file should I edit?"] },
      }],
    },
    {
      text: "got it, here is the plan",
      tool_calls: [{
        id: "c2",
        name: "propose_plan",
        arguments: {
          plan_text: "Read the index.\nAdd testimonials.\nShow diff.",
          draft_brief: {
            deliverables: ["testimonials section in index.html"],
            intended_actions: [
              { description: "read files", category: "filesystem_read" },
              { description: "write files", category: "filesystem_write" },
            ],
          },
        },
      }],
    },
    {
      text: "",
      tool_calls: [{
        id: "c3",
        name: "summarize_result",
        arguments: { summary: "Added testimonials section.", offer_save: true },
      }],
    },
  ]);

  // The integration test capture writes to a string buffer and provides
  // scripted answers to any prompts (none expected for this flow).
  let captured = "";
  const io: ChatIO = {
    write: (s) => { captured += s; },
    prompt: async () => "yes",
  };

  // Stub the executeRun callback. Real runner.run() is exercised below in
  // the replay step; here we just need to confirm the session manager
  // hands off cleanly.
  let executedBrief: Brief | null = null;
  const session = new ChatSession({
    io,
    agentAdapter,
    execAdapter: agentAdapter,
    projectSlug: "integration-demo",
    workdir: "/work",
    store,
    executeRun: async (brief: Brief) => {
      executedBrief = brief;
      return { completed: true, halted: false };
    },
  });

  // Turn 1: user describes intent.
  await session.handleUserInput("add testimonials to my landing page");
  assert.match(captured, /which file should I edit\?/);

  // Turn 2: user answers, agent proposes plan.
  await session.handleUserInput("/index.html, mid-page");
  assert.match(captured, /Plan:/);
  assert.match(captured, /Add testimonials/);

  // Turn 3: user approves. Drives execution + summarization.
  await session.handleUserInput("yes");
  assert.ok(executedBrief, "expected executeRun to fire after approval");
  // Conservative-auth invariant holds.
  assert.deepEqual(executedBrief!.frontmatter.authorized_costs, ["filesystem_read", "filesystem_write"]);
  // Summary surfaced.
  assert.match(captured, /Added testimonials section/);
  // Save prompt offered.
  assert.match(captured, /Want to save this conversation/);

  // Turn 4: user saves the brief.
  await session.handleUserInput("/save my-testimonials-flow");
  assert.match(captured, /saved to/);

  const savedPath = savedBriefPath("my-testimonials-flow");
  assert.ok(existsSync(savedPath), `saved brief should exist at ${savedPath}`);

  // ---------------------------------------------------------------------
  // REPLAY: parse the saved brief and run it via runner.run() to confirm
  // round-trip works end-to-end.
  // ---------------------------------------------------------------------
  const raw = readFileSync(savedPath, "utf8");
  const reparsed = parseBrief(raw);
  assert.equal(reparsed.frontmatter.project, "integration-demo");
  assert.equal(reparsed.frontmatter.mode, "gated");

  // Run the saved brief via the real runner using mock adapter.
  const runScript = [
    // Phase 0 Confirmation Summary.
    `Confirmation Summary

Objective: testimonials section in index.html
Deliverables: testimonials added
Constraints: none
Tools required: text
Unknowns: none

Ready to proceed in auto mode.`,
    // Phase 4 completion.
    `Phase 4: Completion

All deliverables shipped.`,
    `Final report.`,
  ];
  const runAdapter = new MockAdapter(runScript);
  const replayIo = createScriptedIO({ inputs: ["go"] });
  const result = await run({
    briefSource: raw,
    adapter: runAdapter,
    io: replayIo,
    mode: "auto",
    ephemeral: false,
    chatId, // mark as chat-originated so the trace gets chat_session_compiled
  });
  assert.equal(result.completed, true);

  // Verify chat_session_compiled was emitted into the brief's trace.
  const briefId = reparsed.frontmatter.brief_id!;
  const traceResult = readTrace(briefId);
  const compiledEvent = traceResult.events.find((e) => e.type === "chat_session_compiled");
  assert.ok(compiledEvent, "expected chat_session_compiled event in the replayed brief's trace");
  if (compiledEvent && compiledEvent.type === "chat_session_compiled") {
    assert.equal(compiledEvent.chat_id, chatId);
    assert.equal(compiledEvent.brief_id, briefId);
  }

  // Verify the chat-store recorded the full lifecycle correctly.
  const { events: chatEvents } = readChat(chatId);
  const eventTypes = chatEvents.map((e) => e.type);
  assert.ok(eventTypes.includes("chat_session_started"));
  assert.ok(eventTypes.includes("user_turn"));
  assert.ok(eventTypes.includes("agent_turn"));
  assert.ok(eventTypes.includes("plan_proposed"));
  assert.ok(eventTypes.includes("plan_approved"));
  assert.ok(eventTypes.includes("execution_started"));
  assert.ok(eventTypes.includes("execution_completed"));
  assert.ok(eventTypes.includes("brief_saved"));
});
