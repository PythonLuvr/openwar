// Shared shapes for tool calling. Used by:
//   - Native built-in tools (src/tools/native/*)
//   - MCP tools (src/mcp/*)
//   - Adapter tool-call translation (src/adapters/*)
//   - Runtime integration (src/runner.ts, src/phases/execute.ts)
//   - Authorization gate (src/auth/check.ts)
//
// These types are the contract every tool path must honor. Changes here ripple.

import type { AuthCategory } from "../auth/categories.js";
import type { SandboxContext } from "../sandbox/types.js";

export type ToolOrigin = "native" | "mcp";

// Loose JSON Schema representation. Each adapter translates this into its
// provider-specific function-call schema. Tools own their own argument
// validation past the schema (the schema is for the LLM, not us).
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  enum?: unknown[];
  // Allow provider-specific fields without losing type safety on the known ones.
  [k: string]: unknown;
}

export interface ToolDefinition {
  // Stable identifier the LLM uses to invoke. Must be unique across the
  // tool registry (native + MCP combined).
  name: string;
  // Human-readable description shown to the LLM. Should explain when to use
  // the tool, not just what it does.
  description: string;
  input_schema: JsonSchema;
  origin: ToolOrigin;
  // Auth categories required to execute. Empty means default-allowed
  // (typically only true for filesystem_read tools).
  authorization_categories: AuthCategory[];
  // Set when origin === "mcp". Names the entry in the MCP server registry
  // that owns this tool. Used by the runtime to dispatch the call.
  mcp_server_name?: string;
}

export interface ToolCall {
  // Provider-assigned id (Anthropic tool_use.id, OpenAI tool_calls[].id, etc.)
  // or runtime-generated id when synthesizing (MCP, replay, tests).
  id: string;
  // Tool name. Resolves to a ToolDefinition.
  name: string;
  // Parsed JSON arguments. Tools are responsible for validating their own
  // shape before use.
  arguments: unknown;
}

export interface ToolError {
  // Stable string code. Tools should pick from a small set per tool so the
  // LLM can react predictably (e.g., "ENOENT", "TIMEOUT", "PATH_ESCAPE").
  code: string;
  message: string;
}

export interface ToolResultMeta {
  duration_ms?: number;
  truncated?: boolean;
  bytes?: number;
  exit_code?: number;
  signal?: string;
}

export interface ToolResult {
  call_id: string;
  success: boolean;
  // Text the LLM will see as the tool's result. Always present. On failure
  // this is the error message in a form the LLM can react to.
  content: string;
  error?: ToolError;
  meta?: ToolResultMeta;
}

// A tool's executor function. Receives the parsed call and a sandbox context
// it cannot construct itself, returns a result. Never throws on tool-level
// errors; those become ToolResult with success: false.
export interface ToolExecutor {
  (call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult>;
}

// Concrete shape lives in src/sandbox/types.ts. Tools take this as their
// runtime context; they cannot construct one because SandboxContext has a
// private constructor and only the runner calls the underscored factory.
export type ToolExecutionContext = SandboxContext;
