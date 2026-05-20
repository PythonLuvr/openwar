// v0.12.0: request_permission native tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freshWorkdir, cleanupWorkdir, makeCall } from "./helpers.js";
import { SandboxContext } from "../../src/sandbox/types.js";
import {
  requestPermissionExecutor,
  REQUEST_PERMISSION_DEFINITION,
  parseOperatorReply,
  renderPermissionPrompt,
} from "../../src/tools/native/request_permission.js";
import { GrantLedger } from "../../src/runtime/grants.js";

interface ScriptedIO {
  write: (s: string) => void;
  prompt: (q: string) => Promise<string>;
  banner: (s: string) => void;
  warn: (s: string) => void;
  confirm: (q: string) => Promise<boolean>;
}

function scriptedIO(reply: string): { io: ScriptedIO; writes: string[] } {
  const writes: string[] = [];
  return {
    io: {
      write: (s) => { writes.push(s); },
      prompt: async () => reply,
      banner: () => {},
      warn: () => {},
      confirm: async () => false,
    },
    writes,
  };
}

function makeCtxWith(workdir: string, ledger: GrantLedger | null, io: ScriptedIO | null): SandboxContext {
  const fields: Parameters<typeof SandboxContext._create>[0] = {
    workdir,
    defaultTimeoutMs: 5000,
    defaultMaxOutputBytes: 1_000_000,
    httpAllowlist: null,
    shellEnabled: true,
  };
  if (ledger) fields.grantLedger = ledger;
  if (io) fields.io = io;
  return SandboxContext._create(fields);
}

// ---- Tool definition shape ----

test("REQUEST_PERMISSION_DEFINITION has empty authorization_categories (default-allowed)", () => {
  assert.deepEqual(REQUEST_PERMISSION_DEFINITION.authorization_categories, []);
  assert.equal(REQUEST_PERMISSION_DEFINITION.name, "request_permission");
  assert.equal(REQUEST_PERMISSION_DEFINITION.origin, "native");
});

// ---- parseOperatorReply ----

test("parseOperatorReply: empty / y / yes -> approve at requested scope", () => {
  assert.deepEqual(parseOperatorReply("", "this_call"), { granted: true, scope_granted: "this_call", operator_note: "" });
  assert.deepEqual(parseOperatorReply("y", "this_call"), { granted: true, scope_granted: "this_call", operator_note: "" });
  assert.deepEqual(parseOperatorReply("YES", "persistent"), { granted: true, scope_granted: "persistent", operator_note: "" });
});

test("parseOperatorReply: s / p escalate scope on approval", () => {
  assert.equal(parseOperatorReply("s", "this_call").scope_granted, "this_session");
  assert.equal(parseOperatorReply("p", "this_call").scope_granted, "persistent");
});

test("parseOperatorReply: n / no -> deny with empty note", () => {
  assert.deepEqual(parseOperatorReply("n", "this_call"), { granted: false, scope_granted: null, operator_note: "" });
  assert.deepEqual(parseOperatorReply("NO", "this_call"), { granted: false, scope_granted: null, operator_note: "" });
});

test("parseOperatorReply: n: <note> -> deny with note", () => {
  const r = parseOperatorReply("n: not this file please", "this_call");
  assert.equal(r.granted, false);
  assert.equal(r.operator_note, "not this file please");
});

test("parseOperatorReply: unknown response -> deny with raw text in note", () => {
  const r = parseOperatorReply("maybe later", "this_call");
  assert.equal(r.granted, false);
  assert.match(r.operator_note, /unrecognized response: maybe later/);
});

// ---- renderPermissionPrompt ----

test("renderPermissionPrompt: includes action / reason / scope / approval menu", () => {
  const out = renderPermissionPrompt({
    action: "Delete src/legacy.ts",
    scope: "this_call",
    reasoning: "unreferenced",
    fallback: null,
    category: null,
  });
  assert.match(out, /Permission request from agent:/);
  assert.match(out, /ACTION    Delete src\/legacy\.ts/);
  assert.match(out, /REASON    unreferenced/);
  assert.match(out, /REQUESTED SCOPE  this_call/);
  assert.match(out, /Approve at what scope\?/);
  assert.match(out, /n: <msg>/);
});

