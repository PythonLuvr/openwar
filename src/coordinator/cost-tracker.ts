// Cost ledger for one coordinator run. Tracks tokens, wall-clock, and tool
// calls per sub-task. Pure data structure + small helpers; the driver
// updates it after each role invocation.
//
// Tokenization fidelity: when an adapter surfaces token usage in its done
// event we use that count; otherwise we fall back to chars/4. This is an
// approximation, called out in CHANGELOG; not a real tokenizer. Brief
// explicitly allows it.

import type { Budgets, CostUsage } from "./types.js";

export function newCostUsage(now: () => Date = () => new Date()): CostUsage {
  return {
    tokens_used: 0,
    wall_clock_ms: 0,
    tool_calls: 0,
    tool_calls_by_subtask: {},
    started_at: now().toISOString(),
  };
}

export function estimateTokens(text: string): number {
  // chars/4 heuristic. Documented in CHANGELOG.
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function addTokens(usage: CostUsage, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  usage.tokens_used += tokens;
}

export function setWallClock(usage: CostUsage, ms: number): void {
  usage.wall_clock_ms = Math.max(usage.wall_clock_ms, ms);
}

export function recordToolCall(usage: CostUsage, subtaskId: string | null): void {
  usage.tool_calls += 1;
  if (subtaskId) {
    usage.tool_calls_by_subtask[subtaskId] =
      (usage.tool_calls_by_subtask[subtaskId] ?? 0) + 1;
  }
}

export type BudgetMetric = "tokens" | "wall_clock_ms" | "tool_calls";

export interface BudgetCheck {
  exceeded: BudgetMetric | null;
  used: number;
  limit: number;
}

// Check every budget dimension. Returns the first metric that exceeded its
// limit (deterministic ordering: tokens, then wall_clock_ms, then tool calls
// for the current sub-task). Tool-call budget is per-sub-task; tokens and
// wall-clock are run-wide.
export function checkBudgets(
  usage: CostUsage,
  budgets: Budgets,
  current_subtask_id: string | null,
): BudgetCheck {
  if (usage.tokens_used > budgets.max_tokens) {
    return { exceeded: "tokens", used: usage.tokens_used, limit: budgets.max_tokens };
  }
  const wallLimit = budgets.max_wall_clock_minutes * 60 * 1000;
  if (usage.wall_clock_ms > wallLimit) {
    return { exceeded: "wall_clock_ms", used: usage.wall_clock_ms, limit: wallLimit };
  }
  if (current_subtask_id) {
    const used = usage.tool_calls_by_subtask[current_subtask_id] ?? 0;
    if (used > budgets.max_tool_calls_per_subtask) {
      return {
        exceeded: "tool_calls",
        used,
        limit: budgets.max_tool_calls_per_subtask,
      };
    }
  }
  return { exceeded: null, used: 0, limit: 0 };
}
