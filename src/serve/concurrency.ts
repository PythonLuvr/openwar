// v0.13.0: max-concurrent gate for openwar serve.
//
// Simple counter. Each request takes a slot via tryAcquire(); when the
// in-flight count is at capacity, tryAcquire returns null and the router
// returns 429 with OpenAI's rate_limit_error shape. release() runs in a
// finally block to guarantee slot return even on handler throw.

export class ConcurrencyGate {
  private inFlight = 0;
  constructor(readonly max: number) {}

  // Atomic check-and-claim. Returns a release function when a slot is
  // available; null when the gate is full. The release function is
  // idempotent so the caller can wrap it in `try { ... } finally { ok?(); }`
  // without worrying about double-release in error paths.
  tryAcquire(): (() => void) | null {
    if (this.inFlight >= this.max) return null;
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
    };
  }

  // Read-only accessor for diagnostics and tests.
  get current(): number {
    return this.inFlight;
  }
}

// 429 body in OpenAI's standard rate_limit_error shape. Clients that
// already handle 429 backoff (Aider, Continue, Cline, OpenAI's SDKs)
// handle this automatically without modification.
export function rateLimitedResponse(): {
  status: 429;
  body: { error: { message: string; type: string; code: string } };
} {
  return {
    status: 429,
    body: {
      error: {
        message: "OpenWar proxy: max-concurrent exceeded",
        type: "rate_limit_error",
        code: "openwar_max_concurrent",
      },
    },
  };
}
