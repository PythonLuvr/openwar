// Generic timeout wrapper for any async tool operation. Wraps a promise with
// a deadline; rejects with TimeoutError if exceeded.
//
// For child_process kills, see src/sandbox/proc-kill.ts (separate concern:
// timing out a process is more than just rejecting a promise; the process
// needs SIGTERM then SIGKILL).

export class TimeoutError extends Error {
  readonly code = "TIMEOUT" as const;
  constructor(public readonly afterMs: number) {
    super(`operation exceeded ${afterMs}ms`);
    this.name = "TimeoutError";
  }
}

// Wrap a promise with a timeout. Optional AbortSignal lets callers cancel
// independently. ms <= 0 disables the timeout (returns the promise as-is).
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolveOuter, rejectOuter) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      rejectOuter(new TimeoutError(ms));
    }, ms);

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (signal) {
      if (signal.aborted) {
        clearTimer();
        rejectOuter(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimer();
          rejectOuter(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    }

    promise.then(
      (value) => {
        clearTimer();
        resolveOuter(value);
      },
      (err) => {
        clearTimer();
        rejectOuter(err);
      },
    );
  });
}
