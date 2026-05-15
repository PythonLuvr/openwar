// MCP protocol types. Hand-rolled from the spec to avoid the SDK dependency.
// https://spec.modelcontextprotocol.io/
//
// Targets the 2024-11-05 stable spec. When the spec versions, bump this
// constant and update the shapes below as needed.

export const MCP_PROTOCOL_VERSION = "2024-11-05";

// ---------- JSON-RPC base ----------

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------- MCP-specific ----------

export interface InitializeParams {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: { listChanged?: boolean };
    resources?: { listChanged?: boolean; subscribe?: boolean };
    prompts?: { listChanged?: boolean };
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ListToolsResult {
  tools: McpTool[];
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CallToolResult {
  // MCP content blocks. Text-only for v0.3 OpenWar; we ignore image/embedded resources.
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}

// ---------- Transport ----------

export interface McpTransport {
  // Send a JSON-RPC request and wait for the matching response.
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  // Send a JSON-RPC notification (no response expected).
  notify(method: string, params?: unknown): Promise<void>;
  // Tear down the transport.
  close(): Promise<void>;
  // Resolves when the transport ends (process exits, socket closes, etc.).
  readonly closed: Promise<void>;
}

export class McpProtocolError extends Error {
  readonly code = "MCP_PROTOCOL" as const;
  constructor(message: string, public readonly rpcCode?: number) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export class McpTransportError extends Error {
  readonly code = "MCP_TRANSPORT" as const;
  constructor(message: string) {
    super(message);
    this.name = "McpTransportError";
  }
}
