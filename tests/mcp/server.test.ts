// v0.7: McpServer protocol-layer tests. End-to-end JSON-RPC round-trips
// through a paired client (StdioTransport-like) and server (McpServer)
// running in the same process over in-memory streams.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  McpServer,
  rpcError,
  RPC_ERR_METHOD_NOT_FOUND,
  RPC_ERR_INVALID_PARAMS,
  RPC_ERR_OPENWAR_AUTH,
  RPC_ERR_PARSE,
} from "../../src/mcp/server.js";

interface Pair {
  serverIn: PassThrough;
  serverOut: PassThrough;
  send: (line: string) => void;
  next: () => Promise<unknown>;
}

function makePair(): Pair {
  // serverIn: client writes here, server reads.
  // serverOut: server writes here, client reads.
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  serverOut.setEncoding("utf8");
  let buf = "";
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  serverOut.on("data", (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const parsed = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(parsed); else queue.push(parsed);
    }
  });
  return {
    serverIn,
    serverOut,
    send(line: string) { serverIn.write(line + "\n"); },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise<unknown>((resolve) => waiters.push(resolve));
    },
  };
}

function makeServer(pair: Pair): McpServer {
  return new McpServer({
    input: pair.serverIn,
    output: pair.serverOut,
    serverInfo: { name: "test-server", version: "0.0.0" },
  });
}

test("server: initialize handshake returns protocol version + serverInfo", async () => {
  const pair = makePair();
  makeServer(pair);
  pair.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  }));
  const resp = await pair.next() as { id: number; result: { serverInfo: { name: string } } };
  assert.equal(resp.id, 1);
  assert.equal(resp.result.serverInfo.name, "test-server");
});

test("server: tools/list returns the registered list", async () => {
  const pair = makePair();
  const server = makeServer(pair);
  server.setToolsListHandler(() => ({
    tools: [{ name: "foo", inputSchema: { type: "object" } }],
  }));
  pair.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const resp = await pair.next() as { result: { tools: Array<{ name: string }> } };
  assert.equal(resp.result.tools.length, 1);
  assert.equal(resp.result.tools[0]!.name, "foo");
});

test("server: tools/call dispatches to the call handler and returns its result", async () => {
  const pair = makePair();
  const server = makeServer(pair);
  server.setCallToolHandler(async (params) => ({
    content: [{ type: "text", text: `called ${params.name}` }],
  }));
  pair.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "openwar:read_file", arguments: { path: "x" } },
  }));
  const resp = await pair.next() as { result: { content: Array<{ text: string }> } };
  assert.equal(resp.result.content[0]!.text, "called openwar:read_file");
});

test("server: unknown method returns RPC_ERR_METHOD_NOT_FOUND with OpenWar prefix", async () => {
  const pair = makePair();
  makeServer(pair);
  pair.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "no/such/method" }));
  const resp = await pair.next() as { error: { code: number; message: string } };
  assert.equal(resp.error.code, RPC_ERR_METHOD_NOT_FOUND);
  assert.match(resp.error.message, /^OpenWar:/);
});

test("server: tools/call without params returns RPC_ERR_INVALID_PARAMS", async () => {
  const pair = makePair();
  const server = makeServer(pair);
  server.setCallToolHandler(async () => ({ content: [] }));
  pair.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }));
  const resp = await pair.next() as { error: { code: number; message: string } };
  assert.equal(resp.error.code, RPC_ERR_INVALID_PARAMS);
});

test("server: malformed JSON returns parse-error response (id null)", async () => {
  const pair = makePair();
  makeServer(pair);
  pair.send("{ this is not json");
  const resp = await pair.next() as { id: null; error: { code: number; message: string } };
  assert.equal(resp.id, null);
  assert.equal(resp.error.code, RPC_ERR_PARSE);
  assert.match(resp.error.message, /OpenWar/);
});

test("server: notifications produce no response", async () => {
  const pair = makePair();
  makeServer(pair);
  // notifications/initialized has no id.
  pair.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  // Send a follow-up to force ordering; ensure the only response is to it.
  pair.send(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "initialize", params: {} }));
  const resp = await pair.next() as { id: number };
  assert.equal(resp.id, 42);
});

test("server: handler throw without rpcCode surfaces as OpenWar internal error", async () => {
  const pair = makePair();
  const server = makeServer(pair);
  server.setCallToolHandler(async () => { throw new Error("boom"); });
  pair.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "openwar:x" },
  }));
  const resp = await pair.next() as { error: { code: number; message: string } };
  assert.match(resp.error.message, /OpenWar:.*boom/);
});

test("server: rpcError() with a custom code preserves the code on the wire", async () => {
  const pair = makePair();
  const server = makeServer(pair);
  server.setCallToolHandler(async () => {
    throw rpcError(RPC_ERR_OPENWAR_AUTH, "OpenWar denied: nope");
  });
  pair.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "openwar:x" },
  }));
  const resp = await pair.next() as { error: { code: number; message: string } };
  assert.equal(resp.error.code, RPC_ERR_OPENWAR_AUTH);
  assert.match(resp.error.message, /OpenWar denied/);
});
