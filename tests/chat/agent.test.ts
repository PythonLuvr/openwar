// v0.10.0 conversation agent: tool-call contract, drift handling, system
// prompt invariants, context-note injection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { callConversationAgent, CONVERSATION_AGENT_SYSTEM_PROMPT } from "../../src/chat/agent.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import type { ConversationBuffer } from "../../src/chat/compile.js";

const BUFFER: ConversationBuffer = {
  turns: [{ role: "user", content: "add testimonials", at: "t" }],
};

test("system prompt: documents the four-tool contract", () => {
  for (const tool of ["ask_clarification", "propose_plan", "start_execution", "summarize_result"]) {
    assert.match(CONVERSATION_AGENT_SYSTEM_PROMPT, new RegExp(tool));
  }
});

test("system prompt: tells the agent NEVER to execute directly", () => {
  assert.match(CONVERSATION_AGENT_SYSTEM_PROMPT, /never call tools to read files or run commands directly/i);
});

test("system prompt: locks the off-topic single-task rule", () => {
  assert.match(CONVERSATION_AGENT_SYSTEM_PROMPT, /off-topic mid-conversation/i);
  assert.match(CONVERSATION_AGENT_SYSTEM_PROMPT, /remember it for after/i);
});

test("system prompt: warns about conservative destructive auto-grant", () => {
  for (const cat of ["git_push", "deploy", "external_message", "shell_exec"]) {
    assert.match(CONVERSATION_AGENT_SYSTEM_PROMPT, new RegExp(cat));
  }
});

test("system prompt: bans internal jargon to the user", () => {
  assert.match(CONVERSATION_AGENT_SYSTEM_PROMPT, /Never expose internal terms/);
});

test("callConversationAgent: routes a propose_plan tool call to parsed.intent=propose_plan", async () => {
  const adapter = new MockAdapter([
    {
      text: "got it, here is the plan",
      tool_calls: [{
        id: "c1",
        name: "propose_plan",
        arguments: {
          plan_text: "Step 1.\nStep 2.",
          draft_brief: {
            deliverables: ["the thing"],
            intended_actions: [{ description: "read files", category: "filesystem_read" }],
          },
        },
      }],
    },
  ]);
  const r = await callConversationAgent({ adapter, buffer: BUFFER, driftCount: 0 });
  assert.equal(r.parsed.ok, true);
  if (r.parsed.ok) assert.equal(r.parsed.intent.intent, "propose_plan");
});

test("callConversationAgent: free-text-only response surfaces as no_tool_call drift", async () => {
  const adapter = new MockAdapter(["I think we should do X. (no tool call)"]);
  const r = await callConversationAgent({ adapter, buffer: BUFFER, driftCount: 0 });
  assert.equal(r.parsed.ok, false);
  if (!r.parsed.ok) assert.equal(r.parsed.reason, "no_tool_call");
});

test("callConversationAgent: contextNotes get appended to system prompt", async () => {
  const adapter = new MockAdapter([
    { text: "", tool_calls: [{ id: "c1", name: "ask_clarification", arguments: { questions: ["which file?"] } }] },
  ]);
  await callConversationAgent({
    adapter,
    buffer: BUFFER,
    driftCount: 0,
    contextNotes: ["prior decision: use tailwind", "constraint: no inline styles"],
  });
  const lastSystem = adapter.calls[0]!.system;
  assert.match(lastSystem, /Context from prior work/);
  assert.match(lastSystem, /prior decision: use tailwind/);
});

test("callConversationAgent: drift count > 0 escalates reminder in system prompt", async () => {
  const adapter = new MockAdapter([
    { text: "", tool_calls: [{ id: "c1", name: "ask_clarification", arguments: { questions: ["?"] } }] },
  ]);
  await callConversationAgent({ adapter, buffer: BUFFER, driftCount: 2 });
  const sys = adapter.calls[0]!.system;
  assert.match(sys, /Reminder/i);
});

test("callConversationAgent: passes lastUserTurn into parser for approval verification", async () => {
  const adapter = new MockAdapter([
    { text: "", tool_calls: [{ id: "c1", name: "start_execution", arguments: { approval_phrase: "yes" } }] },
  ]);
  const r = await callConversationAgent({
    adapter,
    buffer: BUFFER,
    driftCount: 0,
    lastUserTurn: "could you also add a tweet draft", // NOT an approval
  });
  assert.equal(r.parsed.ok, false);
  if (!r.parsed.ok) assert.equal(r.parsed.reason, "fabricated_approval");
});
