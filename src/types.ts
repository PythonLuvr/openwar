// Public type surface for OpenWar runtime.
// Anything exported from src/index.ts ultimately roots here.

import type { ToolDefinition, ToolCall } from "./tools/types.js";

// Re-export tool shapes so consumers can pull everything from one place.
export type { ToolDefinition, ToolCall, ToolResult, ToolError, ToolResultMeta, ToolExecutor, JsonSchema, ToolOrigin } from "./tools/types.js";

export type ExecutionMode = "gated" | "auto";

export interface BriefFrontmatter {
  project: string;
  brief_id?: string;
  deadline?: string;
  scope_locked: boolean;
  mode?: ExecutionMode;
  authorized_costs: string[];
  // v0.3 additions. Optional; legacy briefs parse unchanged.
  workdir?: string;
  mcp_servers?: { name: string; command: string; cwd?: string }[];
}

export interface BriefSections {
  objective: string;
  deliverables: string;
  constraints: string;
  tools_required: string;
  notes: string;
  // Any additional headings the operator added.
  extra: Record<string, string>;
}

export interface Brief {
  frontmatter: BriefFrontmatter;
  sections: BriefSections;
  raw: string;
  source_path?: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

// ---------- Phase machine ----------

export type Phase = "intake" | "execute" | "blocker" | "destructive" | "completion" | "done";

export interface PhaseTransition {
  from: Phase;
  to: Phase;
  at: string; // ISO timestamp
  reason: string;
}

// ---------- Conversation ----------

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  at: string; // ISO timestamp
  // Optional metadata. Set by phase handlers, never by the adapter.
  meta?: {
    phase?: Phase;
    step_index?: number;
    detectors?: DetectorSnapshot;
  };
}

// ---------- Detectors ----------

export interface ConfirmationDetection {
  found: boolean;
  sections: {
    objective?: string;
    deliverables?: string;
    constraints?: string;
    tools_required?: string;
    unknowns?: string;
  };
  // Whether the model also asked the operator to pick a mode.
  asked_for_mode: boolean;
}

export interface BlockerDetection {
  blocked: boolean;
  reason: string | null;
  matched_pattern?: string;
}

export interface DestructiveDetection {
  destructive: boolean;
  action: string | null;
  // True when the brief's authorized_costs list covers this action.
  authorized: boolean;
  matched_pattern?: string;
}

export interface BannedPhraseDetection {
  count: number;
  phrases: string[];
}

export interface PhaseMarkerDetection {
  // Phases the model declared via explicit "Phase N" markers.
  declared: Phase[];
  // Last declared phase, if any.
  last?: Phase;
}

export interface CompletionDetection {
  complete: boolean;
  matched_pattern?: string;
}

export interface DetectorSnapshot {
  confirmation?: ConfirmationDetection;
  blocker?: BlockerDetection;
  destructive?: DestructiveDetection;
  banned_phrases?: BannedPhraseDetection;
  phase_marker?: PhaseMarkerDetection;
  completion?: CompletionDetection;
}

// ---------- Adapter contract ----------

export interface SendMessageOptions {
  system: string;
  messages: Message[];
  // Tool definitions the LLM may call this turn. Adapters translate to
  // their provider's function-calling schema.
  tools?: ToolDefinition[];
  // Prior-turn tool calls the assistant produced. Paired with prior_tool_results.
  // The adapter feeds these back to the LLM so it can react to results.
  prior_tool_calls?: ToolCall[];
  // Results from executing the prior_tool_calls. Same length, same call_ids.
  prior_tool_results?: ToolResultForRound[];
  // Streaming is required; non-streaming adapters wrap their final
  // response into a single done event.
  signal?: AbortSignal;
}

