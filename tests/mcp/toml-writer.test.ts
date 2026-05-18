// v0.7.1: tests for the scoped TOML serializer. Verifies every escape
// in the TOML 1.0 basic-string spec, dotted section headers, string
// arrays, the upsert helper, and the canonical MCP config shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeTomlConfig,
  escapeBasicString,
  upsertTomlSection,
  type TomlConfig,
} from "../../src/mcp/toml-writer.js";

test("toml: simple section with two string fields", () => {
  const out = writeTomlConfig({
    sections: [{
      header: "mcp_servers.openwar",
      fields: [
        { key: "command", value: "node" },
        { key: "args", value: ["openwar", "mcp-serve"] },
      ],
    }],
  });
  assert.equal(out, `[mcp_servers.openwar]
command = "node"
args = ["openwar", "mcp-serve"]
`);
});

test("toml: empty array serializes as []", () => {
  const out = writeTomlConfig({
    sections: [{ header: "x", fields: [{ key: "args", value: [] }] }],
  });
  assert.match(out, /args = \[\]/);
});

test("toml: dotted section header preserved verbatim", () => {
  const out = writeTomlConfig({
    sections: [{ header: "a.b.c", fields: [{ key: "k", value: "v" }] }],
  });
  assert.match(out, /\[a\.b\.c\]/);
});

test("toml: multiple sections separated by a blank line", () => {
  const out = writeTomlConfig({
    sections: [
      { header: "one", fields: [{ key: "k", value: "1" }] },
      { header: "two", fields: [{ key: "k", value: "2" }] },
    ],
  });
  assert.equal(out, `[one]
k = "1"

[two]
k = "2"
`);
});

test("toml: file ends with a single trailing newline", () => {
  const out = writeTomlConfig({
    sections: [{ header: "x", fields: [{ key: "k", value: "v" }] }],
  });
  assert.equal(out.endsWith("\n"), true);
  assert.equal(out.endsWith("\n\n"), false);
});

// ---------- escape rules ----------

test("escape: backslash escaped as \\\\", () => {
  assert.equal(escapeBasicString("a\\b"), `"a\\\\b"`);
});

test("escape: double quote escaped as \\\"", () => {
  assert.equal(escapeBasicString('a"b'), `"a\\"b"`);
});

test("escape: newline escaped as \\n", () => {
  assert.equal(escapeBasicString("a\nb"), `"a\\nb"`);
});

test("escape: tab escaped as \\t", () => {
  assert.equal(escapeBasicString("a\tb"), `"a\\tb"`);
});

test("escape: carriage return escaped as \\r", () => {
  assert.equal(escapeBasicString("a\rb"), `"a\\rb"`);
});

test("escape: form feed escaped as \\f", () => {
  assert.equal(escapeBasicString("a\fb"), `"a\\fb"`);
});

test("escape: backspace escaped as \\b", () => {
  assert.equal(escapeBasicString("a\bb"), `"a\\bb"`);
});

test("escape: other control chars escaped as \\uXXXX", () => {
  // U+0001 (SOH) is not one of the named escapes.
  assert.equal(escapeBasicString("a\x01b"), `"a\\u0001b"`);
  // U+007F (DEL) likewise.
  assert.equal(escapeBasicString("a\x7fb"), `"a\\u007Fb"`);
});

test("escape: ASCII printable passes through", () => {
  assert.equal(escapeBasicString("hello world"), `"hello world"`);
});

test("escape: non-ASCII Unicode passes through (UTF-8 canonical)", () => {
  assert.equal(escapeBasicString("héllo"), `"héllo"`);
});

test("escape: Windows path with backslashes serialized correctly", () => {
  assert.equal(
    escapeBasicString("C:\\app\\openwar"),
    `"C:\\\\app\\\\openwar"`,
  );
});

test("escape: path with both backslashes and a space is double-quoted intact", () => {
  assert.equal(
    escapeBasicString("C:\\Program Files\\nodejs\\node.exe"),
    `"C:\\\\Program Files\\\\nodejs\\\\node.exe"`,
  );
});

test("escape: empty string round-trips as empty quotes", () => {
  assert.equal(escapeBasicString(""), `""`);
});

// ---------- canonical MCP config ----------

test("toml: canonical Codex MCP config shape (single mcp_servers.openwar section)", () => {
  const config: TomlConfig = {
    sections: [{
      header: "mcp_servers.openwar",
      fields: [
        { key: "command", value: "node" },
        { key: "args", value: ["C:\\bin\\openwar", "mcp-serve", "--workdir", "C:\\projects\\foo"] },
      ],
    }],
  };
  const out = writeTomlConfig(config);
  // Path backslashes survive the round-trip as TOML-escaped \\\\.
  assert.match(out, /"C:\\\\bin\\\\openwar"/);
  assert.match(out, /"--workdir"/);
  assert.match(out, /\[mcp_servers\.openwar\]/);
});

// ---------- upsertTomlSection ----------

test("upsert: appends new section to empty file with a single trailing newline", () => {
  const out = upsertTomlSection("", "x", `k = "v"`);
  assert.equal(out, `[x]\nk = "v"\n`);
});

test("upsert: appends new section to existing file without clobbering", () => {
  const existing = `[other]\nfoo = "bar"\n`;
  const out = upsertTomlSection(existing, "x", `k = "v"`);
  assert.match(out, /\[other\]\nfoo = "bar"/);
  assert.match(out, /\[x\]\nk = "v"/);
});

test("upsert: replaces an existing section, leaves siblings intact", () => {
  const existing = `[other]\nfoo = "bar"\n\n[x]\nold = "1"\n\n[after]\nz = "z"\n`;
  const out = upsertTomlSection(existing, "x", `new = "2"`);
  assert.match(out, /\[other\]\nfoo = "bar"/);
  assert.match(out, /\[x\]\nnew = "2"/);
  assert.ok(!out.includes(`old = "1"`), "old section body must be replaced");
  assert.match(out, /\[after\]\nz = "z"/);
});

test("upsert: replacing the final section preserves header + body", () => {
  const existing = `[a]\nk = "1"\n\n[x]\nold = "1"\n`;
  const out = upsertTomlSection(existing, "x", `new = "2"`);
  assert.match(out, /\[a\]\nk = "1"/);
  assert.match(out, /\[x\]\nnew = "2"/);
  assert.ok(!out.includes(`old = "1"`));
});

test("upsert: header name with the same prefix as another header does not match wrong section", () => {
  const existing = `[foo.bar]\nk = "1"\n\n[foo.bar.baz]\nk = "2"\n`;
  const out = upsertTomlSection(existing, "foo.bar", `k = "REPL"`);
  // The bar.baz section must survive.
  assert.match(out, /\[foo\.bar\.baz\]\nk = "2"/);
  // The bar section's body is replaced.
  assert.match(out, /\[foo\.bar\]\nk = "REPL"/);
});

test("upsert: CRLF input is normalized; LF output", () => {
  const existing = `[other]\r\nfoo = "bar"\r\n`;
  const out = upsertTomlSection(existing, "x", `k = "v"`);
  assert.ok(!out.includes("\r"), "no CRLF in output");
  assert.match(out, /\[x\]\nk = "v"/);
});
