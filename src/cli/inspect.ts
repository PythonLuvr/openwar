// v0.8: focused inspect formatters. Each takes a trace event list and returns
// a string view. The dashboard reuses the same formatters by wrapping their
// output in HTML tables (single source of truth for the on-disk and web view).
//
// All formatters are pure: trace events in, text out. No I/O. Test-friendly
// and replaceable.

import type { TraceEvent } from "../state/trace.js";
import {
  aggregatePhaseTimings,
  aggregateRoleCost,
  aggregateDetectorCounts,
} from "../state/trace.js";

// Stable column-width table builder used by all the focused modes. Centralized
// so the docs section "Inspect output column shape" has a single anchor.
export function table(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const r of rows) {
      const c = r[i] ?? "";
      if (c.length > w) w = c.length;
    }
    return w;
  });
  const renderRow = (cells: readonly string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const out: string[] = [];
  out.push(renderRow(headers));
  out.push(sep);
  for (const r of rows) out.push(renderRow(r));
  return out.join("\n");
}

// --- Trace mode: raw event dump in time order. ---

export interface TraceFormatterOptions {
  tail?: number;     // print only the last N events
  full?: boolean;    // override the default tail-style pager
}

const DEFAULT_TAIL = 100;

export function formatTrace(events: readonly TraceEvent[], opts: TraceFormatterOptions = {}): string {
  let toShow: readonly TraceEvent[] = events;
  if (!opts.full) {
    const tail = opts.tail ?? DEFAULT_TAIL;
    if (events.length > tail) toShow = events.slice(-tail);
  }
  const lines: string[] = [];
  if (!opts.full && events.length > toShow.length) {
    lines.push(`(showing last ${toShow.length} of ${events.length} events; use --full or --tail N to widen)`);
  }
  for (const ev of toShow) {
    lines.push(formatEventLine(ev));
  }
  return lines.join("\n");
}

function formatEventLine(ev: TraceEvent): string {
  const at = "at" in ev ? ev.at : "";
  switch (ev.type) {
    case "trace_version":
      return `${at}  trace_version=${ev.version}  openwar=${ev.openwar_version}  brief=${ev.brief_id}`;
    case "phase_enter":
      return `${at}  phase_enter  ${ev.phase}`;
    case "phase_exit":
      return `${at}  phase_exit   ${ev.phase}  (${ev.duration_ms}ms)`;
    case "detector_fired":
      return `${at}  detector     ${ev.detector}`;
    case "tool_call":
      return `${at}  tool_call    ${ev.name}  (${ev.auth_decision})`;
    case "tool_result":
      return `${at}  tool_result  call=${ev.call_id}  ${ev.success ? "ok" : "err"}  ${ev.duration_ms}ms  ${ev.bytes}B`;
    case "auth_prompt":
      return `${at}  auth_prompt  [${ev.categories.join(",")}]  response=${ev.response}`;
    case "auth_check_fired":
      return `${at}  auth_check   ${ev.layer}/${ev.tool}  ${ev.decision}  (${ev.reason})`;
    case "role_invoke":
      return `${at}  role_invoke  ${ev.role}  in=${ev.tokens_in} out=${ev.tokens_out} (${ev.tokens_source})`;
    case "budget_warn":
      return `${at}  budget_warn  ${ev.metric}=${ev.used}/${ev.limit}`;
    case "budget_halt":
      return `${at}  budget_halt  ${ev.metric}=${ev.used}/${ev.limit}`;
    case "subtask_status":
      return `${at}  subtask      ${ev.subtask_id}  ${ev.status}`;
    case "coordinator_state":
      return `${at}  coord_state  ${ev.state}`;
    case "mcp_server_started":
      return `${at}  mcp_start    transport=${ev.transport}  tools=${ev.tool_count}`;
    case "mcp_server_shutdown":
      return `${at}  mcp_stop     reason=${ev.reason}`;
    case "mcp_call_dispatched":
      return `${at}  mcp_dispatch ${ev.tool}  call=${ev.call_id}`;
    case "mcp_call_pending":
      return `${at}  mcp_pending  ${ev.tool}  elapsed=${ev.elapsed_ms}ms`;
    case "mcp_call_completed":
      return `${at}  mcp_done     ${ev.tool}  ${ev.success ? "ok" : "err"}  ${ev.duration_ms}ms`;
    case "settings_merge_attempted":
      return `${at}  settings_try ${ev.binary}  path=${ev.settings_path}`;
    case "settings_merge_outcome":
      return `${at}  settings_end ${ev.outcome}  ${ev.details}`;
    case "learned_profile_applied":
      return `${at}  learn_apply  slug=${ev.slug}  schema=${ev.schema_version}  detectors=${ev.applied.detectors} budgets=${ev.applied.phase_budgets} dead=${ev.applied.tool_callouts}`;
    case "learned_sensitivity_consulted":
      return `${at}  learn_sens   ${ev.detector}=${ev.sensitivity}  fired=${ev.fired}`;
    case "learned_budget_consulted":
      return `${at}  learn_budg   ${ev.phase}  recommended=${ev.recommended} active=${ev.active} (${ev.source})`;
    case "chat_session_compiled":
      return `${at}  chat_compile chat=${ev.chat_id}  brief=${ev.brief_id}`;
    case "chat_session_resumed":
      return `${at}  chat_resume  chat=${ev.chat_id}`;
    case "chat_brief_saved":
      return `${at}  chat_saved   chat=${ev.chat_id}  path=${ev.path}`;
    case "error":
      return `${at}  ERROR        phase=${ev.phase}  ${ev.error}`;
    default: {
      // Exhaustiveness: union shrinks to never if all types handled.
      const _exhaustive: never = ev;
      void _exhaustive;
      return `${at}  unknown_event`;
    }
  }
}

