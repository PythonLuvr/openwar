// v0.13.0: shared types for the openwar serve --openai-compat proxy.

export interface ServeOptions {
  // Proxy mode. v0.13.0 ships only openai-compat; the flag exists so
  // future modes (raw MCP, native OpenWar API) can slot alongside.
  openaiCompat: boolean;
  // Bind host. Defaults to 127.0.0.1; setting to 0.0.0.0 warns at start.
  bind: string;
  // Bind port. Default 1234 (LM Studio convention; friendly to existing
  // local-tool habits per Phase 0 Q10).
  port: number;
  // Bearer-token clients must present in Authorization: Bearer <token>.
  // Required unless `noAuth` is true; refused-to-start otherwise.
  authToken: string | null;
  // Opt-out for local development. Warns at startup every time.
  noAuth: boolean;
  // Which adapter handles the actual completion. Defaults to OpenWar's
  // standard auto-detection (first BYOK env var found at start).
  upstreamAdapter: string | null;
  // Default upstream model passed when the client requests one the
  // upstream does not recognize. Q1 ruling: substitution is recorded
  // via proxy_request.model_substituted_from rather than a separate
  // trace event.
  upstreamModel: string | null;
  // Working directory the synthesized brief runs in. Defaults to cwd.
  workdir: string;
  // authorized_costs categories the synthesized brief carries. Defaults
  // to conservative ["filesystem_read"] per the brief. Operators expand
  // explicitly. v0.13.0 startup banner explains the expansion pattern.
  authorizedCosts: string[];
  // Max concurrent in-flight requests. Defaults to 4. Excess returns
  // 429 in OpenAI's rate_limit_error shape.
  maxConcurrent: number;
  // Per-request access logging. Single line on stderr.
  logRequests: boolean;
}

// OpenAI Chat Completions request shape, narrowed to the v0.13.0 surface.
// Out of scope (deferred or never): legacy `prompt`, vision, embeddings,
// Assistants API, WebSocket realtime, custom tool_choice variants beyond
// auto/none/required. v0.13.1 brings the `tools` field surface alive.

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  // v0.13.0 acknowledges tools at the type level but does NOT execute
  // them yet (tool-call translation lands in v0.13.1). A request that
  // includes a non-empty `tools` array still runs; the proxy just
  // surfaces the count in the proxy_request trace and otherwise
  // ignores the tool definitions for v0.13.0.
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  // Allow extra fields the client may send (top_p, presence_penalty,
  // frequency_penalty, response_format, ...). Stored but not honored
  // in v0.13.0; included so request parsing does not reject them.
  [k: string]: unknown;
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer";
  content: string | null;
  name?: string;
  tool_calls?: OpenAIAssistantToolCall[];
  tool_call_id?: string;
}

export interface OpenAIAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

// Non-streaming response shape. Streaming wraps a similar payload in SSE
// chunks (see openai-streaming.ts).
export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAIAssistantToolCall[] };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string | null;
  };
}
