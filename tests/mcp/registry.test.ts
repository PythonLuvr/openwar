import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGlobalMcpConfig,
  mergeServerConfigs,
  splitCommand,
} from "../../src/mcp/registry.js";

test("loadGlobalMcpConfig returns empty when file missing", async () => {
  const path = join(tmpdir(), "openwar-no-mcp-" + Date.now() + ".json");
  const servers = await loadGlobalMcpConfig(path);
  assert.deepEqual(servers, []);
});

test("loadGlobalMcpConfig parses valid file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-mcp-"));
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({
      servers: [
        { name: "filesystem", command: "npx -y @modelcontextprotocol/server-filesystem /tmp" },
        { name: "search", command: "node ./search-server.js" },
      ],
    }));
    const servers = await loadGlobalMcpConfig(path);
    assert.equal(servers.length, 2);
    assert.equal(servers[0]!.name, "filesystem");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("loadGlobalMcpConfig rejects malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-mcp-"));
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, "not json");
    await assert.rejects(() => loadGlobalMcpConfig(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("loadGlobalMcpConfig rejects missing name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-mcp-"));
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({ servers: [{ command: "node x.js" }] }));
    await assert.rejects(() => loadGlobalMcpConfig(path), /needs a non-empty "name"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("loadGlobalMcpConfig rejects missing command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-mcp-"));
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({ servers: [{ name: "x" }] }));
    await assert.rejects(() => loadGlobalMcpConfig(path), /needs a "command"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("loadGlobalMcpConfig rejects non-array servers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-mcp-"));
  try {
    const path = join(dir, "mcp.json");
    await writeFile(path, JSON.stringify({ servers: "wrong shape" }));
    await assert.rejects(() => loadGlobalMcpConfig(path), /must be an array/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("mergeServerConfigs prefers per-session entries", () => {
  const global = [{ name: "fs", command: "global-fs" }];
  const session = [{ name: "fs", command: "session-fs" }];
  const merged = mergeServerConfigs(global, session);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.command, "session-fs");
});

test("mergeServerConfigs concatenates non-overlapping entries", () => {
  const merged = mergeServerConfigs(
    [{ name: "a", command: "x" }],
    [{ name: "b", command: "y" }],
  );
  assert.equal(merged.length, 2);
});

test("splitCommand splits on whitespace", () => {
  const { bin, args } = splitCommand("npx -y @modelcontextprotocol/server-filesystem /tmp");
  assert.equal(bin, "npx");
  assert.deepEqual(args, ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
});

test("splitCommand rejects empty input", () => {
  assert.throws(() => splitCommand(""), /empty command/);
  assert.throws(() => splitCommand("   "), /empty command/);
});
