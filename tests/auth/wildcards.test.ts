import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAuthorization, detectWildcardAllWarning } from "../../src/auth/wildcards.js";

test("exact match", () => {
  assert.equal(matchesAuthorization("filesystem_write", "filesystem_write"), true);
  assert.equal(matchesAuthorization("filesystem_write", "shell_exec"), false);
});

test("* wildcard authorizes every category", () => {
  assert.equal(matchesAuthorization("filesystem_write", "*"), true);
  assert.equal(matchesAuthorization("paid_api_call", "*"), true);
  assert.equal(matchesAuthorization("mcp_tool:server:tool", "*"), true);
});

test("mcp_tool:* matches any mcp_tool category", () => {
  assert.equal(matchesAuthorization("mcp_tool:filesystem", "mcp_tool:*"), true);
  assert.equal(matchesAuthorization("mcp_tool:filesystem:read_file", "mcp_tool:*"), true);
  assert.equal(matchesAuthorization("filesystem_write", "mcp_tool:*"), false);
});

test("mcp_tool:server:* matches any tool from that server", () => {
  assert.equal(
    matchesAuthorization("mcp_tool:filesystem:read_file", "mcp_tool:filesystem:*"),
    true,
  );
  assert.equal(
    matchesAuthorization("mcp_tool:filesystem:write_file", "mcp_tool:filesystem:*"),
    true,
  );
});

test("mcp_tool:server:* also matches the server umbrella itself", () => {
  assert.equal(matchesAuthorization("mcp_tool:filesystem", "mcp_tool:filesystem:*"), true);
});

test("mcp_tool:server:* does NOT match a different server", () => {
  assert.equal(
    matchesAuthorization("mcp_tool:other:read_file", "mcp_tool:filesystem:*"),
    false,
  );
});

test("mcp_tool:server:* does NOT match a server with a longer name prefix", () => {
  // "mcp_tool:fs:*" should not match "mcp_tool:fs2:read"
  assert.equal(matchesAuthorization("mcp_tool:fs2:read", "mcp_tool:fs:*"), false);
});

test("case-sensitive (categories are lower_snake by convention)", () => {
  assert.equal(matchesAuthorization("filesystem_write", "FILESYSTEM_WRITE"), false);
});

test("detectWildcardAllWarning returns warning when '*' present", () => {
  const warn = detectWildcardAllWarning(["*"]);
  assert.ok(warn);
  assert.match(warn, /authorizes every destructive category/);
});

test("detectWildcardAllWarning returns null when '*' absent", () => {
  assert.equal(detectWildcardAllWarning(["filesystem_write", "shell_exec"]), null);
  assert.equal(detectWildcardAllWarning([]), null);
});
