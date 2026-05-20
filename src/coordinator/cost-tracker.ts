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

// v0.12.1: bridged-CLI usage from Squire's vendor-aware adapters. Input +
// output tokens flow into tokens_used like everything else (budget-relevant).
// Cache reads/writes are stored separately for visibility but do NOT inflate
// tokens_used: cache reads bill at a fraction of normal input rates (Anthropic
// roughly 10%) and including them would trip --max-tokens budget gates
// prematurely. Operators reading the trace see the cache breakdown in the
// bridged_usage event; the cost ledger surfaces it through the per-session
// bridged_tokens_* fields without distorting the running budget total.
export interface BridgedUsageInput {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export function addBridgedUsage(usage: CostUsage, u: BridgedUsageInput): void {
  if (typeof u.input_tokens === "number" && u.input_tokens > 0) {
    usage.tokens_used += u.input_tokens;
    usage.bridged_tokens_input = (usage.bridged_tokens_input ?? 0) + u.input_tokens;
  }
  if (typeof u.output_tokens === "number" && u.output_tokens > 0) {
    usage.tokens_used += u.output_tokens;
    usage.bridged_tokens_output = (usage.bridged_tokens_output ?? 0) + u.output_tokens;
  }
  if (typeof u.cache_read_tokens === "number" && u.cache_read_tokens > 0) {
    usage.bridged_tokens_cache_read = (usage.bridged_tokens_cache_read ?? 0) + u.cache_read_tokens;
  }
  if (typeof u.cache_write_tokens === "number" && u.cache_write_tokens > 0) {
    usage.bridged_tokens_cache_write = (usage.bridged_tokens_cache_write ?? 0) + u.cache_write_tokens;
  }
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
