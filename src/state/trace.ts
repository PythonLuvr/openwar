// v0.8: structured trace event stream. One JSONL file per session, written
// alongside the existing transcript. The trace is the contract v0.9 adaptive
// autonomy will read; schema is versioned via a header event so v0.8.x can
// add fields without silently breaking replay.
//
// Atomicity model: append-only with fs.appendFileSync per event. Matches the
// transcript writer; same invariant ("any complete line is a complete event").
// We do NOT tmp+rename per append; that scales O(N^2) for high-frequency
// trace streams, which is the whole shape of this file.
//
// Errors during emit are swallowed (writes to stderr exactly once per session)
// so observability bugs never crash the run. Set OPENWAR_TRACE_STRICT=1 in
// tests to flip this to throw-on-error.

import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { traceFile, sessionsDir } from "./paths.js";
import type { Phase, RoleId, CoordinatorState, SubTaskStatus } from "../types.js";

// v0.11.1 bumps to 2 for the additive `tool_cancelled` event type.
// v0.12.0 bumps to 3 for the additive `permission_*` event types.
// v0.12.1 bumps to 4 for the additive `bridged_*` event types (cli-bridge
// structured-event capture from Squire's vendor-aware adapters).
// v0.13.0 bumps to 5 for the additive `proxy_*` event types
// (openwar serve --openai-compat per-request bookkeeping). Each bump is
// forward-compatible: readers that only know older event types skip
// unknown ones.
export const TRACE_SCHEMA_VERSION = 5;

