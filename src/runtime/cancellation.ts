// v0.11.1: per-tool-call cancellation registry.
//
// The runner creates one ToolCallRegistry per session. Every tool dispatch
// (native, MCP-forwarded, coordinator-routed) registers itself before
// invoking the executor and clears its slot afterward. The chat REPL, an
// external caller via RunOptions.signal, or a coordinator-level abort
// fire `cancel()` which aborts the active controller and resolves the
// completion promise once the executor returns.
//
// Design notes
// -----------
// - Only one tool call is active at a time per session. v0.11.1 does NOT
//   support parallel tool dispatch; if a future release ships it the
//   registry becomes a Map keyed by call_id.
// - `cancel()` awaits the executor's actual exit so callers know when it's
//   safe to take next action. Required by the brief's Q4 lean.
// - MCP-forwarded executors that don't honor AbortSignal natively use the
//   5-second grace synthesis pattern documented below.

import type { CancellationSource, Session, ToolCancellation } from "../types.js";

export interface ActiveCall {
  callId: string;
  toolName: string;
  ac: AbortController;
  startMs: number;
  // Resolves when the executor returns (either normally or with a
  // cancelled result). Used by cancel() to await the exit.
  done: Promise<void>;
}

export interface CancellationEmitter {
  emit(payload: ToolCancellation): void;
}

export class ToolCallRegistry {
  private active: ActiveCall | null = null;
  private resolveDone: (() => void) | null = null;
  // The emitter is optional so tests can construct a bare registry. The
  // runner wires it to the Tracer + session-event sink.
  constructor(private emitter?: CancellationEmitter) {}

  // Open a new active slot. The returned controller's signal must be
  // forwarded into the executor's context. Caller is responsible for
  // matching every begin() with exactly one end().
  begin(callId: string, toolName: string): AbortController {
    if (this.active) {
      throw new Error(
        `ToolCallRegistry: begin() while call ${this.active.callId} is still active. v0.11.1 does not support concurrent tool calls.`,
      );
    }
    const ac = new AbortController();
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    this.resolveDone = resolve;
    this.active = { callId, toolName, ac, startMs: Date.now(), done };
    return ac;
  }

  // Close the active slot. Idempotent; calling end with the wrong id
  // no-ops (so a stale resolution from a cancelled-but-still-running
  // executor doesn't blow up the next dispatch).
  end(callId: string): void {
    if (!this.active || this.active.callId !== callId) return;
    this.active = null;
    this.resolveDone?.();
    this.resolveDone = null;
  }

  // Fire the active controller and wait for the executor to exit.
  // Returns true if a call was active when called, false otherwise.
  // Safe to call from any context; multiple concurrent calls await
  // the same exit.
  async cancel(source: CancellationSource = "operator_signal"): Promise<boolean> {
    const cur = this.active;
    if (!cur) return false;
    // Record the source for the trace-event emitter; the executor's
    // returned result carries the partial output via the standard
    // cancelledResult shape.
    this.cancellationSource = source;
    if (!cur.ac.signal.aborted) cur.ac.abort();
    await cur.done;
    return true;
  }

  // The cancellation source for the currently-cancelling call. Read by
  // the dispatcher after the executor returns to build the trace event.
  // Defaults to operator_signal; runtime-shutdown and timeout callers
  // override before calling cancel().
  cancellationSource: CancellationSource = "operator_signal";

  // Read-only accessors. Used by the chat renderer for live status lines.
  hasActive(): boolean { return this.active !== null; }
  activeCallId(): string | undefined { return this.active?.callId; }
  activeToolName(): string | undefined { return this.active?.toolName; }
  activeStartedAt(): number | undefined { return this.active?.startMs; }

  // Emit a tool_cancelled trace event. Called by the dispatcher when an
  // executor returns a result with the CANCELLED error code.
  emit(payload: ToolCancellation): void {
    this.emitter?.emit(payload);
  }
}

// Build a Session handle over a registry. v0.12.0 added grant-ledger
// surface to the Session interface; this helper returns no-op
// implementations so unit tests and minimal callers still typecheck.
// The runner builds its Session inline with the real ledger so chat REPL
// and external callers get working /grants and /revoke surfaces.
export function sessionFromRegistry(registry: ToolCallRegistry): Session {
  return {
    cancelCurrentToolCall: () => registry.cancel("operator_signal"),
    listActiveGrants: () => [],
    revokeGrant: () => false,
  };
}

// Helper for MCP-forwarded executors and any custom executor that calls
// out to a downstream system that does not honor AbortSignal natively.
// Pattern:
//   1. Operator cancellation fires ctx.signal.
//   2. We wait `graceMs` for the underlying call to complete; if it does,
//      we return the real result.
//   3. Otherwise we synthesize a cancelled-shaped result locally and let
//      the orphaned call continue in the background. The downstream
//      server may eventually finish; that's the server's bug, not ours.
//
// `synthesize` is invoked only when the grace window expires without the
// promise settling. Returns the real result if the promise settles first.
export async function raceWithCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  graceMs: number,
  synthesize: () => T,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return synthesize();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(synthesize());
      }, graceMs);
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { if (settled) return; settled = true; cleanup(); resolve(v); },
      (e) => { if (settled) return; settled = true; cleanup(); reject(e); },
    );
  });
}
