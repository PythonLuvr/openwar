// v0.8: end-to-end seam coverage. Drives a tiny single-agent run through the
// MockAdapter and verifies trace events fire at expected seams: phase_enter/
// exit (with duration_ms), detector_fired (completion), version header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v08-seams-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v08-seams-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { run } = await import("../../src/runner.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { createScriptedIO } = await import("../../src/io.js");
const { readTrace } = await import("../../src/state/trace.js");

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

const BRIEF = `---
project: trace-seams-test
brief_id: 2026-05-18-traceseams
scope_locked: false
authorized_costs:
  - generation_credits
---

# Objective
Smoke a trace.

# Deliverables
- one tiny artifact

# Constraints
None.

# Tools required
Text.

# Notes / unknowns
None.
`;

const CONFIRMATION = `## Phase 0: Brief intake

**Confirmation Summary**

Objective: smoke a trace
Deliverables: one tiny artifact
Constraints: none
Tools required: text
Unknowns: none

Ready, gated or auto-pilot?
`;

const COMPLETION = `## Phase 4: Completion

Delivered: trace fired.
Unresolved: none.
Open: none.

All deliverables shipped.`;

test("end-to-end run emits header, phase enters/exits with durations, completion detector", async () => {
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([
    CONFIRMATION,
    COMPLETION,
    "Delivered: trace fired.\nUnresolved: none.\nOpen: none.",
  ]);
  const result = await run({
    briefSource: BRIEF,
    adapter,
    io,
    mode: "auto",
    // ephemeral:false so the tracer actually writes a file we can read back.
    ephemeral: false,
  });
  assert.equal(result.completed, true);

  const { events, empty } = readTrace("2026-05-18-traceseams");
  assert.equal(empty, false);
  assert.equal(events[0]!.type, "trace_version");

  const enters = events.filter((e) => e.type === "phase_enter") as Array<{ type: string; phase: string }>;
  const phases = enters.map((e) => e.phase);
  assert.ok(phases.includes("intake"));
  assert.ok(phases.includes("execute"));
  assert.ok(phases.includes("completion"));
  assert.ok(phases.includes("done"));

  const exits = events.filter((e) => e.type === "phase_exit") as Array<{ type: string; duration_ms: number }>;
  assert.ok(exits.length >= 2);
  for (const ex of exits) assert.ok(typeof ex.duration_ms === "number" && ex.duration_ms >= 0);

  const detectors = events.filter((e) => e.type === "detector_fired") as Array<{ type: string; detector: string }>;
  const names = detectors.map((d) => d.detector);
  assert.ok(names.includes("completion"), `expected completion detector; got ${names.join(",")}`);
});

test("ephemeral run writes no trace file", async () => {
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONFIRMATION, COMPLETION, "Done."]);
  const result = await run({
    briefSource: BRIEF.replace("2026-05-18-traceseams", "2026-05-18-ephemeral"),
    adapter,
    io,
    mode: "auto",
    ephemeral: true,
  });
  assert.equal(result.completed, true);
  const { empty } = readTrace("2026-05-18-ephemeral");
  assert.equal(empty, true);
});