// --- Timing mode: per-phase duration_ms and entry count. ---

export function formatTiming(events: readonly TraceEvent[]): string {
  const rows = aggregatePhaseTimings(events as TraceEvent[]);
  if (rows.length === 0) return "(no phase enter/exit events in this trace)";
  const data: string[][] = rows.map((r) => [r.phase, String(r.enters), `${r.duration_ms}ms`]);
  return table(["phase", "enters", "total_ms"], data);
}

// --- Cost mode: per-role token + duration. ---

export interface CostFormatterOptions {
  // When supplied and non-zero, multiply tokens by this rate ($/1K tokens).
  // Used for adapters that have published per-token pricing.
  dollar_per_1k_tokens?: number;
}

export function formatCost(events: readonly TraceEvent[], opts: CostFormatterOptions = {}): string {
  const rows = aggregateRoleCost(events as TraceEvent[]);
  if (rows.length === 0) return "(no role_invoke events in this trace)";
  const headers = ["role", "invocations", "tokens_in", "tokens_out", "source", "duration_ms"];
  let showDollar = false;
  if (opts.dollar_per_1k_tokens && opts.dollar_per_1k_tokens > 0) {
    headers.push("est_$");
    showDollar = true;
  }
  const data: string[][] = rows.map((r) => {
    const cells = [
      r.role,
      String(r.invocations),
      String(r.tokens_in),
      String(r.tokens_out),
      r.tokens_source,
      String(r.duration_ms),
    ];
    if (showDollar) {
      const totalTokens = r.tokens_in + r.tokens_out;
      const dollars = (totalTokens / 1000) * (opts.dollar_per_1k_tokens ?? 0);
      const flag = r.tokens_source === "reported" ? "" : "*";
      cells.push(`$${dollars.toFixed(4)}${flag}`);
    }
    return cells;
  });
  let out = table(headers, data);
  if (showDollar) {
    out += "\n\n* asterisk marks rows whose token counts were estimated (chars/4 heuristic).";
  }
  return out;
}

// --- Detectors mode: fire counts per detector, descending. ---

export function formatDetectors(events: readonly TraceEvent[]): string {
  const rows = aggregateDetectorCounts(events as TraceEvent[]);
  if (rows.length === 0) return "(no detector_fired events in this trace)";
  return table(["detector", "count"], rows.map((r) => [r.detector, String(r.count)]));
}

// --- Tools mode: tool call log with auth decisions. ---

export function formatTools(events: readonly TraceEvent[]): string {
  const calls = events.filter((e) => e.type === "tool_call") as Extract<TraceEvent, { type: "tool_call" }>[];
  const results = new Map<string, Extract<TraceEvent, { type: "tool_result" }>>();
  for (const e of events) {
    if (e.type === "tool_result") results.set(e.call_id, e);
  }
  if (calls.length === 0) return "(no tool_call events in this trace)";
  const rows: string[][] = calls.map((c) => {
    const r = results.get(c.call_id);
    return [
      c.at,
      c.name,
      c.auth_decision,
      r ? (r.success ? "ok" : "err") : "pending",
      r ? `${r.duration_ms}ms` : "-",
      r ? `${r.bytes}B` : "-",
    ];
  });
  return table(["at", "tool", "auth", "result", "duration", "bytes"], rows);
}

// --- MCP mode: combined view of server lifecycle + call dispatches. ---

export function formatMcp(events: readonly TraceEvent[]): string {
  const relevant = events.filter((e) =>
    e.type === "mcp_server_started" ||
    e.type === "mcp_server_shutdown" ||
    e.type === "mcp_call_dispatched" ||
    e.type === "mcp_call_pending" ||
    e.type === "mcp_call_completed" ||
    e.type === "settings_merge_attempted" ||
    e.type === "settings_merge_outcome",
  );
  if (relevant.length === 0) return "(no MCP / settings events in this trace; no cli-bridge MCP forwarding ran)";
  return relevant.map(formatEventLine).join("\n");
}
