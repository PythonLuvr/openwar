// v0.8: openwar replay correctness.
// - Re-runs detectors against recorded transcript turns, NOT against the trace.
// - Halts at Phase 2 markers in the transcript (same shape as original run).
// - Reports detector drift between current code and recorded trace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v08-replay-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v08-replay-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { run } = await import("../../src/runner.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { createScriptedIO } = await import("../../src/io.js");
const { runReplay } = await import("../../src/cli/replay.js");

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

const BRIEF = (id: string) => `---
project: replay-test
brief_id: ${id}
scope_locked: false
authorized_costs:
  - generation_credits
---

# Objective
Replay smoke.

# Deliverables
- One assertion.

# Constraints
None.

# Tools required
Text.

# Notes / unknowns
None.
`;

const CONFIRMATION = `## Phase 0: Brief intake

**Confirmation Summary**

Objective: smoke
Deliverables: one
Constraints: none
Tools required: text
Unknowns: none

Ready, gated or auto-pilot?
`;

const COMPLETION = `## Phase 4: Completion

Delivered: x.
Unresolved: none.
Open: none.

All deliverables shipped.`;

const BLOCKER = `## Phase 2: Blocker

I cannot proceed; the input is missing.`;

test("replay: completed run produces detectors_fired including completion and drift_count=0", async () => {
  const id = "2026-05-18-rcomplete";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONFIRMATION, COMPLETION, "Final report."]);
  await run({ briefSource: BRIEF(id), adapter, io, mode: "auto", ephemeral: false });

  let output = "";
  const result = runReplay({ briefId: id, write: (s) => { output += s; } });
  assert.ok(result.assistant_turns >= 1);
  assert.ok(result.completed);
  assert.ok(result.detectors_fired.includes("completion"));
  assert.equal(result.drift_count, 0, `unexpected drift; output was:\n${output}`);
  // [replay]-prefix marker is present.
  assert.match(output, /\[replay\]/);
  assert.match(output, /Phase 4 detected/);
  assert.match(output, /completed:\s+true/);
});

test("replay: blocker in transcript halts replay (matches original run shape)", async () => {
  const id = "2026-05-18-rblock";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONFIRMATION, BLOCKER]);
  await run({ briefSource: BRIEF(id), adapter, io, mode: "auto", ephemeral: false });

  let output = "";
  const result = runReplay({ briefId: id, write: (s) => { output += s; } });
  assert.equal(result.halted_at_blocker, true);
  assert.ok(result.detectors_fired.includes("blocker"));
  assert.match(output, /HALT \(matches original run shape\)/);
});

test("replay: missing session prints a not-found message and reports zero turns", () => {
  let output = "";
  const result = runReplay({ briefId: "2026-05-18-doesnotexist", write: (s) => { output += s; } });
  assert.match(output, /no session found/);
  assert.equal(result.assistant_turns, 0);
});

test("replay: prefixes every line of normal output with [replay]", async () => {
  const id = "2026-05-18-rprefix";
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONFIRMATION, COMPLETION, "Final."]);
  await run({ briefSource: BRIEF(id), adapter, io, mode: "auto", ephemeral: false });

  let output = "";
  runReplay({ briefId: id, write: (s) => { output += s; } });
  // Every non-empty line should begin with [replay].
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    assert.match(line, /^\[replay\]/);
  }
});
