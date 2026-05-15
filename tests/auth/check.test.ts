import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAuthorization } from "../../src/auth/check.js";
import type { ToolDefinition } from "../../src/tools/types.js";

function tool(name: string, categories: ToolDefinition["authorization_categories"]): ToolDefinition {
  return {
    name,
    description: "",
    input_schema: { type: "object" },
    origin: "native",
    authorization_categories: categories,
  };
}

test("read_file is default-allowed without authorized_costs", () => {
  const decision = checkAuthorization({
    tool: tool("read_file", ["filesystem_read"]),
    authorizedCosts: [],
  });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.missing_categories, []);
});

test("write_file requires filesystem_write", () => {
  const decision = checkAuthorization({
    tool: tool("write_file", ["filesystem_write"]),
    authorizedCosts: [],
  });
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missing_categories, ["filesystem_write"]);
});

test("write_file allowed when filesystem_write is in authorized_costs", () => {
  const decision = checkAuthorization({
    tool: tool("write_file", ["filesystem_write"]),
    authorizedCosts: ["filesystem_write"],
  });
  assert.equal(decision.allowed, true);
});

test("shell_exec gated by category", () => {
  const t = tool("shell_exec", ["shell_exec"]);
  assert.equal(checkAuthorization({ tool: t, authorizedCosts: [] }).allowed, false);
  assert.equal(checkAuthorization({ tool: t, authorizedCosts: ["shell_exec"] }).allowed, true);
});

test("multi-category tool needs all categories covered", () => {
  const t = tool("composite", ["filesystem_write", "shell_exec"]);
  const partial = checkAuthorization({ tool: t, authorizedCosts: ["filesystem_write"] });
  assert.equal(partial.allowed, false);
  assert.deepEqual(partial.missing_categories, ["shell_exec"]);

  const full = checkAuthorization({
    tool: t,
    authorizedCosts: ["filesystem_write", "shell_exec"],
  });
  assert.equal(full.allowed, true);
});

test("session-approved categories count as covered", () => {
  const t = tool("write_file", ["filesystem_write"]);
  const decision = checkAuthorization({
    tool: t,
    authorizedCosts: [],
    sessionApproved: ["filesystem_write"],
  });
  assert.equal(decision.allowed, true);
});

test("'*' in authorized_costs authorizes everything", () => {
  const t = tool("anything", ["filesystem_delete", "shell_exec", "paid_api_call"]);
  const decision = checkAuthorization({ tool: t, authorizedCosts: ["*"] });
  assert.equal(decision.allowed, true);
});

test("mcp_tool:server:* authorizes any tool from that server", () => {
  const t: ToolDefinition = {
    name: "filesystem:read_file",
    description: "",
    input_schema: { type: "object" },
    origin: "mcp",
    mcp_server_name: "filesystem",
    authorization_categories: ["mcp_tool:filesystem:read_file"],
  };
  const decision = checkAuthorization({
    tool: t,
    authorizedCosts: ["mcp_tool:filesystem:*"],
  });
  assert.equal(decision.allowed, true);
});

test("mcp_tool:* authorizes any MCP tool", () => {
  const t: ToolDefinition = {
    name: "anyserver:anytool",
    description: "",
    input_schema: { type: "object" },
    origin: "mcp",
    mcp_server_name: "anyserver",
    authorization_categories: ["mcp_tool:anyserver:anytool"],
  };
  const decision = checkAuthorization({ tool: t, authorizedCosts: ["mcp_tool:*"] });
  assert.equal(decision.allowed, true);
});

test("decision exposes the full required list, not just missing", () => {
  const t = tool("write_and_exec", ["filesystem_write", "shell_exec"]);
  const decision = checkAuthorization({
    tool: t,
    authorizedCosts: ["filesystem_write"],
  });
  assert.deepEqual(decision.required_categories, ["filesystem_write", "shell_exec"]);
  assert.deepEqual(decision.missing_categories, ["shell_exec"]);
});

test("empty authorization_categories means always allowed", () => {
  const t = tool("noop", []);
  assert.equal(checkAuthorization({ tool: t, authorizedCosts: [] }).allowed, true);
});

test("an MCP tool category is NOT default-allowed even if it superficially looks like read", () => {
  // mcp_tool:filesystem:read_file requires explicit authorization; we don't
  // try to infer from the name.
  const t: ToolDefinition = {
    name: "filesystem:read_file",
    description: "",
    input_schema: { type: "object" },
    origin: "mcp",
    mcp_server_name: "filesystem",
    authorization_categories: ["mcp_tool:filesystem:read_file"],
  };
  const decision = checkAuthorization({ tool: t, authorizedCosts: [] });
  assert.equal(decision.allowed, false);
});
