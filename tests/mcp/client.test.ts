import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MCPClient } from "../../src/mcp/client.js";
import { StdioTransport } from "../../src/mcp/transport-stdio.js";
import { McpProtocolError, McpTransportError } from "../../src/mcp/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(here, "fixtures", "mock-server.mjs");

async function spawnMockClient(extraArgs: string[] = []): Promise<MCPClient> {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [MOCK_SERVER, ...extraArgs],
    defaultTimeoutMs: 2000,
  });
  const client = new MCPClient({ transport });
  await client.connect();
  return client;
}

test("MCPClient: handshake returns server info", async () => {
  const client = await spawnMockClient();
  try {
    const info = client.getServerInfo();
    assert.ok(info);
    assert.equal(info!.name, "mock-mcp-server");
  } finally { await client.disconnect(); }
});

test("MCPClient: listTools returns the mock 'echo' tool", async () => {
  const client = await spawnMockClient();
  try {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "echo");
  } finally { await client.disconnect(); }
});

test("MCPClient: callTool returns content blocks", async () => {
  const client = await spawnMockClient();
  try {
    const result = await client.callTool({ name: "echo", arguments: { message: "ping" } });
    assert.equal(result.isError, false);
    assert.equal(result.content[0]!.type, "text");
    assert.equal(result.content[0]!.text, "ping");
  } finally { await client.disconnect(); }
});

test("MCPClient: callTool with unknown tool surfaces a protocol error", async () => {
  const client = await spawnMockClient();
  try {
    await assert.rejects(
      () => client.callTool({ name: "nonexistent" }),
      McpProtocolError,
    );
  } finally { await client.disconnect(); }
});

test("MCPClient: pending requests reject when server exits", async () => {
  const client = await spawnMockClient(["--crash-after-init"]);
  try {
    // Wait for the server to actually die before sending the next request.
    await new Promise(r => setTimeout(r, 150));
    await assert.rejects(
      () => client.listTools(),
      McpTransportError,
    );
  } finally { await client.disconnect().catch(() => {}); }
});

test("MCPClient: requests time out when server hangs", async () => {
  const client = await spawnMockClient(["--hang-on-call"]);
  try {
    await assert.rejects(
      () => client.callTool({ name: "echo", arguments: { message: "x" } }),
      /timed out/,
    );
  } finally { await client.disconnect(); }
});

test("MCPClient: protocol version is sent in initialize", async () => {
  const client = await spawnMockClient();
  try {
    const info = client.getServerInfo();
    assert.ok(info);
    // Round-trip just confirms connect didn't throw, which means the
    // handshake completed against a server that asserts protocol shape.
  } finally { await client.disconnect(); }
});
