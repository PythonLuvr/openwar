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
  // v0.6: when true, the runtime injects a structured summary of the
  // project's per-category memory (decisions, knowledge, constraints) into
  // the system prompt at session start, capped at 20 entries per category.
  // Default false to keep existing briefs token-cost-neutral.
  inherit_memory?: boolean;
  // v0.9.1: project slug whose learned.json profile should be loaded at
  // session start. Explicit only; the runner does NOT auto-discover a profile
  // from the project: field even if one exists on disk.
  learned_profile?: string;
  // v0.7: cli-bridge MCP-server-mode toggles. When the brief uses the
  // cli-bridge adapter, the runtime spawns an `openwar mcp-serve` child
  // alongside the bridged CLI so the CLI can call OpenWar's native tools
  // (read_project_memory, write_project_memory, the six filesystem /
  // shell / http tools) via MCP. mcp_forward defaults true; operators set
  // it false to fall back to v0.6 stdout-only cli-bridge.
  cli?: {
    mcp_forward?: boolean;
    // v0.7.2: when true, the runner does NOT touch the bridged CLI's user
    // settings file to pre-authorize OpenWar's MCP tools. Operators who
    // manage their Claude Code settings via dotfiles / Ansible / company
    // policy set this true; everyone else gets the default (auto-setup
    // on) so the bridged CLI doesn't halt at its own permission gate
    // on the first openwar tool call.
    skip_permission_setup?: boolean;
  };
  // v0.4 additions. Optional; omitted = single-agent mode (v0.3 behavior).
  roles?: string[];
  // v0.5.1: per-role adapter overrides. Populated when the brief uses the
  // object form of `roles:`. Keys are role ids; values pin which adapter
  // (and optional model + extras) that role uses. Roles absent from this
  // map fall back to the runtime's default adapter passed to run().
  role_adapters?: Record<string, RoleAdapterConfig>;
  budgets?: Partial<{
    max_tokens: number;
    max_wall_clock_minutes: number;
    max_tool_calls_per_subtask: number;
    max_retries_per_subtask: number;
  }>;
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

// The role on a chat turn. Renamed from `Role` in v0.4 because that name now
// belongs to the orchestration role system. `Role` remains as a back-compat
// alias for one minor cycle.
export type MessageRole = "system" | "user" | "assistant";
/** @deprecated Use MessageRole. Will be removed in a future minor. */
export type Role = MessageRole;

