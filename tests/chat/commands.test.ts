// v0.10.0 slash commands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, slugify, HELP_TEXT, COMMAND_NAMES } from "../../src/chat/commands.js";

test("parseCommand: returns null for plain user text", () => {
  assert.equal(parseCommand("add testimonials to the page"), null);
  assert.equal(parseCommand("  not a command"), null);
});

test("parseCommand: recognizes each known command", () => {
  for (const name of COMMAND_NAMES) {
    const r = parseCommand(name);
    assert.ok(r);
    assert.equal(r!.name, name);
    assert.equal(r!.isCommand, true);
  }
});

test("parseCommand: case-insensitive on command name", () => {
  const r = parseCommand("/HELP");
  assert.equal(r!.name, "/help");
});

test("parseCommand: captures trailing args", () => {
  const r = parseCommand("/save my-brief-name");
  assert.equal(r!.name, "/save");
  assert.deepEqual(r!.args, ["my-brief-name"]);
});

test("parseCommand: /resume captures chat_id arg", () => {
  const r = parseCommand("/resume chat-abc-1234");
  assert.equal(r!.name, "/resume");
  assert.deepEqual(r!.args, ["chat-abc-1234"]);
});

test("parseCommand: unknown /command (single word) routes to /help with sentinel arg", () => {
  const r = parseCommand("/notarealcommand");
  assert.equal(r!.name, "/help");
  assert.match(r!.args[0]!, /unknown: \/notarealcommand/);
});

test("parseCommand: paths like /index.html are NOT slash commands (treated as text)", () => {
  assert.equal(parseCommand("/index.html"), null);
  assert.equal(parseCommand("/usr/local/bin"), null);
  assert.equal(parseCommand("/path/to/file mid-page three placeholders"), null);
  assert.equal(parseCommand("/index.html, mid-page"), null);
});

test("HELP_TEXT lists every shipped command", () => {
  for (const name of COMMAND_NAMES) {
    assert.match(HELP_TEXT, new RegExp(name.replace("/", "\\/")));
  }
});

test("HELP_TEXT closing sentence reassures non-devs that commands are optional", () => {
  assert.match(HELP_TEXT, /You don't need any of these/);
});

test("slugify: alphanumeric + dash output, max 40 chars", () => {
  assert.equal(slugify("Add testimonials"), "add-testimonials");
  assert.equal(slugify("Build a NEW landing page!"), "build-a-new-landing-page");
  const long = slugify("This is an extremely long deliverable that should be truncated to forty characters");
  assert.ok(long.length <= 40, `slug too long: ${long.length}`);
});

test("slugify: empty/punctuation-only input falls back to chat-brief", () => {
  assert.equal(slugify(""), "chat-brief");
  assert.equal(slugify("!!!"), "chat-brief");
});

test("slugify: no leading/trailing dashes", () => {
  const s = slugify("---weird input---");
  assert.equal(s.startsWith("-"), false);
  assert.equal(s.endsWith("-"), false);
});
