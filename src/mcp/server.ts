// MCP server. The mirror of MCPClient: listens for JSON-RPC requests on a
// readable stream (typically stdin), dispatches to a handler map, writes
// responses to a writable stream (typically stdout).
//
// Used by the v0.7 cli-bridge MCP-server-mode pathway: a bridged CLI like
// Claude Code spawns an `openwar mcp-serve` child process, that child wires
// OpenWar's native tools into a McpServer instance, and the bridged CLI
// reaches OpenWar's tools through standard MCP.
//
// Hand-rolled to avoid the @modelcontextprotocol/sdk dependency (the
// existing client side is also hand-rolled). Same JSON-RPC framing rules:
// newline-delimited UTF-8 JSON, no batching, no length prefixes.

import type { Readable, Writable } from "node:stream";
import {
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
  type InitializeResult,
  type ListToolsResult,
  type CallToolResult,
  type CallToolParams,
  type McpTool,
} from "./types.js";

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpRequestHandler<TParams = unknown, TResult = unknown> {
  (params: TParams): Promise<TResult> | TResult;
}

export interface McpServerOpts {
  input: Readable;
  output: Writable;
  serverInfo: McpServerInfo;
  // Handlers keyed by JSON-RPC method. The server registers `initialize`,
  // `tools/list`, and `tools/call` automatically; consumers wire those via
  // setToolsListHandler / setCallToolHandler. Custom methods go through
  // setHandler.
}

// JSON-RPC error codes per the spec. -32602 invalid params, -32601 method
// not found, -32603 internal, -32000+ application-defined.
export const RPC_ERR_PARSE = -32700;
export const RPC_ERR_INVALID_REQUEST = -32600;
export const RPC_ERR_METHOD_NOT_FOUND = -32601;
export const RPC_ERR_INVALID_PARAMS = -32602;
export const RPC_ERR_INTERNAL = -32603;
// Application-defined: prefix on the message side so the operator can see
// the layer at a glance (per v0.7 picks: "OpenWar denied: ..." vs upstream).
export const RPC_ERR_OPENWAR_AUTH = -32000;
export const RPC_ERR_OPENWAR_INTERNAL = -32001;

export class McpServer {
  private input: Readable;
  private output: Writable;
  private serverInfo: McpServerInfo;
  private buffer = "";
  private toolsListHandler: McpRequestHandler<undefined, ListToolsResult> | null = null;
  private callToolHandler: McpRequestHandler<CallToolParams, CallToolResult> | null = null;
  private customHandlers = new Map<string, McpRequestHandler>();
  private isClosed = false;
  private initializedReceived = false;
  private closeResolve: () => void = () => {};
  readonly closed: Promise<void>;

  constructor(opts: McpServerOpts) {
    this.input = opts.input;
    this.output = opts.output;
    this.serverInfo = opts.serverInfo;
    this.closed = new Promise<void>((resolve) => { this.closeResolve = resolve; });
    this.input.setEncoding?.("utf8");
    this.input.on("data", (chunk: string | Buffer) => this.onData(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    this.input.on("end", () => this.shutdown());
    this.input.on("close", () => this.shutdown());
  }

  setToolsListHandler(h: McpRequestHandler<undefined, ListToolsResult>): void {
    this.toolsListHandler = h;
  }

  setCallToolHandler(h: McpRequestHandler<CallToolParams, CallToolResult>): void {
    this.callToolHandler = h;
  }

  setHandler(method: string, h: McpRequestHandler): void {
    this.customHandlers.set(method, h);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // Cap inbound buffer the same way the client does to bound memory.
    if (this.buffer.length > 5_000_000) {
      this.writeError(null, RPC_ERR_INTERNAL, "OpenWar: inbound buffer exceeded 5MB; aborting");
      this.shutdown();
      return;
    }
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      void this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      this.writeError(null, RPC_ERR_PARSE, `OpenWar: malformed JSON: ${(err as Error).message}`);
      return;
    }
    if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      this.writeError(parsed.id ?? null, RPC_ERR_INVALID_REQUEST, "OpenWar: not a valid JSON-RPC 2.0 request");
      return;
    }

    // Notifications (no id) are accepted but not responded to.
    if (parsed.id === undefined || parsed.id === null) {
      if (parsed.method === "notifications/initialized") {
        this.initializedReceived = true;
      }
      // No response for notifications.
      return;
    }

    try {
      const result = await this.dispatch(parsed.method, parsed.params);
      this.writeResult(parsed.id, result);
    } catch (err) {
      if (err && typeof err === "object" && "rpcCode" in err && "rpcMessage" in err) {
        const e = err as { rpcCode: number; rpcMessage: string };
        this.writeError(parsed.id, e.rpcCode, e.rpcMessage);
        return;
      }
      const msg = (err as Error).message ?? String(err);
      this.writeError(parsed.id, RPC_ERR_OPENWAR_INTERNAL, `OpenWar: ${msg}`);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") {
      const result: InitializeResult = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { ...this.serverInfo },
      };
      return result;
    }
    if (method === "tools/list") {
      if (!this.toolsListHandler) {
        throw rpcError(RPC_ERR_METHOD_NOT_FOUND, "OpenWar: tools/list not wired");
      }
      return await this.toolsListHandler(undefined);
    }
    if (method === "tools/call") {
      if (!this.callToolHandler) {
        throw rpcError(RPC_ERR_METHOD_NOT_FOUND, "OpenWar: tools/call not wired");
      }
      if (!params || typeof params !== "object") {
        throw rpcError(RPC_ERR_INVALID_PARAMS, "OpenWar: tools/call requires params object");
      }
      return await this.callToolHandler(params as CallToolParams);
    }
    const custom = this.customHandlers.get(method);
    if (custom) return await custom(params);
    throw rpcError(RPC_ERR_METHOD_NOT_FOUND, `OpenWar: unknown method "${method}"`);
  }

  private writeResult(id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.write(msg);
  }

  private writeError(id: number | string | null, code: number, message: string, data?: unknown): void {
    const error: JsonRpcError = { code, message, ...(data !== undefined && { data }) };
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error };
    this.write(msg);
  }

  private write(msg: JsonRpcResponse): void {
    if (this.isClosed) return;
    try {
      this.output.write(JSON.stringify(msg) + "\n");
    } catch {
      // Output stream gone. Shut down so the process can exit.
      this.shutdown();
    }
  }

  shutdown(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closeResolve();
  }

  isInitialized(): boolean {
    return this.initializedReceived;
  }

  // Public for tests / external composition.
  listAvailableTools(toolDefs: McpTool[]): McpTool[] {
    return [...toolDefs];
  }
}

// rpcError builds a thrown error the dispatcher recognises and serialises
// with the right RPC code. Wraps Error so stack traces still work.
export function rpcError(code: number, message: string): Error & { rpcCode: number; rpcMessage: string } {
  const e = new Error(message) as Error & { rpcCode: number; rpcMessage: string };
  e.rpcCode = code;
  e.rpcMessage = message;
  return e;
}
