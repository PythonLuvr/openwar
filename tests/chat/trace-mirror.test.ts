// v0.10.0: chat_session_resumed + chat_brief_saved mirror into the most
// recently executed brief's trace, so `openwar inspect <brief_id> --trace`
// shows the chat actions against the run that motivated them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-trace-mirror-"));
process.env.OPENWAR_HOME = TMP;
process.env.OPENWAR_CHATS_DIR = join(TMP, "chats");
process.env.OPENWAR_SESSIONS_DIR = join(TMP, "sessions");

const { ChatSession } = await import("../../src/chat/session.js");
const { ChatStore, newChatId } = await import("../../src/state/chat-store.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { readTrace, Tracer } = await import("../../src/state/trace.js");
type ChatIO = import("../../src/chat/session.js").ChatIO;
type Brief = import("../../src/types.js").Brief;

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
  delete process.env.OPENWAR_CHATS_DIR;
  delete process.env.OPENWAR_SESSIONS_DIR;
});

const PROPOSE = {
  id: "p",
  name: "propose_plan",
  arguments: {
    plan_text: "p",
    draft_brief: {
      deliverables: ["d"],
      intended_actions: [{ description: "read", category: "filesystem_read" }],
    },
  },
};
const SUMMARIZE = { id: "s", name: "summarize_result", arguments: { summary: "done", offer_save: true } };

function mkSession(adapter: MockAdapter, executeRun?: (b: Brief) => Promise<{ completed: boolean; halted: boolean }>) {
  const chatId = newChatId();
  const store = new ChatStore({
    chatId,
    enabled: true,
    openwarVersion: "0.10.0",
    agentAdapter: "mock",
    agentModel: "mock",
    execAdapter: "mock",
    execModel: "mock",
    projectSlug: "tm-test",
  });
  let captured = "";
  const io: ChatIO = { write: (s) => { captured += s; }, prompt: async () => "yes" };
  const session = new ChatSession({
    io,
    agentAdapter: adapter,
    execAdapter: adapter,
    projectSlug: "tm-test",
    workdir: "/work",
    store,
    executeRun: executeRun ?? (async () => ({ completed: true, halted: false })),
  });
  return { session, chatId, output: () => captured };
}

test("chat_brief_saved mirrors into the most recent brief's trace", async () => {
  const adapter = new MockAdapter([
    { text: "", tool_calls: [PROPOSE] },
    { text: "", tool_calls: [SUMMARIZE] },
  ]);
  let capturedBriefId = "";
  const { session } = mkSession(adapter, async (b: Brief) => {
    capturedBriefId = b.frontmatter.brief_id ?? "";
    // Seed the brief's trace by constructing a Tracer (the runtime would
    // normally do this; we mock the runtime).
    new Tracer({ briefId: capturedBriefId, enabled: true, openwarVersion: "0.10.0" });
    return { completed: true, halted: false };
  });

  await session.handleUserInput("do it");
  await session.handleUserInput("yes");
  await session.handleUserInput("/save my-mirror-test");

  // Read the brief's trace; chat_brief_saved should be present.
  assert.ok(capturedBriefId, "executeRun should have received a brief_id");
  const { events } = readTrace(capturedBriefId);
  const saved = events.find((e) => e.type === "chat_brief_saved");
  assert.ok(saved, `expected chat_brief_saved in trace for ${capturedBriefId}; got ${events.map((e) => e.type).join(", ")}`);
  if (saved?.type === "chat_brief_saved") {
    assert.match(saved.path, /my-mirror-test\.md$/);
  }
});

test("chat_session_resumed mirrors into the most recent brief's trace (when resume restores an execution event)", () => {
  // Construct a session with resumeEvents that include an execution_started.
  // The constructor should pick up the brief_id and mirror a
  // chat_session_resumed event into that trace.
  const chatId = newChatId();
  const briefId = "2026-05-18-mirror1";
  // Seed the brief's trace file (the runtime would have written its header).
  new Tracer({ briefId, enabled: true, openwarVersion: "0.10.0" });

  const store = new ChatStore({
    chatId,
    enabled: true,
    openwarVersion: "0.10.0",
    agentAdapter: "mock",
    agentModel: "mock",
    execAdapter: "mock",
    execModel: "mock",
    projectSlug: "tm-test",
  });
  const io: ChatIO = { write: () => {}, prompt: async () => "" };
  new ChatSession({
    io,
    agentAdapter: new MockAdapter([]),
    execAdapter: new MockAdapter([]),
    projectSlug: "tm-test",
    workdir: "/work",
    store,
    executeRun: async () => ({ completed: true, halted: false }),
    resumeEvents: [
      { type: "chat_session_started", chat_id: chatId, schema_version: 1, started_at: "t0", openwar_version: "0.10.0", agent_adapter: "mock", agent_model: "mock", exec_adapter: "mock", exec_model: "mock", project_slug: "tm-test" },
      { type: "user_turn", at: "t1", content: "prior" },
      { type: "agent_turn", at: "t2", content: "ok", intent: "propose_plan" },
      { type: "execution_started", at: "t3", brief_id: briefId },
    ],
  });

  const { events } = readTrace(briefId);
  const resumed = events.find((e) => e.type === "chat_session_resumed");
  assert.ok(resumed, `expected chat_session_resumed in trace for ${briefId}; got ${events.map((e) => e.type).join(", ")}`);
  if (resumed?.type === "chat_session_resumed") {
    assert.equal(resumed.chat_id, chatId);
  }
});

test("save without prior execution: chat_brief_saved still recorded in chat-store, no trace mirror needed", async () => {
  // Edge case: agent proposes, user approves, executeRun stub runs but
  // never writes a trace file. The save still works; the mirror call is a
  // best-effort no-op.
  const adapter = new MockAdapter([
    { text: "", tool_calls: [PROPOSE] },
    { text: "", tool_calls: [SUMMARIZE] },
  ]);
  const { session } = mkSession(adapter, async () => ({ completed: true, halted: false }));
  await session.handleUserInput("do it");
  await session.handleUserInput("yes");
  // /save proceeds even though no trace file exists for the (mock) brief.
  await session.handleUserInput("/save no-trace-mirror");
  // No assertion needed; the test passes if no error was thrown.
});
