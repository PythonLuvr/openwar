// v0.12.1: shared consumer-side handling for cli-bridge structured events.
//
// Squire's vendor-aware adapters (claude-code, gemini-cli) surface
// structured events from inside a bridged CLI's own run; the cli-bridge
// adapter translates them to OpenWar `bridged_*` StreamEvent variants.
// This helper is the convergence point: every StreamEvent consumer that
// might receive bridged events routes them through here so the trace
// always captures the event and the cost ledger (when one exists) picks
// up bridged-CLI tokens with the documented attribution rules.
//
// The helper is deliberately stateless and dependency-light: a tracer and
// an optional usage sink. Existing consumers (execute.ts dispatch loop,
// coordinator executor turn) call it from the streamAndCollect / event
// loop; they keep their existing native StreamEvent handling unchanged.

import type { StreamEvent } from "../types.js";
import type { Tracer } from "../state/trace.js";
import type { BridgedUsageInput } from "../coordinator/cost-tracker.js";

// Shape the runner / coordinator passes to receive bridged usage events
// for cost-ledger accounting. When absent, usage still goes to the trace
// (the observability path) but is dropped on the cost-ledger side. This
// is the behavior single-agent cli-bridge runs see today: no coordinator,
// no ledger, but the trace still has the bridged_usage event for
// `openwar inspect` to surface.
export type BridgedUsageSink = (u: BridgedUsageInput) => void;

// Return true if the event was a bridged_* variant and was handled; false
// otherwise (the caller's existing switch handles native variants).
export function handleBridgedStreamEvent(
  ev: StreamEvent,
  tracer: Tracer,
  onUsage?: BridgedUsageSink,
): boolean {
  const at = new Date().toISOString();
  switch (ev.type) {
    case "bridged_tool_call":
      tracer.emit({
        type: "bridged_tool_call",
        call_id: ev.call_id,
        tool_name: ev.tool_name,
        arguments: ev.arguments,
        binary: ev.binary,
        at,
      });
      return true;
    case "bridged_tool_result":
      tracer.emit({
        type: "bridged_tool_result",
        call_id: ev.call_id,
        result: ev.result,
        is_error: ev.is_error,
        binary: ev.binary,
        at,
      });
      return true;
    case "bridged_thinking_delta":
      tracer.emit({
        type: "bridged_thinking_delta",
        delta: ev.delta,
        binary: ev.binary,
        at,
      });
      return true;
    case "bridged_usage": {
      // Build a trace-event shape that only includes the token fields
      // the bridged CLI actually reported (omit zeros so the trace stays
      // honest about which counters the vendor surfaced).
      const traceEvent: import("../state/trace.js").TraceEvent = {
        type: "bridged_usage",
        binary: ev.binary,
        ...(typeof ev.input_tokens === "number" ? { input_tokens: ev.input_tokens } : {}),
        ...(typeof ev.output_tokens === "number" ? { output_tokens: ev.output_tokens } : {}),
        ...(typeof ev.cache_read_tokens === "number" ? { cache_read_tokens: ev.cache_read_tokens } : {}),
        ...(typeof ev.cache_write_tokens === "number" ? { cache_write_tokens: ev.cache_write_tokens } : {}),
        at,
      };
      tracer.emit(traceEvent);
      // Feed the cost ledger if one is wired. Single-agent cli-bridge
      // runs typically have no ledger; the data still lives in the
      // trace for `openwar inspect` to surface.
      onUsage?.({
        ...(typeof ev.input_tokens === "number" ? { input_tokens: ev.input_tokens } : {}),
        ...(typeof ev.output_tokens === "number" ? { output_tokens: ev.output_tokens } : {}),
        ...(typeof ev.cache_read_tokens === "number" ? { cache_read_tokens: ev.cache_read_tokens } : {}),
        ...(typeof ev.cache_write_tokens === "number" ? { cache_write_tokens: ev.cache_write_tokens } : {}),
      });
      return true;
    }
    default:
      return false;
  }
}
