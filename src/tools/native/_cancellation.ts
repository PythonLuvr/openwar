// v0.10.1 cancellation helpers shared by every native tool. Keeping the
// pattern in one place so the cancellation-check call sites stay terse and
// the contract (error code, message, meta shape) stays uniform across tools.

import type { ToolCall, ToolResult } from "../types.js";
import { TOOL_CANCELLED_ERROR_CODE, TOOL_CANCELLED_MESSAGE } from "../../sandbox/types.js";

export { TOOL_CANCELLED_ERROR_CODE, TOOL_CANCELLED_MESSAGE };

// Build the canonical cancelled ToolResult. `partial_output` is the bytes
// (text or binary) the tool produced before the abort fired; pass empty
// string for tools that buffer until completion.
export function cancelledResult(
  call: ToolCall,
  partial_output: string,
  startMs: number,
): ToolResult {
  return {
    call_id: call.id,
    success: false,
    content: partial_output.length > 0
      ? `${TOOL_CANCELLED_MESSAGE}\n--- partial output ---\n${partial_output}`
      : TOOL_CANCELLED_MESSAGE,
    error: { code: TOOL_CANCELLED_ERROR_CODE, message: TOOL_CANCELLED_MESSAGE },
    meta: { duration_ms: Date.now() - startMs, bytes: partial_output.length },
  };
}

// Throw-style helper for tools that want to abort with a marker AbortError
// from the middle of an async chain. Tools should catch it and produce a
// `cancelledResult`. Distinct from DOMException for older Node versions
// that surface AbortError differently across fs / fetch / child_process.
export class CancelledError extends Error {
  readonly cancelled = true;
  constructor(public partial_output = "") {
    super(TOOL_CANCELLED_MESSAGE);
    this.name = "CancelledError";
  }
}

// True when `signal` is an AbortSignal that has already fired. Tolerates
// `undefined` (no cancellation infrastructure attached).
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

// Returns a Promise that rejects with CancelledError when `signal` aborts.
// Pair with Promise.race for tools that have no native AbortSignal hook
// (the underlying op stays running until it finishes, but the tool returns
// the cancelled result immediately and the runtime moves on; the orphaned
// op completes silently in the background).
export function abortPromise(signal: AbortSignal | undefined, partial = ""): Promise<never> {
  if (!signal) return new Promise<never>(() => { /* never resolves */ });
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new CancelledError(partial));
      return;
    }
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new CancelledError(partial));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
