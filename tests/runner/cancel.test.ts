// v0.11.1: Session.cancelCurrentToolCall + ToolCallRegistry behavior
// + raceWithCancellation (the MCP-grace primitive).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ToolCallRegistry,
  sessionFromRegistry,
  raceWithCancellation,
} from "../../src/runtime/cancellation.js";

test("Session.cancelCurrentToolCall returns false when no tool call is active", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  const fired = await session.cancelCurrentToolCall();
  assert.equal(fired, false);
});

test("Session.cancelCurrentToolCall returns true while a call is registered, fires the AbortSignal, and awaits exit", async () => {
  const r = new ToolCallRegistry();
  const session = sessionFromRegistry(r);
  const ac = r.begin("call_1", "shell_exec");

  let aborted = false;
  ac.signal.addEventListener("abort", () => { aborted = true; });

  // Cancellation completes once end() resolves the done promise. Schedule
  // end() shortly after we fire the cancel so we exercise the await path.
  setTimeout(() => r.end("call_1"), 50);

  const fired = await session.cancelCurrentToolCall();
  assert.equal(fired, true);
  assert.equal(aborted, true, "AbortController should have fired");
  // After end(), no call should be active.
  assert.equal(r.hasActive(), false);
});

test("ToolCallRegistry rejects concurrent begin() calls", () => {
  const r = new ToolCallRegistry();
  r.begin("a", "shell_exec");
  assert.throws(() => r.begin("b", "http_fetch"), /does not support concurrent/);
});

test("ToolCallRegistry.end is idempotent and ignores wrong call_ids", () => {
  const r = new ToolCallRegistry();
  r.begin("a", "shell_exec");
  r.end("wrong-id"); // no-op
  assert.equal(r.activeCallId(), "a");
  r.end("a");
  assert.equal(r.hasActive(), false);
  // Calling end again after the slot is empty is also safe.
  r.end("a");
  assert.equal(r.hasActive(), false);
});

test("ToolCallRegistry emits ToolCancellation payload to the bound emitter", () => {
  const received: unknown[] = [];
  const r = new ToolCallRegistry({ emit: (p) => received.push(p) });
  r.emit({
    call_id: "c1",
    tool_name: "shell_exec",
    cancellation_source: "operator_signal",
    partial_output: "hi",
    at: "2026-05-19T00:00:00Z",
  });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    call_id: "c1",
    tool_name: "shell_exec",
    cancellation_source: "operator_signal",
    partial_output: "hi",
    at: "2026-05-19T00:00:00Z",
  });
});

test("raceWithCancellation: returns the real result if promise settles before signal aborts", async () => {
  const ac = new AbortController();
  const winner = await raceWithCancellation<number>(
    Promise.resolve(42),
    ac.signal,
    1000,
    () => -1,
  );
  assert.equal(winner, 42);
});

test("raceWithCancellation: returns the synthesized value if grace expires after abort", async () => {
  const ac = new AbortController();
  // Promise that never resolves on its own.
  const never = new Promise<number>(() => { /* never */ });
  setTimeout(() => ac.abort(), 10);
  const winner = await raceWithCancellation<number>(never, ac.signal, 50, () => -99);
  assert.equal(winner, -99);
});

test("raceWithCancellation: still returns the real result if the promise wins the grace race", async () => {
  const ac = new AbortController();
  const slow = new Promise<number>((res) => setTimeout(() => res(7), 30));
  setTimeout(() => ac.abort(), 10);
  // Grace longer than the slow promise so the real result wins.
  const winner = await raceWithCancellation<number>(slow, ac.signal, 200, () => -99);
  assert.equal(winner, 7);
});

test("raceWithCancellation: undefined signal short-circuits to the promise", async () => {
  const winner = await raceWithCancellation<string>(
    Promise.resolve("ok"),
    undefined,
    1000,
    () => "synth",
  );
  assert.equal(winner, "ok");
});

test("raceWithCancellation: already-aborted signal synthesizes immediately", async () => {
  const ac = new AbortController();
  ac.abort();
  const never = new Promise<number>(() => { /* never */ });
  const winner = await raceWithCancellation<number>(never, ac.signal, 5000, () => 1234);
  assert.equal(winner, 1234);
});
