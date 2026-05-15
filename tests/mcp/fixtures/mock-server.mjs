// Minimal MCP server fixture. Listens on stdio, responds to:
//   initialize, tools/list, tools/call
//
// Behavior:
//   - tools/list returns one tool ("echo") with a trivial schema
//   - echo returns whatever args.message was passed
//   - any other method returns method-not-found error
//
// Crash modes (controlled via argv):
//   --crash-after-init    exit(1) after sending the initialize result
//   --malformed-on-list   send "not json\n" instead of a proper response to tools/list
//   --hang-on-call        never respond to tools/call

const args = new Set(process.argv.slice(2));
const crashAfterInit = args.has("--crash-after-init");
const malformedOnList = args.has("--malformed-on-list");
const hangOnCall = args.has("--hang-on-call");

let buffer = "";

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  if (!msg.method) return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mock-mcp-server", version: "0.1.0" },
      },
    });
    if (crashAfterInit) {
      // Give the client a tick to receive the response, then crash.
      setTimeout(() => process.exit(1), 20);
    }
    return;
  }
  if (msg.method === "notifications/initialized") {
    // No reply for notifications.
    return;
  }
  if (msg.method === "tools/list") {
    if (malformedOnList) {
      process.stdout.write("this is not json\n");
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back the message argument.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    if (hangOnCall) return;
    const name = msg.params?.name;
    if (name === "echo") {
      const text = msg.params?.arguments?.message ?? "";
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text }], isError: false },
      });
      return;
    }
    error(msg.id, -32601, `tool not found: ${name}`);
    return;
  }
  error(msg.id, -32601, `method not found: ${msg.method}`);
}
