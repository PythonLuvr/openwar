import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTH_CATEGORIES_STATIC,
  DEFAULT_ALLOWED,
  isStaticCategory,
  isMcpCategory,
  parseMcpCategory,
} from "../../src/auth/categories.js";

test("AUTH_CATEGORIES_STATIC includes every documented static category", () => {
  const expected = [
    "filesystem_read",
    "filesystem_write",
    "filesystem_delete",
    "shell_exec",
    "http_fetch",
    "paid_api_call",
    "git_write",
    "git_push",
    "deploy",
    "external_message",
  ];
  assert.deepEqual([...AUTH_CATEGORIES_STATIC], expected);
});

test("DEFAULT_ALLOWED contains only filesystem_read", () => {
  assert.equal(DEFAULT_ALLOWED.size, 1);
  assert.ok(DEFAULT_ALLOWED.has("filesystem_read"));
});

test("isStaticCategory returns true for known statics", () => {
  for (const c of AUTH_CATEGORIES_STATIC) {
    assert.ok(isStaticCategory(c), `${c} should be static`);
  }
});

test("isStaticCategory returns false for unknown strings", () => {
  assert.equal(isStaticCategory("nonsense"), false);
  assert.equal(isStaticCategory(""), false);
  assert.equal(isStaticCategory("mcp_tool:foo"), false);
});

test("isMcpCategory matches the mcp_tool prefix", () => {
  assert.equal(isMcpCategory("mcp_tool:filesystem"), true);
  assert.equal(isMcpCategory("mcp_tool:filesystem:read_file"), true);
  assert.equal(isMcpCategory("filesystem_read"), false);
  assert.equal(isMcpCategory("mcp_tool"), false);
});

test("parseMcpCategory parses server-only form", () => {
  assert.deepEqual(parseMcpCategory("mcp_tool:filesystem"), { server: "filesystem" });
});

test("parseMcpCategory parses server+tool form", () => {
  assert.deepEqual(parseMcpCategory("mcp_tool:filesystem:read_file"), {
    server: "filesystem",
    tool: "read_file",
  });
});

test("parseMcpCategory handles tool names containing colons", () => {
  // A tool name with a colon (rare but possible) collapses into the tool slice.
  assert.deepEqual(parseMcpCategory("mcp_tool:server:tool:with:colons"), {
    server: "server",
    tool: "tool:with:colons",
  });
});

test("parseMcpCategory returns null for malformed input", () => {
  assert.equal(parseMcpCategory("mcp_tool:"), null);
  assert.equal(parseMcpCategory("mcp_tool"), null);
  assert.equal(parseMcpCategory(""), null);
  assert.equal(parseMcpCategory("filesystem_read"), null);
  assert.equal(parseMcpCategory("mcp_tool::tool"), null);
  assert.equal(parseMcpCategory("mcp_tool:server:"), null);
});
