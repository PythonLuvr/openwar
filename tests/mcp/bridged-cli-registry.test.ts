// v0.7: bridged-CLI registry tests. Covers Claude Code (the v0.7.0 entry)
// and the unknown-binary fallback path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBridgedCliStrategy,
  listKnownBridgedClis,
  buildMcpConfigFile,
} from "../../src/mcp/bridged-cli-registry.js";

test("registry: Claude Code resolves via basename, case-insensitive, ext-stripped", () => {
  for (const binary of ["claude", "claude.cmd", "claude.exe", "CLAUDE.CMD", "C:\\path\\claude.cmd"]) {
    const s = resolveBridgedCliStrategy(binary);
    assert.equal(s.display_name, "Claude Code", `expected Claude Code for "${binary}"`);
    assert.equal(s.mcp_supported, true);
  }
});

test("registry: unknown binary falls back; buildArgs returns empty (manual wiring)", () => {
  const s = resolveBridgedCliStrategy("aider");
  assert.equal(s.mcp_supported, false);
  assert.equal(s.display_name, "unknown bridged CLI");
  const args = s.buildArgs({ configPath: "/tmp/x.json", serverCommand: "node", serverArgs: [] });
  assert.deepEqual(args, []);
});

test("registry: Claude Code buildArgs injects --mcp-config <path>", () => {
  const s = resolveBridgedCliStrategy("claude");
  const args = s.buildArgs({ configPath: "/tmp/cfg.json", serverCommand: "node", serverArgs: [] });
  assert.deepEqual(args, ["--mcp-config", "/tmp/cfg.json"]);
});

test("registry: listKnownBridgedClis includes Claude Code", () => {
  const known = listKnownBridgedClis();
  assert.ok(known.some((k) => k.key === "claude"));
});

test("registry: buildMcpConfigFile produces the Claude-Code-shaped JSON", () => {
  const content = buildMcpConfigFile({
    serverCommand: "node",
    serverArgs: ["/usr/bin/openwar", "mcp-serve", "--workdir", "/tmp"],
  });
  assert.ok(content.mcpServers.openwar);
  assert.equal(content.mcpServers.openwar!.command, "node");
  assert.deepEqual(content.mcpServers.openwar!.args, ["/usr/bin/openwar", "mcp-serve", "--workdir", "/tmp"]);
});

test("registry: buildMcpConfigFile accepts a custom server name", () => {
  const content = buildMcpConfigFile({
    serverName: "myopenwar",
    serverCommand: "node",
    serverArgs: ["foo"],
  });
  assert.ok(content.mcpServers.myopenwar);
  assert.equal(content.mcpServers.openwar, undefined);
});
