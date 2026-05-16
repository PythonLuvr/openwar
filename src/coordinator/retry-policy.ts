// Bounded retry policy for sub-tasks. Default 3 retries. Backoff is purely
// time-based (no exponential network jitter because the cost is LLM calls,
// not network flakes). The driver consults `shouldRetry` and `backoffMs`
// before re-dispatching a sub-task.

import type { Budgets } from "./types.js";

export interface RetryPolicy {
  shouldRetry(attempts: number, budgets: Budgets): boolean;
  backoffMs(attempts: number): number;
}

export const defaultRetryPolicy: RetryPolicy = {
  shouldRetry(attempts, budgets) {
    return attempts < budgets.max_retries_per_subtask;
  },
  backoffMs(attempts) {
    // 0, 1s, 2s, 4s, 8s (clamped). LLM retries are slow enough already;
    // this just spaces retries to avoid hammering rate limits.
    if (attempts <= 0) return 0;
    return Math.min(8000, 1000 * 2 ** (attempts - 1));
  },
};
