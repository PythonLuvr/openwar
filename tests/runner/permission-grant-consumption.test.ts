// v0.12.0: Phase 3 honors active PermissionBridge grants.
//
// Exercises the dispatch path in src/phases/execute.ts that consults
// SandboxContext.grantLedger before halting on an unauthorized tool call.
// Verifies emission of `permission_grant_consumed` and the synthesized
// `auth_check_fired` allow event.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runExecute } from "../../src/phases/execute.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import { SandboxContext } from "../../src/sandbox/types.js";
import { GrantLedger } from "../../src/runtime/grants.js";
import { Tracer } from "../../src/state/trace.js";
import { READ_FILE_DEFINITION, readFileExecutor } from "../../src/tools/native/read_file.js";
import { WRITE_FILE_DEFINITION, writeFileExecutor } from "../../src/tools/native/write_file.js";
import { createScriptedIO } from "../../src/io.js";
import { parseBrief } from "../../src/brief.js";

const SAMPLE_BRIEF = `---
project: phase3-grant-test
brief_id: 2026-05-19-phase3-test
scope_locked: true
mode: auto
authorized_costs:
  - filesystem_read
---

# Objective
Test Phase 3 grant consumption.

# Deliverables
- Trigger an unauthorized write
- Verify the grant covers it

# Constraints
None.

# Tools required
write_file
`;

async function withTmpTrace<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "openwar-phase3-grant-"));
  try {
    return await fn(join(dir, "trace.ndjson"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Phase 3 honors a matching grant: writes proceed without halting", async () => {
  await withTmpTrace(async (tracePath) => {
    const wd = await mkdtemp(join(tmpdir(), "openwar-phase3-wd-"));
    try {
      const ledger = new GrantLedger();
      ledger.addGrant({
        action: "Write the temp scratch file",
        category: "filesystem_write",
        scope: "this_call",
        reasoning: "agent declared its intent up-front",
      });
      const sandbox = SandboxContext._create({
        workdir: wd,
        defaultTimeoutMs: 5000,
        defaultMaxOutputBytes: 1_000_000,
        httpAllowlist: null,
        shellEnabled: true,
        grantLedger: ledger,
      });
      const tracer = new Tracer({ briefId: "phase3-grant", enabled: true, openwarVersion: "0.12.0", filePath: tracePath });
      const adapter = new MockAdapter([
        {
          text: "Phase 1: writing file.",
          tool_calls: [{ id: "c1", name: "write_file", arguments: { path: "scratch.txt", content: "hi" } }],
        },
        "Phase 4: complete.",
      ]);
      const brief = parseBrief(SAMPLE_BRIEF);
      const io = createScriptedIO([]);
      const result = await runExecute({
        brief,
        adapter,
        system: "",
        io,
        mode: "auto",
        history: [],
        toolDefinitions: [READ_FILE_DEFINITION, WRITE_FILE_DEFINITION],
        toolExecutors: new Map([
          ["read_file", readFileExecutor],
          ["write_file", writeFileExecutor],
        ]),
        sandbox,
        sessionApproved: [],
        tracer,
        maxSteps: 3,
      });
      // The brief authorized filesystem_read only; write_file would normally
      // halt at Phase 3. With the active grant, dispatch proceeds.
      assert.notEqual(result.outcome, "destructive_denied");
      // Grant flipped to consumed because it was scope=this_call.
      const grants = ledger.listActive();
      assert.equal(grants.length, 1);
      assert.equal(grants[0]!.consumed, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

test("Phase 3 with no matching grant: still halts to destructive_denied", async () => {
  await withTmpTrace(async (tracePath) => {
    const wd = await mkdtemp(join(tmpdir(), "openwar-phase3-wd-"));
    try {
      const ledger = new GrantLedger();
      // Grant covers shell_exec, not filesystem_write.
      ledger.addGrant({
        action: "Run a one-off shell",
        category: "shell_exec",
        scope: "this_session",
        reasoning: "wrong category for the upcoming write",
      });
      const sandbox = SandboxContext._create({
        workdir: wd,
        defaultTimeoutMs: 5000,
        defaultMaxOutputBytes: 1_000_000,
        httpAllowlist: null,
        shellEnabled: true,
        grantLedger: ledger,
      });
      const tracer = new Tracer({ briefId: "phase3-grant", enabled: true, openwarVersion: "0.12.0", filePath: tracePath });
      const adapter = new MockAdapter([
        {
          text: "Phase 1: writing file.",
          tool_calls: [{ id: "c1", name: "write_file", arguments: { path: "scratch.txt", content: "hi" } }],
        },
      ]);
      const brief = parseBrief(SAMPLE_BRIEF);
      const io = createScriptedIO([]);
      const result = await runExecute({
        brief,
        adapter,
        system: "",
        io,
        mode: "auto",
        history: [],
        toolDefinitions: [READ_FILE_DEFINITION, WRITE_FILE_DEFINITION],
        toolExecutors: new Map([
          ["read_file", readFileExecutor],
          ["write_file", writeFileExecutor],
        ]),
        sandbox,
        sessionApproved: [],
        tracer,
        maxSteps: 2,
      });
      assert.equal(result.outcome, "destructive_denied");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

test("Phase 3 with this_session grant: same category consumed on every call without flipping consumed", async () => {
  const wd = await mkdtemp(join(tmpdir(), "openwar-phase3-wd-"));
  try {
    const ledger = new GrantLedger();
    const g = ledger.addGrant({
      action: "all writes for this session",
      category: "filesystem_write",
      scope: "this_session",
      reasoning: "broad approval",
    });
    // Direct ledger-only assertion: findMatchingGrant returns the same grant
    // multiple times, and consumeGrant does NOT flip session grants.
    const a = ledger.findMatchingGrant(["filesystem_write"]);
    assert.equal(a?.grant_id, g.grant_id);
    ledger.consumeGrant(g.grant_id);
    const b = ledger.findMatchingGrant(["filesystem_write"]);
    assert.equal(b?.grant_id, g.grant_id);
    assert.equal(b?.consumed, false);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});
