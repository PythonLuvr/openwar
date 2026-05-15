// MCP module exports.

export { MCPClient, type McpClientInfo, type McpClientOpts } from "./client.js";
export { StdioTransport, type StdioTransportOpts } from "./transport-stdio.js";
export {
  loadGlobalMcpConfig,
  mergeServerConfigs,
  splitCommand,
  type McpServerConfig,
  type GlobalMcpConfig,
} from "./registry.js";
export {
  MCP_PROTOCOL_VERSION,
  McpProtocolError,
  McpTransportError,
  type McpTransport,
  type McpTool,
  type CallToolResult,
  type CallToolParams,
  type InitializeResult,
} from "./types.js";
