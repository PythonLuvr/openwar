// v0.7: bridged-CLI registry tests. Covers Claude Code (the v0.7.0 entry)
// and the unknown-binary fallback path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBridgedCliStrategy,
  listKnownBridgedClis,
  buildMcpConfigFile,
} from "../../src/mcp/bridged-cli-registry.js";
void buildMcpConfigFile; // satisfy ts-strict when not all tests use it

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

// v0.7.0: Gemini CLI registry entry.

test("registry: Gemini CLI resolves via basename, case-insensitive", () => {
  for (const binary of ["gemini", "gemini.cmd", "GEMINI", "C:\\bin\\gemini.exe"]) {
    const s = resolveBridgedCliStrategy(binary);
    assert.equal(s.display_name, "Gemini CLI", `expected Gemini CLI for "${binary}"`);
    assert.equal(s.mcp_supported, true);
  }
});

test("registry: Gemini CLI auto-discovers config (no --mcp-config flag injected)", () => {
  const s = resolveBridgedCliStrategy("gemini");
  const args = s.buildArgs({ configPath: "/tmp/x.json", serverCommand: "node", serverArgs: [] });
  assert.deepEqual(args, [], "Gemini auto-discovers from .gemini/settings.json; no CLI args needed");
});

test("registry: Gemini CLI writes config to <workdir>/.gemini/settings.json", () => {
  const s = resolveBridgedCliStrategy("gemini");
  assert.ok(s.configPath, "Gemini strategy must specify a configPath override");
  const path = s.configPath!({ workdir: "/some/work", briefId: "B1", defaultTmpPath: "/tmp/x.json" });
  // Cross-platform safe assertion on the components, not the separator.
  assert.match(path, /\.gemini[\\/]settings\.json$/);
  assert.match(path, /some[\\/]work/);
});

test("registry: Gemini CLI persists config across runs (no cleanup)", () => {
  const s = resolveBridgedCliStrategy("gemini");
  assert.equal(s.cleanupConfigFile, false);
});

test("registry: Claude Code cleans up its temp config file", () => {
  const s = resolveBridgedCliStrategy("claude");
  assert.notEqual(s.cleanupConfigFile, false, "Claude Code uses a temp path and should clean up");
});

test("registry: listKnownBridgedClis includes both Claude Code and Gemini", () => {
  const known = listKnownBridgedClis();
  const keys = known.map((k) => k.key);
  assert.ok(keys.includes("claude"));
  assert.ok(keys.includes("gemini"));
});

// v0.7.1: Codex CLI is now in the registry.

test("registry: Codex CLI resolves via basename, case-insensitive", () => {
  for (const binary of ["codex", "codex.cmd", "CODEX", "C:\\bin\\codex.exe", "/usr/local/bin/codex"]) {
    const s = resolveBridgedCliStrategy(binary);
    assert.equal(s.display_name, "Codex CLI", `expected Codex CLI for "${binary}"`);
    assert.equal(s.mcp_supported, true);
  }
});

test("registry: Codex configPath resolves to ~/.codex/config.toml on the operator's home", () => {
  const s = resolveBridgedCliStrategy("codex");
  const path = s.configPath!({ workdir: "/anywhere", briefId: "B1", defaultTmpPath: "/tmp/x.json" });
  assert.match(path, /\.codex[\\/]config\.toml$/);
});

test("registry: Codex persists config across runs (no cleanup)", () => {
  const s = resolveBridgedCliStrategy("codex");
  assert.equal(s.cleanupConfigFile, false);
});

test("registry: Codex auto-discovers config (no --mcp-config flag injected)", () => {
  const s = resolveBridgedCliStrategy("codex");
  const args = s.buildArgs({ configPath: "/somewhere/config.toml", serverCommand: "node", serverArgs: [] });
  assert.deepEqual(args, [], "Codex auto-discovers from ~/.codex/config.toml; no CLI args needed");
});

test("registry: Codex serializeConfig emits TOML (not JSON) with the canonical MCP shape", () => {
  const s = resolveBridgedCliStrategy("codex");
  assert.ok(s.serializeConfig, "Codex strategy must override serializeConfig");
  const content = buildMcpConfigFile({
    serverCommand: "node",
    serverArgs: ["/path/to/openwar", "mcp-serve"],
  });
  const out = s.serializeConfig!(content);
  // TOML markers, not JSON.
  assert.match(out, /\[mcp_servers\.openwar\]/);
  assert.match(out, /command = "node"/);
  assert.match(out, /args = \["\/path\/to\/openwar", "mcp-serve"\]/);
  // No JSON braces around the top level.
  assert.ok(!out.trimStart().startsWith("{"), "TOML output should not start with {");
});

test("registry: Codex uses mergeIntoExisting (preserves operator hand-edits)", () => {
  const s = resolveBridgedCliStrategy("codex");
  assert.equal(s.mergeIntoExisting, true);
  assert.equal(s.mergeSectionHeader, "mcp_servers.openwar");
});

test("registry: listKnownBridgedClis includes Claude Code, Gemini CLI, AND Codex CLI", () => {
  const known = listKnownBridgedClis();
  const keys = known.map((k) => k.key);
  assert.ok(keys.includes("claude"));
  assert.ok(keys.includes("gemini"));
  assert.ok(keys.includes("codex"));
});

test("registry: aider remains on the fallback path (no native MCP)", () => {
  const s = resolveBridgedCliStrategy("aider");
  assert.equal(s.mcp_supported, false);
});
