// v0.6.1 regression test: cli-bridge must spawn .cmd / .bat shims on Windows.
//
// Bug history: v0.5/v0.6 hardcoded `shell: false` in spawn(). Node's
// child_process documentation calls out that .cmd and .bat files cannot be
// spawned without a shell on Windows, so every operator trying to bridge to an
// npm-installed CLI (Claude Code, Gemini CLI, aider, etc) hit
// "spawn <binary> ENOENT" even when the file existed on PATH. v0.6.1 sets
// shell to `process.platform === "win32"` so .cmd files spawn cleanly while
// POSIX runs keep the safer shell:false default.
//
// Test is Windows-only. On Linux/macOS it skips, so CI on those platforms
// stays green without running a meaningless cmd-script spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CliBridgeAdapter } from "../../src/adapters/cli-bridge.js";
import type { StreamEvent } from "../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const HELLO_CMD = resolve(here, "..", "fixtures", "mock-cli", "hello.cmd");

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

test("cli-bridge: spawns a .cmd shim on Windows without ENOENT", { skip: process.platform !== "win32" }, async () => {
  const adapter = new CliBridgeAdapter({
    id: "cli-bridge",
    extra: { binary: HELLO_CMD },
  });
  const events = await collect(
    adapter.sendMessage({ system: "", messages: [{ role: "user", content: "x", at: "" }] }),
  );
  // Surfaced behaviour we care about: no spawn error, a clean done event.
  const err = events.find((e) => e.type === "error");
  assert.equal(err, undefined, `expected no error events, got: ${JSON.stringify(err)}`);
  const done = events.find((e) => e.type === "done") as { message: string } | undefined;
  assert.ok(done, "expected a done event from the .cmd script");
  assert.match(done.message, /cmd-hello/);
});
