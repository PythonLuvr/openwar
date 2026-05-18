// v0.9.0: inspect <brief_id> --history project-scoped surface. Verifies the
// brief-scoped flag looks up the session's project slug and renders the same
// formatter the standalone `openwar history` subcommand uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_SESS = mkdtempSync(join(tmpdir(), "openwar-v09-iht-sess-"));
const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v09-iht-home-"));
process.env.OPENWAR_SESSIONS_DIR = TMP_SESS;
process.env.OPENWAR_HOME = TMP_HOME;

const { run } = await import("../../src/runner.js");
const { MockAdapter } = await import("../../src/adapters/mock.js");
const { createScriptedIO } = await import("../../src/io.js");
const { main } = await import("../../src/cli.js");

test.after(() => {
  rmSync(TMP_SESS, { recursive: true, force: true });
  rmSync(TMP_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_SESSIONS_DIR;
  delete process.env.OPENWAR_HOME;
});

const BRIEF = (id: string, project: string) => `---
project: ${project}
brief_id: ${id}
scope_locked: false
authorized_costs:
  - generation_credits
---

# Objective
Smoke.

# Deliverables
- one

# Constraints
None.

# Tools required
Text.

# Notes / unknowns
None.
`;

const CONF = `## Phase 0: Brief intake

**Confirmation Summary**

Objective: smoke
Deliverables: one
Constraints: none
Tools required: text
Unknowns: none

Ready, gated or auto-pilot?
`;
const COMP = `## Phase 4: Completion

Delivered: x.
Unresolved: none.
Open: none.

All deliverables shipped.`;

async function seedRun(id: string, project: string): Promise<void> {
  const io = createScriptedIO({ inputs: ["go"] });
  const adapter = new MockAdapter([CONF, COMP, "Final."]);
  await run({ briefSource: BRIEF(id, project), adapter, io, mode: "auto", ephemeral: false });
}

test("inspect --history: looks up the brief's project slug and renders the project history", async () => {
  await seedRun("2026-05-18-ih1", "ih-test");
  await seedRun("2026-05-18-ih2", "ih-test");

  // Capture stdout via a write-spy.
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(["inspect", "2026-05-18-ih1", "--history"]);
    assert.equal(code, 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(captured, /slug:\s+ih-test/);
  assert.match(captured, /sample_size:\s+2/);
  assert.match(captured, /2026-05-18-ih1/);
  assert.match(captured, /2026-05-18-ih2/);
});

test("inspect --history: errors cleanly when brief_id has no session", async () => {
  const originalErr = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(["inspect", "2026-05-18-no-such", "--history"]);
    assert.equal(code, 1);
  } finally {
    process.stderr.write = originalErr;
  }
  assert.match(stderr, /no session found/);
});
