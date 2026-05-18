// v0.10.0 chat store: append-only NDJSON, schema-version anchored, resume-
// safe. Same shape as v0.8 trace; same invariants.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "openwar-v10-chatstore-"));
process.env.OPENWAR_CHATS_DIR = TMP;
process.env.OPENWAR_CHAT_STRICT = "1";

const {
  ChatStore,
  CHAT_SCHEMA_VERSION,
  ChatStoreSchemaError,
  readChat,
  readChatFromPath,
  listChats,
  mostRecentChatId,
  newChatId,
  nullChatStore,
} = await import("../../src/state/chat-store.js");
const { chatFile } = await import("../../src/state/paths.js");

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.OPENWAR_CHATS_DIR;
  delete process.env.OPENWAR_CHAT_STRICT;
});

function mkStore(chatId: string, enabled = true) {
  return new ChatStore({
    chatId,
    enabled,
    openwarVersion: "0.10.0",
    agentAdapter: "anthropic",
    agentModel: "claude-3-5-sonnet-latest",
    execAdapter: "cli-bridge",
    execModel: "claude",
    projectSlug: "demo",
  });
}

test("newChatId: matches chat-<base36>-<hex> shape", () => {
  for (let i = 0; i < 5; i++) {
    const id = newChatId();
    assert.match(id, /^chat-[a-z0-9]+-[a-f0-9]{8}$/);
  }
});

test("ChatStore: header written on first construction (when file absent)", () => {
  const id = newChatId();
  mkStore(id);
  const path = chatFile(id);
  assert.ok(existsSync(path));
  const raw = readFileSync(path, "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  const header = JSON.parse(lines[0]!);
  assert.equal(header.type, "chat_session_started");
  assert.equal(header.schema_version, CHAT_SCHEMA_VERSION);
  assert.equal(header.agent_adapter, "anthropic");
  assert.equal(header.exec_adapter, "cli-bridge");
  assert.equal(header.project_slug, "demo");
});

test("ChatStore: enabled=false writes nothing", () => {
  const id = newChatId();
  mkStore(id, false);
  assert.equal(existsSync(chatFile(id)), false);
});

test("nullChatStore returns a disabled store; emit is a no-op", () => {
  const s = nullChatStore();
  assert.equal(s.enabled, false);
  assert.doesNotThrow(() => s.append({ type: "user_turn", at: "t", content: "x" }));
});

test("ChatStore: append events round-trip through readChat in order", () => {
  const id = newChatId();
  const store = mkStore(id);
  store.append({ type: "user_turn", at: "t1", content: "hello" });
  store.append({ type: "agent_turn", at: "t2", content: "", intent: "ask_clarification" });
  const { events, corrupted_lines } = readChat(id);
  assert.equal(corrupted_lines.length, 0);
  assert.equal(events.length, 3); // header + 2 events
  assert.equal(events[0]!.type, "chat_session_started");
  assert.equal(events[1]!.type, "user_turn");
  assert.equal(events[2]!.type, "agent_turn");
});

test("readChat: missing file raises PARSE error", () => {
  const id = "chat-never-existed";
  assert.throws(
    () => readChat(id),
    (err: unknown) => err instanceof ChatStoreSchemaError && (err as InstanceType<typeof ChatStoreSchemaError>).code === "PARSE",
  );
});

test("readChat: empty file raises MISSING_HEADER", () => {
  const id = newChatId();
  const path = chatFile(id);
  // Write an empty file directly (bypass the store so no header lands).
  writeFileSync(path, "", "utf8");
  assert.throws(
    () => readChat(id),
    (err: unknown) => err instanceof ChatStoreSchemaError && (err as InstanceType<typeof ChatStoreSchemaError>).code === "MISSING_HEADER",
  );
});

test("readChat: first line not a header event raises MISSING_HEADER", () => {
  const id = newChatId();
  const path = chatFile(id);
  writeFileSync(path, JSON.stringify({ type: "user_turn", at: "t", content: "x" }) + "\n", "utf8");
  assert.throws(
    () => readChat(id),
    (err: unknown) => err instanceof ChatStoreSchemaError && (err as InstanceType<typeof ChatStoreSchemaError>).code === "MISSING_HEADER",
  );
});

test("readChat: schema_version mismatch raises VERSION_MISMATCH with remediation", () => {
  const id = newChatId();
  const path = chatFile(id);
  const fakeHeader = {
    type: "chat_session_started",
    chat_id: id,
    schema_version: 999,
    started_at: "t",
    openwar_version: "0.10.0",
    agent_adapter: "anthropic",
    agent_model: "x",
    exec_adapter: "anthropic",
    exec_model: "x",
    project_slug: null,
  };
  writeFileSync(path, JSON.stringify(fakeHeader) + "\n", "utf8");
  assert.throws(
    () => readChat(id),
    (err: unknown) => {
      assert.ok(err instanceof ChatStoreSchemaError);
      assert.equal((err as InstanceType<typeof ChatStoreSchemaError>).code, "VERSION_MISMATCH");
      assert.match((err as Error).message, /schema_version=999/);
      return true;
    },
  );
});

test("readChat: corrupted middle line is tolerated and reported", () => {
  const id = newChatId();
  const store = mkStore(id);
  store.append({ type: "user_turn", at: "t1", content: "hello" });
  // Manually append a corrupted line.
  const path = chatFile(id);
  const raw = readFileSync(path, "utf8");
  writeFileSync(path, raw + "{ not json\n" + JSON.stringify({ type: "user_turn", at: "t3", content: "later" }) + "\n", "utf8");
  const { events, corrupted_lines } = readChat(id);
  assert.equal(corrupted_lines.length, 1);
  assert.equal(events.length, 3); // header + 2 valid user_turns
});

test("listChats / mostRecentChatId: sorted by mtime descending", async () => {
  // Wipe state to make ordering deterministic.
  rmSync(TMP, { recursive: true, force: true });
  // OPENWAR_CHATS_DIR is still set; the mkdir on first store recreates the dir.

  const ids = ["chat-a-aaaa", "chat-b-bbbb", "chat-c-cccc"];
  for (const id of ids) {
    mkStore(id);
    // Sleep tiny bit so mtimes differ even on coarse-resolution filesystems.
    await new Promise((r) => setTimeout(r, 10));
  }
  const list = listChats();
  // Last-written should be first in the list.
  assert.equal(list.length, 3);
  assert.equal(list[0]!.chat_id, "chat-c-cccc");
  assert.equal(mostRecentChatId(), "chat-c-cccc");
});

test("readChatFromPath: explicit path round-trip", () => {
  const id = newChatId();
  const store = mkStore(id);
  store.append({ type: "user_turn", at: "t", content: "x" });
  const { events } = readChatFromPath(chatFile(id));
  assert.ok(events.length >= 2);
});