export type TraceEvent =
  | { type: "trace_version"; version: number; openwar_version: string; brief_id: string; at: string }
  | { type: "phase_enter"; phase: Phase; at: string }
  | { type: "phase_exit"; phase: Phase; duration_ms: number; at: string }
  | { type: "detector_fired"; detector: string; payload: unknown; at: string }
  | { type: "tool_call"; call_id: string; name: string; args: unknown; auth_decision: string; at: string }
  | { type: "tool_result"; call_id: string; success: boolean; duration_ms: number; bytes: number; at: string }
  | { type: "auth_prompt"; categories: string[]; response: "y" | "Y" | "n"; at: string }
  | { type: "auth_check_fired"; layer: "openwar" | "bridged_cli" | "session_approval"; tool: string; decision: "allow" | "deny"; reason: string; at: string }
  | { type: "role_invoke"; role: RoleId; tokens_in: number; tokens_out: number; tokens_source: "reported" | "estimated"; duration_ms: number; at: string }
  | { type: "budget_warn"; metric: string; used: number; limit: number; at: string }
  | { type: "budget_halt"; metric: string; used: number; limit: number; at: string }
  | { type: "subtask_status"; subtask_id: string; status: SubTaskStatus; at: string }
  | { type: "coordinator_state"; state: CoordinatorState; at: string }
  | { type: "mcp_server_started"; transport: string; tool_count: number; at: string }
  | { type: "mcp_server_shutdown"; reason: string; at: string }
  | { type: "mcp_call_dispatched"; call_id: string; tool: string; args_summary: string; at: string }
  | { type: "mcp_call_completed"; call_id: string; tool: string; duration_ms: number; success: boolean; at: string }
  | { type: "mcp_call_pending"; call_id: string; tool: string; elapsed_ms: number; at: string }
  | { type: "settings_merge_attempted"; binary: string; settings_path: string; at: string }
  | { type: "settings_merge_outcome"; outcome: "success" | "parse_error" | "write_error" | "read_error"; details: string; at: string }
  // v0.9.1: learned-profile lifecycle. Emitted once per session when a brief's
  // learned_profile loads, then per detector/budget consult so the operator
  // can audit exactly which adjustments fired.
  | { type: "learned_profile_applied"; at: string; slug: string; schema_version: number; applied: { detectors: number; phase_budgets: number; tool_callouts: number } }
  | { type: "learned_sensitivity_consulted"; at: string; detector: string; sensitivity: "default" | "loose" | "strict" | "disabled"; fired: boolean }
  | { type: "learned_budget_consulted"; at: string; phase: string; recommended: number; active: number; source: "learned" | "brief" | "default" }
  // v0.10.0: chat-originated runs. Emitted into the brief's trace when the
  // run was kicked off from `openwar chat`, so `openwar inspect` can show
  // "this run came from chat session X". chat_session_resumed +
  // chat_brief_saved primarily live in the chat-store NDJSON (separate from
  // the per-brief trace); they are defined here so library consumers can
  // ingest both streams against one type union.
  | { type: "chat_session_compiled"; at: string; chat_id: string; brief_id: string }
  | { type: "chat_session_resumed"; at: string; chat_id: string }
  | { type: "chat_brief_saved"; at: string; chat_id: string; path: string }
  // v0.11.1: tool-call cancellation. Emitted when an in-flight tool call is
  // aborted by the operator (chat REPL ctrl-c, programmatic
  // Session.cancelCurrentToolCall, or a caller-provided RunOptions.signal),
  // a runtime timeout, or session shutdown. `partial_output` carries
  // whatever the tool produced before the abort; tools that buffer their
  // entire output until completion report an empty string. The companion
  // `tool_result` event is NOT emitted for a cancelled call; the model
  // receives a structured tool-result with status="cancelled" via the
  // normal prior_tool_results channel.
  | {
      type: "tool_cancelled";
      call_id: string;
      tool_name: string;
      cancellation_source: "operator_signal" | "timeout" | "runtime_shutdown";
      partial_output: string;
      at: string;
    }
  // v0.12.0: PermissionBridge lifecycle. Emitted by the request_permission
  // tool (requested / granted / denied), by Phase 3 when an active grant
  // covers a destructive call (grant_consumed), and by the runtime when an
  // operator revokes a grant (revoked). See docs/permissions.md.
  | {
      type: "permission_requested";
      grant_id: string;
      action: string;
      category: string | null;
      scope_requested: "this_call" | "this_session" | "persistent";
      reasoning: string;
      fallback: string | null;
      at: string;
    }
  | {
      type: "permission_granted";
      grant_id: string;
      scope_granted: "this_call" | "this_session" | "persistent";
      operator_note: string;
      at: string;
    }
  | {
      type: "permission_denied";
      grant_id: string;
      operator_note: string;
      at: string;
    }
  | {
      type: "permission_grant_consumed";
      grant_id: string;
      consuming_tool_call_id: string;
      at: string;
    }
  | {
      type: "permission_revoked";
      grant_id: string;
      revoked_at: string;
    }
  // v0.12.1: structured events captured from inside a bridged CLI's own
  // run. Squire's vendor-aware adapters emit `tool_call`, `tool_result`,
  // `thinking_delta`, and `usage` from formats like Claude Code's
  // stream-json output; the cli-bridge adapter translates them to these
  // `bridged_*` trace variants. Distinct from the existing native-tool
  // `tool_call` / `tool_result` events, which capture OpenWar's runtime
  // dispatching its own tools to the streaming LLM. `binary` names the
  // CLI that emitted the event (e.g. "claude", "gemini").
  | {
      type: "bridged_tool_call";
      call_id: string;
      tool_name: string;
      arguments: unknown;
      binary: string;
      at: string;
    }
  | {
      type: "bridged_tool_result";
      call_id: string;
      result: unknown;
      is_error: boolean;
      binary: string;
      at: string;
    }
  | {
      type: "bridged_thinking_delta";
      delta: string;
      binary: string;
      at: string;
    }
  // v0.12.1 also emits bridged_usage to the trace (in addition to feeding
  // the cost ledger when one exists) so single-agent cli-bridge runs
  // without a coordinator don't lose usage observability. Cache fields
  // are recorded separately from input/output for visibility; the cost
  // ledger only counts input + output toward `tokens_used`.
  | {
      type: "bridged_usage";
      binary: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      at: string;
    }
  // v0.13.0: openwar serve --openai-compat per-request bookkeeping.
  // proxy_request stamps the start of a synthesized-brief run that came
  // in over the HTTP proxy; proxy_response stamps the end. Optional
  // `model_substituted_from` records when the client's requested model
  // did not match the configured upstream and the proxy fell back to
  // `--upstream-model` (Phase 0 Q1: folded into proxy_request rather
  // than a separate proxy_model_substituted event for trace surface
  // compactness).
  | {
      type: "proxy_request";
      request_id: string;
      client_addr: string;
      model: string;
      stream: boolean;
      tool_count: number;
      model_substituted_from?: string;
      at: string;
    }
  | {
      type: "proxy_response";
      request_id: string;
      status_code: number;
      duration_ms: number;
      bytes_written: number;
      cancelled: boolean;
      at: string;
    }
  | { type: "error"; error: string; phase: Phase; at: string };