export interface Message {
  role: MessageRole;
  content: string;
  at: string; // ISO timestamp
  // Optional metadata. Set by phase handlers, never by the adapter.
  meta?: {
    phase?: Phase;
    step_index?: number;
    detectors?: DetectorSnapshot;
    // v0.4: which orchestration role produced this turn (planner/executor/...).
    // null on operator and intake turns.
    orch_role?: RoleId | null;
    // v0.4: sub-task id when this turn belongs to a coordinator sub-task.
    subtask_id?: string;
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
  | { type: "error"; error: Error }
  // v0.12.1: structured events from inside a bridged CLI's own run.
  // Squire's vendor-aware adapters (claude-code, gemini-cli) emit these;
  // OpenWar's translate layer in src/adapters/cli-bridge.ts maps them to
  // these `bridged_` prefixed StreamEvent variants. The prefix is
  // load-bearing: it signals "this came from inside a bridged CLI's own
  // run" and disambiguates from OpenWar's own native-tool dispatch
  // events above. Field naming is snake_case (OpenWar convention);
  // Squire's camelCase shapes are translated at the cli-bridge boundary.
  | { type: "bridged_tool_call"; call_id: string; tool_name: string; arguments: unknown; binary: string }
  | { type: "bridged_tool_result"; call_id: string; result: unknown; is_error: boolean; binary: string }
  | { type: "bridged_thinking_delta"; delta: string; binary: string }
  | {
      type: "bridged_usage";
      binary: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    };

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

// v0.5.1: per-role adapter override carried in BriefFrontmatter.role_adapters.
// `adapter` names a registered AdapterId. Any other keys are passed through to
// AdapterConfig.extra at adapter construction (e.g. `binary` and `tier` for
// cli-bridge, `base_url` for openai-compat). `model` is a first-class field.
export interface RoleAdapterConfig {
  adapter: string;
  model?: string;
  // Anything else (binary, tier, base_url, args, timeout_ms, ...) gets
  // forwarded into AdapterConfig.extra at construction time.
  [key: string]: unknown;
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
  // v0.4: CLI override of the brief's roles list. `[]` forces single-agent
  // mode even if the brief opted into multi-agent (--single flag).
  runtimeRoles?: string[];
  // v0.4: CLI override of the brief's budgets. Partial; only specified
  // fields override.
  runtimeBudgets?: Partial<{
    max_tokens: number;
    max_wall_clock_minutes: number;
    max_tool_calls_per_subtask: number;
    max_retries_per_subtask: number;
  }>;
  // v0.10.0: chat-session id when this run was kicked off from `openwar
  // chat`. Stamped into the trace via a chat_session_compiled event so
  // `openwar inspect` can show the originating chat. Undefined for runs
  // launched via `openwar run` directly.
  chatId?: string;
  // v0.11.1: caller-provided abort signal. When fired, the runner cancels
  // the in-flight tool call at the next dispatch boundary, surfaces a
  // structured tool-result with status="cancelled" to the model, emits a
  // `tool_cancelled` trace event, and lets the phase machine continue.
  // The signal does NOT abort the entire run; programs that want full
  // shutdown should also stop calling Session.continue() afterward.
  signal?: AbortSignal;
  // v0.11.1: callback invoked synchronously once the runner has constructed
  // the live Session handle, before the phase machine starts. Callers that
  // want to drive cancellation programmatically (chat REPL, integrators)
  // stash the handle here and call `session.cancelCurrentToolCall()` from
  // their own keypress / signal / RPC layer. Omitted callers see no
  // behavior change.
  onSession?: (session: Session) => void;
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

// ---------- v0.11.1 cancellation surface ----------
//
// `SessionEvent` is the live observation surface for runtime events that
// integrators (chat REPL, War Room, external programs) care about during an
// active session. v0.11.1 introduces it with a single variant; future minor
// releases extend the union without breaking. Distinct from `TraceEvent`
// (persisted to disk) and `CoordinatorEvent` (multi-agent only).

export type CancellationSource = "operator_signal" | "timeout" | "runtime_shutdown";

export interface ToolCancellation {
  call_id: string;
  tool_name: string;
  cancellation_source: CancellationSource;
  // What the tool produced before the abort. Empty for tools that buffer
  // output until completion (e.g., apply_patch). Streaming tools (e.g.,
  // shell_exec) report the bytes that arrived before the cancel fired.
  partial_output: string;
  at: string;
}

export type SessionEvent =
  | { type: "tool_cancelled"; payload: ToolCancellation }
  // v0.12.0: PermissionBridge lifecycle events. Mirror the trace-event
  // variants of the same names so live consumers can observe grants
  // without parsing the on-disk trace.
  | { type: "permission_requested"; payload: PermissionRequest }
  | { type: "permission_granted"; payload: PermissionGrantOutcome }
  | { type: "permission_denied"; payload: PermissionDenialOutcome }
  | { type: "permission_grant_consumed"; payload: { grant_id: string; consuming_tool_call_id: string; at: string } }
  | { type: "permission_revoked"; payload: { grant_id: string; revoked_at: string } };

// ---------- v0.12.0 PermissionBridge surface ----------
//
// Bridged CLIs (and any tool-calling adapter) call `request_permission`
// before attempting a potentially-destructive action. The runtime routes
// the request to the operator, captures the answer, and records a grant in
// the per-session GrantLedger. Phase 3 honors matching grants instead of
// firing the operator prompt again. See docs/permissions.md for the full
// semantics.

export type PermissionScope = "this_call" | "this_session" | "persistent";

export interface PermissionRequest {
  grant_id: string;
  action: string;
  category: string | null;
  scope_requested: PermissionScope;
  reasoning: string;
  fallback: string | null;
  at: string;
}

export interface PermissionGrantOutcome {
  grant_id: string;
  scope_granted: PermissionScope;
  operator_note: string;
  at: string;
}

export interface PermissionDenialOutcome {
  grant_id: string;
  operator_note: string;
  at: string;
}

export interface Grant {
  grant_id: string;
  action: string;
  category: string | null;
  scope: PermissionScope;
  reasoning: string;
  granted_at: string;
  // True once a `this_call` grant has been used. `this_session` and
  // `persistent` grants stay consumed=false until revoked.
  consumed: boolean;
  // True once revoked. Revoked grants no longer match.
  revoked?: boolean;
}

// A live handle on an active run. Returned alongside `RunResult` for callers
// that need to interact with a run in progress (most often: cancel an
// in-flight tool call from a separate keystroke handler). Most callers of
// `run()` will not need this; the chat REPL is the primary consumer.
export interface Session {
  // Cancel the in-flight tool call, if any. Resolves true once the tool has
  // fully aborted (subprocess exited, fetch rejected, partial-write rolled
  // back). Resolves false synchronously if no tool call is currently active.
  // Safe to call repeatedly; subsequent calls with no active call no-op.
  cancelCurrentToolCall(): Promise<boolean>;
  // v0.12.0: read the active grant ledger. Returns a snapshot; mutations
  // (addGrant / consume / revoke) go through other surfaces (the
  // request_permission tool, Phase 3, revokeGrant below).
  listActiveGrants(): readonly Grant[];
  // v0.12.0: revoke a grant by id. Returns true if the grant existed and
  // was active (not already revoked); false otherwise. Revocation is
  // permanent for the rest of the session; persistent grants are also
  // marked revoked in the on-disk store.
  revokeGrant(grant_id: string): boolean;
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

// ===========================================================================
// v0.4 Multi-agent orchestration
// ===========================================================================
//
// Single-agent mode (v0.3) corresponds to `roles: []` in a brief; the runner
// short-circuits the coordinator and runs the existing phase loop. Anything
// else routes through the coordinator FSM in src/coordinator/.

// ---------- Roles ----------

// Built-in role ids. Custom roles register additional ids via
// `registerRole()` from src/roles/registry.ts. The string is the canonical
// identifier the coordinator dispatches by.
export type BuiltInRoleId = "planner" | "executor" | "reviewer" | "critic";
// Open-ended at runtime; `BuiltInRoleId | string` collapses to `string` in
// TypeScript, so we widen explicitly.
export type RoleId = string;

// A role definition is a static description of how to instantiate one
// instance of the role. The dynamic per-call data lives in `RoleContext`.
export interface RoleDefinition {
  id: RoleId;
  // One-line description shown by `openwar roles`.
  description: string;
  // System-prompt overlay appended to the framework + brief. The overlay
  // never overrides the framework's hard rules; it adds scope on top.
  prompt_overlay: string;
  // Auth categories this role is allowed to request via tool calls. The
  // coordinator enforces this at dispatch time: a role attempting a tool
  // outside its allowlist halts the coordinator with a structured error,
  // not a Phase 3 prompt. The auth-categories `"*"` wildcard is honored.
  tool_categories: string[];
  // If true the role is allowed to call read_file (and similar read-only
  // native tools). Independent from tool_categories so a role can have
  // `tool_categories: []` but still verify executor claims.
  allow_read_file?: boolean;
}

// Context the coordinator passes to a role when invoking it.
export interface RoleContext {
  brief: Brief;
  // The role's accumulating message history for this run. Distinct from
  // the session's global transcript; each role sees only what the
  // coordinator has handed it.
  history: Message[];
  // Per-sub-task data populated when the role is mid-sub-task (executor,
  // reviewer, critic). Null for the planner.
  subtask: SubTask | null;
  // Reviewer/critic also receive the executor's handoff to review.
  execution_handoff?: ExecutionHandoff;
  // Adapter used for all role calls. Coordinator owns the choice.
  adapter: AgentAdapter;
  // System prompt assembled by the prompt-overlay layer.
  system: string;
  io: RunnerIO;
  signal?: AbortSignal;
  // Optional: tools + executors + sandbox. Only populated for roles that
  // need them (executor, reviewer when allow_read_file is true).
  toolDefinitions?: ToolDefinition[];
  toolExecutors?: Map<string, import("./tools/types.js").ToolExecutor>;
  sandbox?: import("./sandbox/types.js").SandboxContext;
  // Approval bookkeeping shared across roles within one coordinator run.
  sessionApproved?: string[];
}

// What a role returns to the coordinator. Different role types fill in
// different optional fields.
export interface RoleResult {
  role: RoleId;
  // The role's final assistant turn (raw text).
  text: string;
  // Updated history including the role's own turns.
  history: Message[];
  // One of these will be populated based on the role type.
  plan?: PlanHandoff;
  execution?: ExecutionHandoff;
  review?: ReviewHandoff;
  escalation?: EscalationHandoff;
  // True when the role declared a blocker.
  blocked?: boolean;
  blocker_reason?: string;
  // Cost contribution for this role invocation.
  cost?: RoleCost;
}

export interface RoleCost {
  tokens_used: number;
  tool_calls: number;
  wall_clock_ms: number;
}

// ---------- Coordinator state ----------

export type CoordinatorState =
  | "init"
  | "plan"
  | "dispatch"
  | "execute"
  | "review_step"
  | "next_subtask"
  | "retry"
  | "block"
  | "escalate"
  | "complete";

export interface SubTask {
  id: string;
  // Human-readable title, used in banners and operator prompts.
  title: string;
  // Free-form instruction to the executor. The coordinator wraps this in a
  // sub-brief shape before dispatch.
  instruction: string;
  // Quality bar the reviewer evaluates against. Sourced from the planner.
  acceptance_criteria: string[];
  // Linear ordering. v0.4 supports sequential only; non-linear plans get
  // rejected by the plan parser.
  order: number;
  // Optional explicit dependencies on prior sub-task ids. v0.4 only allows
  // dependencies on the immediately preceding sub-task (or none).
  depends_on?: string[];
}

export type SubTaskStatus =
  | "pending"
  | "executing"
  | "reviewing"
  | "passed"
  | "failed"
  | "retrying"
  | "escalated"
  | "skipped";

export interface SubTaskState {
  id: string;
  status: SubTaskStatus;
  attempts: number;
  last_handoff?: ExecutionHandoff;
  last_review?: ReviewHandoff;
  // Set when status becomes "escalated".
  escalation?: EscalationHandoff;
  started_at?: string;
  finished_at?: string;
}

// Coordinator-emitted event for UI/logging. Pure data; no IO.
export type CoordinatorEvent =
  | { type: "state_enter"; state: CoordinatorState; at: string; subtask_id?: string }
  | { type: "role_invoked"; role: RoleId; subtask_id?: string; at: string }
  | { type: "subtask_result"; subtask_id: string; status: SubTaskStatus; at: string }
  | { type: "budget_warn"; metric: "tokens" | "wall_clock_ms" | "tool_calls"; used: number; limit: number }
  | { type: "budget_halt"; metric: "tokens" | "wall_clock_ms" | "tool_calls"; used: number; limit: number; at: string }
  | { type: "escalated"; subtask_id: string; reason: string; at: string };

// ---------- Plan ----------

// The plan as the coordinator persists it. The planner produces a `PlanHandoff`
// which contains exactly this plus a rationale string.
export interface PlanNode {
  subtasks: SubTask[];
  created_at: string;
  // Planner's text rationale for the decomposition. Surfaced in `openwar plan`.
  rationale: string;
}

// ---------- Handoffs ----------

// Every cross-role communication uses one of these typed shapes. Roles emit
// them inside a fenced JSON block; the coordinator parses, validates with the
// schema in src/orchestration/handoff.ts, and rejects on malformed.

export interface PlanHandoff {
  kind: "plan";
  subtasks: SubTask[];
  rationale: string;
}

export interface ExecutionHandoff {
  kind: "execution";
  subtask_id: string;
  // What the executor produced. Free-form text the reviewer evaluates.
  output: string;
  // Records of every tool call made during execution. Used by the reviewer
  // to verify claims.
  tool_calls: ToolCallRecord[];
  // Executor's own narrative about what it did. Separate from `output`.
  notes: string;
}

export interface ReviewHandoff {
  kind: "review";
  subtask_id: string;
  verdict: "pass" | "fail" | "needs_retry";
  rationale: string;
  // Reviewer's suggested edit, used only when verdict === "needs_retry".
  suggested_revision?: string;
}

export interface EscalationHandoff {
  kind: "escalation";
  severity: "info" | "warn" | "error";
  role: RoleId;
  reason: string;
  // Free-form context the operator may need to make the call.
  context: string;
  // When escalation came from a budget overrun, this names the metric.
  budget_metric?: "tokens" | "wall_clock_ms" | "tool_calls";
}

// ---------- Budgets ----------

export interface Budgets {
  max_tokens: number;
  max_wall_clock_minutes: number;
  max_tool_calls_per_subtask: number;
  max_retries_per_subtask: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  max_tokens: 50_000,
  max_wall_clock_minutes: 20,
  max_tool_calls_per_subtask: 15,
  max_retries_per_subtask: 3,
};

// ---------- Cost tracker ----------

export interface CostUsage {
  tokens_used: number;
  wall_clock_ms: number;
  tool_calls: number;
  // Per-sub-task tool-call count, indexed by subtask_id.
  tool_calls_by_subtask: Record<string, number>;
  started_at: string;
  // v0.12.1: bridged-CLI token attribution. Input + output flow into
  // tokens_used like everything else (budget-relevant). Cache reads/writes
  // are recorded here separately for visibility but do NOT inflate
  // tokens_used: cache reads bill at a fraction of normal rates and
  // including them would trip budget gates prematurely. Optional so older
  // serialized sessions still deserialize cleanly.
  bridged_tokens_input?: number;
  bridged_tokens_output?: number;
  bridged_tokens_cache_read?: number;
  bridged_tokens_cache_write?: number;
}

// ---------- Coordinator session extensions (schema v3) ----------

// Per-role conversation history. Each role keeps its own thread; the
// coordinator merges into the session's primary transcript for inspection,
// but role dispatch always uses the role-local history.
export type RoleTranscripts = Record<RoleId, Message[]>;

// New SessionMeta fields layered on for schema v3. Optional everywhere for
// back-compat: a v2 session loads as v3 with these missing/empty.
export interface SessionMetaV3 extends SessionMeta {
  coordinator_state?: CoordinatorState;
  // The planner output the coordinator is executing against.
  plan?: PlanNode | null;
  // Per-sub-task state. Keyed by SubTask.id.
  subtask_states?: Record<string, SubTaskState>;
  // Per-role conversation histories.
  role_transcripts?: RoleTranscripts;
  // Cost ledger.
  cost?: CostUsage;
  // Active roles for the run. Empty = single-agent mode.
  active_roles?: RoleId[];
  // Budgets resolved at run start (defaults + brief overrides).
  budgets?: Budgets;
  // Coordinator-emitted events. Append-only.
  coordinator_events?: CoordinatorEvent[];
}
