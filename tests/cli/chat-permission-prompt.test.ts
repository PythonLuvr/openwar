// v0.12.0: chat REPL permission-prompt format + slash command shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseOperatorReply,
  renderPermissionPrompt,
} from "../../src/tools/native/request_permission.js";
import { parseCommand, HELP_TEXT, COMMAND_NAMES } from "../../src/chat/commands.js";

test("/grants and /revoke are registered slash commands", () => {
  assert.ok((COMMAND_NAMES as readonly string[]).includes("/grants"));
  assert.ok((COMMAND_NAMES as readonly string[]).includes("/revoke"));
});

test("parseCommand: /grants -> { name: '/grants', args: [] }", () => {
  const c = parseCommand("/grants");
  assert.equal(c?.name, "/grants");
  assert.deepEqual(c?.args, []);
});

test("parseCommand: /revoke <id> -> { name: '/revoke', args: [id] }", () => {
  const c = parseCommand("/revoke 12345-abcd");
  assert.equal(c?.name, "/revoke");
  assert.deepEqual(c?.args, ["12345-abcd"]);
});

test("HELP_TEXT documents /grants and /revoke", () => {
  assert.match(HELP_TEXT, /\/grants/);
  assert.match(HELP_TEXT, /\/revoke/);
});

test("prompt format B: multi-line shape with REQUESTED SCOPE + scope options", () => {
  const prompt = renderPermissionPrompt({
    action: "Delete src/legacy.ts",
    reasoning: "unreferenced before refactor",
    fallback: "skip cleanup",
    scope: "this_call",
    category: "filesystem_write",
  });
  // Header
  assert.match(prompt, /Permission request from agent:/);
  // Fields appear in column-aligned ALL CAPS form
  assert.match(prompt, /ACTION    Delete src\/legacy\.ts/);
  assert.match(prompt, /REASON    unreferenced before refactor/);
  assert.match(prompt, /FALLBACK  skip cleanup/);
  assert.match(prompt, /CATEGORY  filesystem_write/);
  assert.match(prompt, /REQUESTED SCOPE  this_call/);
  // Approval menu with all four key forms
  assert.match(prompt, /y         grant at requested scope/);
  assert.match(prompt, /s         grant for the rest of this session/);
  assert.match(prompt, /p         grant persistently/);
  assert.match(prompt, /n         deny/);
  assert.match(prompt, /n: <msg>  deny with a note/);
});

test("parseOperatorReply: round-trip through every documented response key", () => {
  // Match the documented surface; if any of these drift the docs are wrong.
  assert.equal(parseOperatorReply("y", "this_call").granted, true);
  assert.equal(parseOperatorReply("s", "this_call").scope_granted, "this_session");
  assert.equal(parseOperatorReply("p", "this_call").scope_granted, "persistent");
  assert.equal(parseOperatorReply("n", "this_call").granted, false);
  assert.equal(parseOperatorReply("n: <reason text>", "this_call").operator_note, "<reason text>");
});