test("renderPermissionPrompt: omits FALLBACK line when not supplied", () => {
  const out = renderPermissionPrompt({
    action: "x", scope: "this_call", reasoning: "y", fallback: null, category: null,
  });
  assert.doesNotMatch(out, /FALLBACK/);
});

// ---- Executor end-to-end ----

test("request_permission executor: no ledger -> structured NO_LEDGER failure", async () => {
  const wd = await freshWorkdir();
  try {
    const ctx = makeCtxWith(wd, null, null);
    const res = await requestPermissionExecutor(
      makeCall("request_permission", { action: "x", reasoning: "y" }),
      ctx,
    );
    assert.equal(res.success, false);
    assert.equal(res.error?.code, "NO_LEDGER");
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("request_permission executor: no io (headless) -> denies with no-operator note", async () => {
  const wd = await freshWorkdir();
  try {
    const ledger = new GrantLedger();
    const ctx = makeCtxWith(wd, ledger, null);
    const res = await requestPermissionExecutor(
      makeCall("request_permission", { action: "Delete x", reasoning: "y" }),
      ctx,
    );
    assert.equal(res.success, true);
    const body = JSON.parse(res.content);
    assert.equal(body.granted, false);
    assert.match(body.operator_note, /no interactive operator available/);
    // No grant registered on denial.
    assert.equal(ledger.listActive().length, 0);
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("request_permission executor: operator approves -> grant registered, scope honored", async () => {
  const wd = await freshWorkdir();
  try {
    const ledger = new GrantLedger();
    const { io } = scriptedIO("y");
    const ctx = makeCtxWith(wd, ledger, io);
    const res = await requestPermissionExecutor(
      makeCall("request_permission", {
        action: "Delete src/legacy.ts",
        reasoning: "unreferenced",
        scope: "this_session",
        category: "filesystem_write",
      }),
      ctx,
    );
    assert.equal(res.success, true);
    const body = JSON.parse(res.content);
    assert.equal(body.granted, true);
    assert.equal(body.scope_granted, "this_session");
    assert.equal(typeof body.grant_id, "string");
    const active = ledger.listActive();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.category, "filesystem_write");
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("request_permission executor: operator types s to escalate scope -> session-grant registered even though this_call requested", async () => {
  const wd = await freshWorkdir();
  try {
    const ledger = new GrantLedger();
    const { io } = scriptedIO("s");
    const ctx = makeCtxWith(wd, ledger, io);
    const res = await requestPermissionExecutor(
      makeCall("request_permission", {
        action: "x", reasoning: "y", scope: "this_call",
      }),
      ctx,
    );
    const body = JSON.parse(res.content);
    assert.equal(body.granted, true);
    assert.equal(body.scope_granted, "this_session");
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("request_permission executor: operator types n: with note -> denial carries note", async () => {
  const wd = await freshWorkdir();
  try {
    const ledger = new GrantLedger();
    const { io } = scriptedIO("n: not safe");
    const ctx = makeCtxWith(wd, ledger, io);
    const res = await requestPermissionExecutor(
      makeCall("request_permission", { action: "x", reasoning: "y" }),
      ctx,
    );
    const body = JSON.parse(res.content);
    assert.equal(body.granted, false);
    assert.equal(body.operator_note, "not safe");
  } finally {
    await cleanupWorkdir(wd);
  }
});

test("request_permission executor: invalid args -> INVALID_ARGS failure", async () => {
  const wd = await freshWorkdir();
  try {
    const ledger = new GrantLedger();
    const ctx = makeCtxWith(wd, ledger, null);
    const res = await requestPermissionExecutor(
      makeCall("request_permission", { reasoning: "y" }), // missing action
      ctx,
    );
    assert.equal(res.success, false);
    assert.equal(res.error?.code, "INVALID_ARGS");
  } finally {
    await cleanupWorkdir(wd);
  }
});

// Touch unused imports.
void mkdtemp; void tmpdir; void rm; void join;