export type TraceEventType = TraceEvent["type"];

export interface TracerOptions {
  briefId: string;
  // When false, all emits are no-ops. Used for ephemeral / test runs.
  enabled: boolean;
  openwarVersion: string;
  // Override the default file path. Used for tests; production passes nothing
  // and the path is derived from briefId via traceFile().
  filePath?: string;
}

export class Tracer {
  readonly briefId: string;
  readonly enabled: boolean;
  readonly filePath: string;
  private headerWritten = false;
  private warned = false;

  constructor(opts: TracerOptions) {
    this.briefId = opts.briefId;
    this.enabled = opts.enabled;
    this.filePath = opts.filePath ?? traceFile(opts.briefId);
    if (this.enabled) this.ensureHeader(opts.openwarVersion);
  }

  private ensureHeader(openwarVersion: string): void {
    if (this.headerWritten) return;
    try {
      if (existsSync(this.filePath)) {
        this.headerWritten = true;
        return;
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch (err) {
      // Header-path setup failed (parent isn't a dir, perms, etc). Defer to
      // writeLine, which routes through the same swallow/strict gate as
      // ordinary emits. The trace file just won't be created (the run
      // proceeds unaffected).
      if (process.env.OPENWAR_TRACE_STRICT === "1") throw err;
      this.headerWritten = true; // don't re-attempt every emit
      this.warned = true;
      try {
        process.stderr.write(
          `openwar: trace setup failed (${(err as Error).message}); trace disabled for this session.\n`,
        );
      } catch {
        /* ignore */
      }
      return;
    }
    const header: TraceEvent = {
      type: "trace_version",
      version: TRACE_SCHEMA_VERSION,
      openwar_version: openwarVersion,
      brief_id: this.briefId,
      at: new Date().toISOString(),
    };
    this.writeLine(header);
    this.headerWritten = true;
  }

  emit(event: TraceEvent): void {
    if (!this.enabled) return;
    this.writeLine(event);
  }

  private writeLine(event: TraceEvent): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      if (process.env.OPENWAR_TRACE_STRICT === "1") throw err;
      if (!this.warned) {
        this.warned = true;
        try {
          process.stderr.write(
            `openwar: trace emit failed (${(err as Error).message}); further failures suppressed.\n`,
          );
        } catch {
          /* nothing left to do */
        }
      }
    }
  }
}

// Convenience factory: a tracer that drops everything on the floor. Cheaper
// than threading optional<Tracer> through every call site.
export function nullTracer(): Tracer {
  return new Tracer({
    briefId: "null",
    enabled: false,
    openwarVersion: "0.0.0",
  });
}

export interface ReadTraceOptions {
  // When provided, only read this many lines from the tail. Default reads all.
  tail?: number;
  // Filter by event type at parse time. Useful for the focused inspect modes.
  type?: TraceEventType | readonly TraceEventType[];
}