// Tool result shape passed back to the LLM for the next turn. Smaller surface
// than ToolResult (no meta), because the LLM only needs the text + error flag.
export interface ToolResultForRound {
  call_id: string;
  content: string;
  is_error?: boolean;
}

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  // Emitted incrementally as the LLM streams a tool call's JSON arguments.
  | { type: "tool_call_arg_delta"; tool_call_id: string; name: string; arg_delta: string }
  // Emitted once the tool call is fully assembled and ready to dispatch.
  | { type: "tool_call_complete"; call: ToolCall }
  | { type: "done"; message: string; tool_calls?: ToolCall[] }
  | { type: "error"; error: Error };

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent>;
}

export interface AdapterConfig {
  id: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  // Provider-specific overrides. Adapter is responsible for validating shape.
  extra?: Record<string, unknown>;
}

// ---------- Session state ----------

export interface SessionMeta {
  brief_id: string;
  project: string;
  started_at: string;
  updated_at: string;
  phase: Phase;
  mode: ExecutionMode | null;
  destructive_approvals: DestructiveApproval[];
  transitions: PhaseTransition[];
  // Schema version. v1 sessions (pre-0.3) omit this; treat as 1.
  schema_version?: number;
  // Session-wide approved auth categories from Phase 3 (operator pressed Y).
  session_approved_categories?: string[];
  // Persisted tool-call records. Each entry records call + result + decision.
  tool_calls?: ToolCallRecord[];
}

export interface ToolCallRecord {
  call_id: string;
  name: string;
  arguments: unknown;
  at: string; // ISO timestamp
  authorized: boolean;
  // Reason from auth check if denied (e.g., "missing: shell_exec").
  auth_note?: string;
  // Present when executed.
  result?: { success: boolean; content: string; meta?: unknown };
}

export interface DestructiveApproval {
  at: string;
  action: string;
  approved: boolean;
  // When set, this approval was for a tool call, and the listed auth
  // categories were promoted to session-wide approval. Otherwise this was
  // a one-shot approval (text-only destructive intent).
  session_categories?: string[];
}

export interface SessionState {
  meta: SessionMeta;
  brief: Brief;
  messages: Message[];
}

// ---------- Runner ----------

export interface RunOptions {
  briefPath?: string;
  briefSource?: string;
  adapter: AgentAdapter;
  mode?: ExecutionMode;
  // When true, runner emits machine-readable events on stdout instead of
  // human-readable prose. Used by integrators (War Room).
  json?: boolean;
  // When true, never persist to disk. Used for tests and headless calls.
  ephemeral?: boolean;
  // Override session id generation. Default: brief_id from frontmatter.
  sessionId?: string;
  // I/O abstractions. Default: console + stdin prompt.
  io?: RunnerIO;
  // Resume an existing session id if found.
  resume?: boolean;
  // Tool calling. Override the workdir for the session (defaults to cwd).
  workdir?: string;
  // When true, disable shell_exec for this session even if authorized.
  disableShell?: boolean;
  // Extra MCP server configs passed in addition to ~/.openwar/mcp.json
  // and brief.frontmatter.mcp_servers.
  mcpServers?: { name: string; command: string; cwd?: string }[];
  // Skip auto-registering native tools (tests / minimal runs).
  disableNativeTools?: boolean;
}

export interface RunResult {
  session_id: string;
  final_phase: Phase;
  completed: boolean;
  // True if execution ended because the runtime halted on a blocker or
  // unauthorized destructive action.
  halted: boolean;
  halt_reason?: string;
  messages: Message[];
}

export interface RunnerIO {
  // Print human-readable text. Called for streaming deltas and banners.
  write(text: string): void;
  // Print a banner / phase transition. Newlines bracketed automatically.
  banner(text: string): void;
  // Print a warning (banned phrases, soft issues). May style differently.
  warn(text: string): void;
  // Prompt operator for a line of input. Resolves with trimmed line.
  prompt(question: string): Promise<string>;
  // Yes/no helper. Returns true only on explicit affirmative.
  confirm(question: string): Promise<boolean>;
}
