// Tests for the cli-bridge adapter. Uses tests/fixtures/mock-cli/cli.mjs
// as a synthetic CLI so the suite never depends on Claude Code, Gemini CLI,
// or any other real binary being installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CliBridgeAdapter } from "../../src/adapters/cli-bridge.js";
import { makeAdapter, resolveTier, DEFAULT_TIERS } from "../../src/adapters/index.js";
import type { StreamEvent } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = resolve(here, "..", "fixtures", "mock-cli", "cli.mjs");
const NODE = process.execPath;

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function makeBridge(extra: Record<string, unknown>): CliBridgeAdapter {
  return new CliBridgeAdapter({
    id: "cli-bridge",
    extra: { binary: NODE, args: [MOCK_CLI], ...extra },
  });
}

test("cli-bridge: assembles a successful streamed response", async () => {
  const adapter = makeBridge({ env: { MOCK_CLI_OUTPUT: "Hello world" } });
  const events = await collect(
    adapter.sendMessage({ system: "s", messages: [{ role: "user", content: "hi", at: "" }] }),
  );
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => (e as { delta: string }).delta)
    .join("");
  assert.equal(text, "Hello world");
  const done = events.find((e) => e.type === "done") as { message: string } | undefined;
  assert.ok(done, "expected a done event");
  assert.equal(done.message, "Hello world");
});

test("cli-bridge: streams multiple text_delta events when output is chunked", async () => {
  const adapter = makeBridge({
    env: { MOCK_CLI_OUTPUT: "abcde", MOCK_CLI_OUTPUT_CHUNKS: "1" },
  });
  const events = await collect(
    adapter.sendMessage({ system: "", messages: [{ role: "user", content: "x", at: "" }] }),
  );
  const deltas = events.filter((e) => e.type === "text_delta");
  // Chunked emission produces more than one delta even on Windows where
  // stdout buffering can coalesce. Assert >= 2 to be cross-platform robust.
  assert.ok(deltas.length >= 2, `expected multiple chunks, got ${deltas.length}`);
});

test("cli-bridge: non-zero exit surfaces as an error event with stderr tail", async () => {
  const adapter = makeBridge({
    env: { MOCK_CLI_EXIT_CODE: "7", MOCK_CLI_STDERR: "bad thing happened\n" },
  });
  const events = await collect(
    adapter.sendMessage({ system: "", messages: [{ role: "user", content: "x", at: "" }] }),
  );
  const err = events.find((e) => e.type === "error") as { error: Error } | undefined;
  assert.ok(err, "expected an error event");
  assert.match(err.error.message, /exit code 7/);
  assert.match(err.error.message, /bad thing happened/);
});

test("cli-bridge: timeout kills the child and emits a timeout error", async () => {
  const adapter = makeBridge({
    env: { MOCK_CLI_SLEEP_MS: "5000", MOCK_CLI_OUTPUT: "late" },
    timeout_ms: 150,
  });
  const events = await collect(
    adapter.sendMessage({ system: "", messages: [{ role: "user", content: "x", at: "" }] }),
  );
  const err = events.find((e) => e.type === "error") as { error: Error } | undefined;
  assert.ok(err, "expected a timeout error");
  assert.match(err.error.message, /timed out/);
});

test("cli-bridge: spawn failure (binary missing) surfaces as error event", async () => {
  const adapter = new CliBridgeAdapter({
    id: "cli-bridge",
    extra: { binary: "this-binary-does-not-exist-anywhere-12345" },
  });
  const events = await collect(
    adapter.sendMessage({ system: "", messages: [{ role: "user", content: "x", at: "" }] }),
  );
  const err = events.find((e) => e.type === "error") as { error: Error } | undefined;
  assert.ok(err, "expected an error event");
  // POSIX (and Windows with an extensioned binary) hits the ENOENT spawn-error
  // path and surfaces as "spawn failed". Windows with an extensionless binary
  // (v0.6.2's PATHEXT-via-shell path) instead fails through cmd.exe with a
  // non-zero exit code; the error message reports the exit code and the
  // shell's stderr. Both paths surface a clear "the binary isn't there"
  // message to the operator, which is the behaviour the test pins.
  assert.match(err.error.message, /spawn failed|exit code|not recognized|not found/i);
});

test("cli-bridge: framework_prefix true (default) puts system prompt into stdin", async () => {
  const adapter = makeBridge({ env: { MOCK_CLI_ECHO_STDIN: "1", MOCK_CLI_OUTPUT: "OK" } });
  const events = await collect(
    adapter.sendMessage({
      system: "FRAMEWORK_MARKER_XYZ",
      messages: [{ role: "user", content: "hello", at: "" }],
    }),
  );
  const done = events.find((e) => e.type === "done") as { message: string } | undefined;
  assert.ok(done?.message.includes("FRAMEWORK_MARKER_XYZ"));
  assert.ok(done?.message.includes("user:"));
  assert.ok(done?.message.includes("hello"));
});

test("cli-bridge: framework_prefix false omits the system prompt", async () => {
  const adapter = makeBridge({
    framework_prefix: false,
    env: { MOCK_CLI_ECHO_STDIN: "1", MOCK_CLI_OUTPUT: "OK" },
  });
  const events = await collect(
    adapter.sendMessage({
      system: "FRAMEWORK_MARKER_XYZ",
      messages: [{ role: "user", content: "hello", at: "" }],
    }),
  );
  const done = events.find((e) => e.type === "done") as { message: string } | undefined;
  assert.ok(done && !done.message.includes("FRAMEWORK_MARKER_XYZ"));
  assert.ok(done?.message.includes("hello"));
});

test("cli-bridge: tier defaults to 'free'", () => {
  const a = makeBridge({});
  assert.equal(a.tier, "free");
});

test("cli-bridge: tier override to 'paid' honored", () => {
  const a = makeBridge({ tier: "paid" });
  assert.equal(a.tier, "paid");
});

test("cli-bridge: missing binary throws at construction", () => {
  assert.throws(
    () => new CliBridgeAdapter({ id: "cli-bridge", extra: {} as Record<string, unknown> }),
    /requires "binary"/,
  );
});

test("makeAdapter('cli-bridge') wires through to CliBridgeAdapter", () => {
  const a = makeAdapter({ id: "cli-bridge", extra: { binary: "/some/path/claude" } });
  assert.equal(a.id, "cli-bridge");
  assert.equal(a.name, "CLI bridge (/some/path/claude)");
});

test("resolveTier(): cli-bridge default is 'free', anthropic default is 'paid'", () => {
  assert.equal(resolveTier({ id: "cli-bridge" }), "free");
  assert.equal(resolveTier({ id: "anthropic" }), "paid");
  assert.equal(DEFAULT_TIERS["cli-bridge"], "free");
  assert.equal(DEFAULT_TIERS["anthropic"], "paid");
});

test("resolveTier(): extra.tier override beats default", () => {
  assert.equal(resolveTier({ id: "anthropic", extra: { tier: "free" } }), "free");
  assert.equal(resolveTier({ id: "cli-bridge", extra: { tier: "paid" } }), "paid");
});