export interface ReadTraceResult {
  events: TraceEvent[];
  corrupted_lines: number[];
  // True when the file exists but is empty / header-less. Inspect uses this to
  // route to transcript-only fallback.
  empty: boolean;
}

export function readTrace(briefId: string, opts: ReadTraceOptions = {}): ReadTraceResult {
  return readTraceFromPath(traceFile(briefId), opts);
}

export function readTraceFromPath(path: string, opts: ReadTraceOptions = {}): ReadTraceResult {
  if (!existsSync(path)) return { events: [], corrupted_lines: [], empty: true };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  // Strip trailing empty line (always present from final "\n").
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return { events: [], corrupted_lines: [], empty: true };

  const types = opts.type
    ? new Set(Array.isArray(opts.type) ? opts.type : [opts.type])
    : null;

  const events: TraceEvent[] = [];
  const corrupted_lines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as TraceEvent;
      if (types && !types.has(parsed.type)) continue;
      events.push(parsed);
    } catch {
      corrupted_lines.push(i + 1);
    }
  }

  if (opts.tail && opts.tail > 0 && events.length > opts.tail) {
    return { events: events.slice(-opts.tail), corrupted_lines, empty: false };
  }
  return { events, corrupted_lines, empty: false };
}

// Aggregator helpers consumed by the inspect formatters and the dashboard.
// Pure functions over a trace event list; no I/O. Kept here so the formatters
// and the dashboard share a single source of truth.

export interface PhaseTimingRow {
  phase: Phase;
  duration_ms: number;
  enters: number;
}

export function aggregatePhaseTimings(events: TraceEvent[]): PhaseTimingRow[] {
  const rows = new Map<Phase, PhaseTimingRow>();
  for (const ev of events) {
    if (ev.type === "phase_enter") {
      const r = rows.get(ev.phase) ?? { phase: ev.phase, duration_ms: 0, enters: 0 };
      r.enters++;
      rows.set(ev.phase, r);
    } else if (ev.type === "phase_exit") {
      const r = rows.get(ev.phase) ?? { phase: ev.phase, duration_ms: 0, enters: 0 };
      r.duration_ms += ev.duration_ms;
      rows.set(ev.phase, r);
    }
  }
  return Array.from(rows.values());
}

export interface RoleCostRow {
  role: RoleId;
  invocations: number;
  tokens_in: number;
  tokens_out: number;
  tokens_source: "reported" | "estimated" | "mixed";
  duration_ms: number;
}

export function aggregateRoleCost(events: TraceEvent[]): RoleCostRow[] {
  const rows = new Map<RoleId, RoleCostRow>();
  for (const ev of events) {
    if (ev.type !== "role_invoke") continue;
    const existing = rows.get(ev.role);
    if (!existing) {
      rows.set(ev.role, {
        role: ev.role,
        invocations: 1,
        tokens_in: ev.tokens_in,
        tokens_out: ev.tokens_out,
        tokens_source: ev.tokens_source,
        duration_ms: ev.duration_ms,
      });
      continue;
    }
    existing.invocations++;
    existing.tokens_in += ev.tokens_in;
    existing.tokens_out += ev.tokens_out;
    existing.duration_ms += ev.duration_ms;
    if (existing.tokens_source !== ev.tokens_source) existing.tokens_source = "mixed";
  }
  return Array.from(rows.values());
}

export interface DetectorCountRow {
  detector: string;
  count: number;
}

export function aggregateDetectorCounts(events: TraceEvent[]): DetectorCountRow[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== "detector_fired") continue;
    counts.set(ev.detector, (counts.get(ev.detector) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([detector, count]) => ({ detector, count }))
    .sort((a, b) => b.count - a.count);
}

// Re-exported for callers that need to list session files without importing
// state/paths directly. Used by the dashboard's session-list view.
export { sessionsDir };
