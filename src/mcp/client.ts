// MCPClient. High-level wrapper over a transport. Handles handshake,
// initialized notification, tools/list, tools/call.

import {
  MCP_PROTOCOL_VERSION,
  type McpTransport,
  type InitializeResult,
  type ListToolsResult,
  type CallToolResult,
  type CallToolParams,
  type McpTool,
} from "./types.js";

export interface McpClientInfo {
  name: string;
  version: string;
}

export interface McpClientOpts {
  transport: McpTransport;
  clientInfo?: McpClientInfo;
}

export class MCPClient {
  private transport: McpTransport;
  private clientInfo: McpClientInfo;
  private serverInfo: InitializeResult["serverInfo"] | null = null;
  private initialized = false;

  constructor(opts: McpClientOpts) {
    this.transport = opts.transport;
    this.clientInfo = opts.clientInfo ?? { name: "openwar", version: "0.3.0" };
  }

  async connect(): Promise<InitializeResult> {
    const result = await this.transport.request<InitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: this.clientInfo,
    });
    this.serverInfo = result.serverInfo;
    // Per spec, send the "initialized" notification after the handshake.
    await this.transport.notify("notifications/initialized");
    this.initialized = true;
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.initialized) throw new Error("MCPClient: connect() before listTools()");
    const result = await this.transport.request<ListToolsResult>("tools/list");
    return result.tools;
  }

  async callTool(params: CallToolParams): Promise<CallToolResult> {
    if (!this.initialized) throw new Error("MCPClient: connect() before callTool()");
    return await this.transport.request<CallToolResult>("tools/call", params);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.initialized = false;
  }

  getServerInfo(): InitializeResult["serverInfo"] | null {
    return this.serverInfo;
  }
}
