// v0.7: OpenWar MCP server runtime tests. Verifies the native-tool wiring,
// the OpenWar-vs-bridged-CLI error split, and the tool log capture path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const WORKDIR = mkdtempSync(join(tmpdir(), "openwar-mcp-runtime-"));
const TOOL_LOG = join(WORKDIR, "tool-log.jsonl");

const { runOpenwarMcpServer } = await import("../../src/mcp/openwar-server-runtime.js");

interface Pair { in: PassThrough; out: PassThrough; send: (line: string) => void; next: () => Promise<unknown>; }

function makePair(): Pair {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let buf = "";
  const queue: unknown[] = [];
  const waiters: ((v: unknown) => void)[] = [];
  output.on("data", (chunk: string) => {
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
    in: input,
    out: output,
    send(line: string) { input.write(line + "\n"); },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise<unknown>((resolve) => waiters.push(resolve));
    },
  };
}

test.after(() => {
  rmSync(WORKDIR, { recursive: true, force: true });
});

test("openwar-server: tools/list returns native tools namespaced as openwar:*", async () => {
  const pair = makePair();
  await runOpenwarMcpServer({
    input: pair.in,
    output: pair.out,
    workdir: WORKDIR,
    authorizedCosts: ["filesystem_read"],
  });
  pair.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const resp = await pair.next() as { result: { tools: Array<{ name: string }> } };
  const names = resp.result.tools.map((t) => t.name);
  assert.ok(names.includes("openwar:read_file"));
  assert.ok(names.includes("openwar:write_file"));
  assert.ok(names.includes("openwar:read_project_memory"));
  assert.ok(names.includes("openwar:write_project_memory"));
  // v0.7.3: list_project_memory must also be exposed (it's the symmetric
  // verification surface the brief calls for).
  assert.ok(names.includes("openwar:list_project_memory"));
});

test("openwar-server: unauthorized tool call returns isError with 'OpenWar denied' prefix", async () => {
  const pair = makePair();
  await runOpenwarMcpServer({
    input: pair.in,
    output: pair.out,
    workdir: WORKDIR,
    authorizedCosts: ["filesystem_read"], // no filesystem_write
    toolLogPath: TOOL_LOG,
  });
  pair.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "openwar:write_file", arguments: { path: "x.txt", content: "hi" } },
  }));
  const resp = await pair.next() as { result: { content: Array<{ text: string }>; isError: boolean } };
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0]!.text, /^OpenWar denied:/);
  assert.match(resp.result.content[0]!.text, /filesystem_write/);
});

test("openwar-server: tool call rejects unnamespaced tool name", async () => {
  const pair = makePair();
  await runOpenwarMcpServer({
    input: pair.in,
    output: pair.out,
    workdir: WORKDIR,
    authorizedCosts: ["filesystem_read", "filesystem_write"],
  });
  pair.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "read_file", arguments: {} },
  }));
  const resp = await pair.next() as { error: { message: string } };
  assert.match(resp.error.message, /must be prefixed with "openwar:"/);
});

test("openwar-server: allowed call executes and logs to JSONL", async () => {
  const pair = makePair();
  const logPath = join(WORKDIR, `log-${Date.now()}.jsonl`);
  await runOpenwarMcpServer({
    input: pair.in,
    output: pair.out,
    workdir: WORKDIR,
    authorizedCosts: ["filesystem_read", "filesystem_write"],
    toolLogPath: logPath,
  });
  pair.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "openwar:write_file", arguments: { path: "via-mcp.txt", content: "hello via MCP" } },
  }));
  const resp = await pair.next() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  assert.notEqual(resp.result.isError, true);
  assert.match(resp.result.content[0]!.text, /Wrote 13 bytes/);
  assert.ok(existsSync(join(WORKDIR, "via-mcp.txt")));
  // Tool log should have one entry.
  const log = readFileSync(logPath, "utf8").trim();
  const entry = JSON.parse(log) as { name: string; authorized: boolean };
  assert.equal(entry.name, "write_file");
  assert.equal(entry.authorized, true);
});

test("openwar-server: denial entry in tool log marks denied_by 'openwar'", async () => {
  const pair = makePair();
  const logPath = join(WORKDIR, `log-deny-${Date.now()}.jsonl`);
  await runOpenwarMcpServer({
    input: pair.in,
    output: pair.out,
    workdir: WORKDIR,
    authorizedCosts: ["filesystem_read"],
    toolLogPath: logPath,
  });
  pair.send(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "openwar:write_file", arguments: { path: "x.txt", content: "hi" } },
  }));
  await pair.next();
  const log = readFileSync(logPath, "utf8").trim();
  const entry = JSON.parse(log) as { authorized: boolean; denied_by: string; auth_note: string };
  assert.equal(entry.authorized, false);
  assert.equal(entry.denied_by, "openwar");
  assert.match(entry.auth_note, /filesystem_write/);
});
