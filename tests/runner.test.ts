import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/runner.js";
import { MockAdapter } from "../src/adapters/mock.js";
import { createScriptedIO } from "../src/io.js";

const BRIEF = `---
project: demo
brief_id: 2026-01-15-T1
scope_locked: false
authorized_costs:
  - generation_credits
---

# Objective

Produce a short haiku about test fixtures.

# Deliverables

- One haiku, three lines, 5-7-5 syllables.

# Constraints

- No em dashes.

# Tools required

- Text only.

# Notes / unknowns

- None.
`;

// Phase 0 reply that satisfies the confirmation detector.
const CONFIRMATION_SUMMARY = `## Phase 0: Brief intake

**Confirmation Summary**

Objective: Produce a short haiku about test fixtures.

Deliverables: One haiku, three lines.

Constraints: No em dashes.

Tools required: Text only.

Unknowns: None.

Which mode would you like, gated or auto-pilot?
`;

const EXEC_TURN_1 = `Step 1: drafting candidate lines.

Stable scaffold hums,
green checks bloom across the board,
fixtures dream of edge.

Step 2: would you like a second pass?`;

const COMPLETION_TURN = `## Phase 4: Completion

Delivered: one haiku.
Unresolved: none.
Open: none.

All deliverables shipped.`;

test("runner: happy path through Phase 0 to Phase 4 in auto mode", async () => {
  const io = createScriptedIO({
    inputs: [
      "go", // accept Confirmation Summary
    ],
  });
  const adapter = new MockAdapter([
    CONFIRMATION_SUMMARY,
    EXEC_TURN_1,
    COMPLETION_TURN, // model declares Phase 4 mid-execute
    "Delivered: one haiku.\nUnresolved: none.\nOpen: none.", // canonical Phase 4 report
  ]);

  const result = await run({
    briefSource: BRIEF,
    adapter,
    io,
    mode: "auto",
    ephemeral: true,
  });

  assert.equal(result.completed, true);
  assert.equal(result.halted, false);
  assert.equal(result.final_phase, "done");
  // 4 calls: intake + execute step 1 + execute step 2 (detects completion) + canonical Phase 4 report.
  assert.equal(adapter.calls.length, 4);
});

test("runner: halts on blocker detected in Phase 1", async () => {
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([
    CONFIRMATION_SUMMARY,
    "## Phase 2: Blocker\n\nI cannot proceed; the input fixture file is missing.",
  ]);

  const result = await run({
    briefSource: BRIEF,
    adapter,
    io,
    mode: "auto",
    ephemeral: true,
  });

  assert.equal(result.completed, false);
  assert.equal(result.halted, true);
  assert.equal(result.final_phase, "blocker");
});

test("runner: destructive denied -> agent receives denial message", async () => {
  const io = createScriptedIO({
    inputs: ["go"],
    confirmations: [false], // deny the destructive action
  });
  const adapter = new MockAdapter([
    CONFIRMATION_SUMMARY,
    "Next I'll force-push to main so the rebase lands cleanly.",
    // After denial, model returns a non-destructive recovery, then completes.
    "Understood, I will not force-push. Drafting an alternative below.\n\n## Phase 4: Completion\n\nAll deliverables shipped.",
    "Delivered: alternative path. Unresolved: none. Open: none.",
  ]);

  const result = await run({
    briefSource: BRIEF,
    adapter,
    io,
    mode: "auto",
    ephemeral: true,
  });

  assert.equal(result.completed, true);
  assert.equal(result.halted, false);
  // The runner should have re-invoked execute after the denial message.
  assert.ok(adapter.calls.length >= 3);
  // Last user message before final assistant should contain the denial wording.
  const messages = result.messages;
  const denial = messages.find(
    (m) => m.role === "user" && m.content.includes("DENIED the destructive action"),
  );
  assert.ok(denial, "expected denial message to be recorded in session history");
});

test("runner: refuses to start when intake reply does not get accepted", async () => {
  const io = createScriptedIO({
    inputs: ["actually, never mind, rewrite the objective"],
  });
  const adapter = new MockAdapter([CONFIRMATION_SUMMARY]);

  const result = await run({
    briefSource: BRIEF,
    adapter,
    io,
    mode: "auto",
    ephemeral: true,
  });

  assert.equal(result.completed, false);
  assert.equal(result.halted, true);
  assert.equal(result.halt_reason, "intake_not_accepted");
  // Only the intake call should have happened.
  assert.equal(adapter.calls.length, 1);
});
