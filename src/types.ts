// Public type surface for OpenWar runtime.
// Anything exported from src/index.ts ultimately roots here.

export type ExecutionMode = "gated" | "auto";

export interface BriefFrontmatter {
  project: string;
  brief_id?: string;
  deadline?: string;
  scope_locked: boolean;
  mode?: ExecutionMode;
  authorized_costs: string[];
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
  // Streaming is required; non-streaming adapters wrap their final
  // response into a single done event.
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; message: string }
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
}

export interface DestructiveApproval {
  at: string;
  action: string;
  approved: boolean;
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
