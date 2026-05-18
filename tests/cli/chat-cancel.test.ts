// v0.11.1: chat REPL Ctrl-C semantics.
//
// The handler itself lives inside the runChatCommand closure (it captures
// the rl + liveSession variables), so end-to-end SIGINT testing requires
// driving a real subprocess. These tests verify the behavior contract via
// the same primitive the handler uses (Session.cancelCurrentToolCall over
// a ToolCallRegistry) plus a behavioral assertion on the escalation
// window so the rule does not silently drift.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ToolCallRegistry,
  sessionFromRegistry,
} from "../../src/runtime/cancellation.js";

// Mirrors the chat REPL handler's decision tree without needing readline
// or a real SIGINT. Two state machines compose into a `decide(now)` step
// that returns the action: "cancel-tool", "escalate-close", or "close".
function makeHandler(opts: {
  hasActiveSession: () => boolean;
  cancel: () => Promise<boolean>;
  escalateMs: number;
}): (now: number) => Promise<"cancel-tool" | "escalate-close" | "close"> {
  // Sentinel `null` means "no prior cancel"; the real chat handler uses
  // Date.now() (which is enormous) so `now - firstCancelAt` is naturally
  // huge before any cancel. The mock uses an explicit null sentinel so
  // test callers can pass `now=0` without accidental escalation.
  let firstAt: number | null = null;
  return async (now: number) => {
    if (opts.hasActiveSession() && firstAt !== null && now - firstAt < opts.escalateMs) {
      firstAt = null;
      return "escalate-close";
    }
    if (opts.hasActiveSession()) {
      const fired = await opts.cancel();
      if (fired) {
        firstAt = now;
        return "cancel-tool";
      }
      return "close";
    }
    return "close";
  };
}

test("chat ctrl-c: no active run -> close", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  const handle = makeHandler({
    hasActiveSession: () => false,
    cancel: () => session.cancelCurrentToolCall(),
    escalateMs: 2000,
  });
  assert.equal(await handle(0), "close");
});

test("chat ctrl-c: active run, no in-flight tool -> close (Session.cancel returns false)", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  const handle = makeHandler({
    hasActiveSession: () => true,
    cancel: () => session.cancelCurrentToolCall(),
    escalateMs: 2000,
  });
  assert.equal(await handle(0), "close");
});

test("chat ctrl-c: active run + in-flight tool -> cancel-tool", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  r.begin("c1", "shell_exec");
  // Schedule the end-of-call so cancel() can await it.
  setTimeout(() => r.end("c1"), 20);
  const handle = makeHandler({
    hasActiveSession: () => true,
    cancel: () => session.cancelCurrentToolCall(),
    escalateMs: 2000,
  });
  assert.equal(await handle(1000), "cancel-tool");
});

test("chat ctrl-c: second press within 2s after a successful cancel escalates", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  r.begin("c1", "shell_exec");
  setTimeout(() => r.end("c1"), 20);
  const handle = makeHandler({
    hasActiveSession: () => true,
    cancel: () => session.cancelCurrentToolCall(),
    escalateMs: 2000,
  });
  // First press fires cancel.
  assert.equal(await handle(0), "cancel-tool");
  // Second press 500ms later (within 2s window) escalates to close.
  assert.equal(await handle(500), "escalate-close");
});

test("chat ctrl-c: second press AFTER 2s window starts a fresh cycle (not escalation)", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  r.begin("c1", "shell_exec");
  setTimeout(() => r.end("c1"), 20);
  const handle = makeHandler({
    hasActiveSession: () => true,
    cancel: () => session.cancelCurrentToolCall(),
    escalateMs: 2000,
  });
  assert.equal(await handle(0), "cancel-tool");
  // Wait past the window. The next call to `cancel()` will return false
  // (the tool already ended); the handler maps that to close, not escalate.
  // This pins the rule: after the window, the second press is no longer
  // an "escalate" but a fresh decision.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await handle(3000), "close");
});
