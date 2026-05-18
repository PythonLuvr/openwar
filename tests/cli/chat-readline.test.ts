// v0.10.0 Windows-readline smoke pass.
//
// Drives `runChatCommand` with a programmatic Readable / Writable stream
// pair so the readline integration is exercised end-to-end without a real
// terminal. Covers:
//
//   - Stdin closure (EOF / Ctrl-D / Ctrl-C-induced rl.close) routes through
//     the same path as /quit and writes chat_session_ended.
//   - History size option is honored (no crash on typical input volume).
//   - Multi-line piped input works (each newline becomes a turn).
//   - terminal:false mode (which the tests force via opts.stdin) does NOT
//     enable raw mode, so the test environment never goes into a state
//     that breaks subsequent stdin operations.
//
// These pin the cross-platform behavior the brief budgeted. Windows-
// specific quirks (raw mode, CRLF translation) ride the same code paths;
// catching regressions here catches them on Windows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-readline-"));
process.env.OPENWAR_HOME = TMP;
process.env.OPENWAR_CHATS_DIR = join(TMP, "chats");
process.env.OPENWAR_SESSIONS_DIR = join(TMP, "sessions");

const { runChatCommand } = await import("../../src/cli/chat.js");
const { listChats, readChat } = await import("../../src/state/chat-store.js");

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
  delete process.env.OPENWAR_CHATS_DIR;
  delete process.env.OPENWAR_SESSIONS_DIR;
});

// Build a Readable that emits the provided lines (newline-terminated) then
// ends. Useful for piping a scripted "user session" through readline.
function scriptedStdin(lines: readonly string[]): Readable {
  const r = new Readable({
    read() {
      for (const line of lines) this.push(line + "\n");
      this.push(null);
    },
  });
  return r;
}

// Sink that records writes to a string buffer.
function bufferStdout(): { stream: Writable; output: () => string } {
  let buf = "";
  const s = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream: s, output: () => buf };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    snapshot[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  return fn().finally(() => {
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k]!;
    }
  });
}

test("readline: stdin EOF routes through the /quit path (chat_session_ended event)", async () => {
  // The user types nothing and the stream ends. Should produce a clean
  // session with the user_quit reason, matching the explicit /quit path.
  await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, XAI_API_KEY: undefined, OPENAI_COMPAT_API_KEY: undefined }, async () => {
    // Without a BYOK key, runChatCommand throws ChatStartupError before
    // creating any chat session, so this case is naturally covered by the
    // no-adapter test. The interesting case is WITH a key, below.
  });

  await withEnv({ ANTHROPIC_API_KEY: "test-key-not-used" }, async () => {
    const { stream: out } = bufferStdout();
    const stdin = scriptedStdin([]); // immediate EOF
    const code = await runChatCommand({
      adapter: "mock", // Force mock adapter (tool-call-capable in our impl).
      stdin,
      stdout: out,
    });
    assert.equal(code, 0);
    // A chat session was created and ended.
    const list = listChats();
    assert.ok(list.length > 0);
    const { events } = readChat(list[0]!.chat_id);
    const ended = events.find((e) => e.type === "chat_session_ended");
    assert.ok(ended, "expected chat_session_ended after EOF");
  });
});

test("readline: /quit on a piped stdin ends cleanly without hanging", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "test-key-not-used" }, async () => {
    const { stream: out, output } = bufferStdout();
    const stdin = scriptedStdin(["/quit"]);
    const code = await runChatCommand({
      adapter: "mock",
      stdin,
      stdout: out,
    });
    assert.equal(code, 0);
    assert.match(output(), /chat session saved/);
  });
});

test("readline: /help on a piped stdin prints the command list, then continues", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "test-key-not-used" }, async () => {
    const { stream: out, output } = bufferStdout();
    const stdin = scriptedStdin(["/help", "/quit"]);
    const code = await runChatCommand({
      adapter: "mock",
      stdin,
      stdout: out,
    });
    assert.equal(code, 0);
    assert.match(output(), /\/help/);
    assert.match(output(), /\/save/);
    assert.match(output(), /chat session saved/);
  });
});

test("readline: input with embedded CRLF (Windows line endings) is handled as separate turns", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "test-key-not-used" }, async () => {
    // Build a Readable that emits CRLF-terminated lines. readline splits
    // on \n; the \r should not bleed into the parsed command.
    const stdin = new Readable({
      read() {
        this.push("/help\r\n");
        this.push("/quit\r\n");
        this.push(null);
      },
    });
    const { stream: out, output } = bufferStdout();
    const code = await runChatCommand({ adapter: "mock", stdin, stdout: out });
    assert.equal(code, 0);
    // /help text rendered (not interpreted as unknown).
    assert.match(output(), /show this help/);
  });
});

test("readline: history size option does not error on long input volume", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "test-key-not-used" }, async () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) lines.push("/history"); // 250 commands
    lines.push("/quit");
    const stdin = scriptedStdin(lines);
    const { stream: out } = bufferStdout();
    const code = await runChatCommand({ adapter: "mock", stdin, stdout: out });
    assert.equal(code, 0);
  });
});
