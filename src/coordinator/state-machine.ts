// Pure FSM for the coordinator. No IO, no side effects, no Date.now().
// Given the current state plus the result of the last step, produces the
// next state. The driver layer is responsible for actually invoking roles,
// dispatching tools, and persisting state.
//
// States:
//   init -> plan -> dispatch -> execute -> review_step ->
//     next_subtask -> dispatch (next) | complete
//   any -> block | escalate
//
// Test surface: given a current (state, machineSnapshot) and a (signal),
// produce a deterministic next state. No Math.random, no async.

import type {
  CoordinatorState,
  SubTask,
  SubTaskState,
  SubTaskStatus,
  Budgets,
} from "./types.js";

export interface MachineSnapshot {
  state: CoordinatorState;
  plan: { subtasks: SubTask[] } | null;
  // Pointer into plan.subtasks. -1 before first dispatch.
  current_subtask_index: number;
  // Per-sub-task state, keyed by SubTask.id.
  subtask_states: Record<string, SubTaskState>;
  // Active roles. Empty = single-agent mode (FSM is not used in that case).
  active_roles: string[];
  budgets: Budgets;
  // Cost ledger projection used for budget signals.
  cost: { tokens_used: number; wall_clock_ms: number; tool_calls_by_subtask: Record<string, number> };
}

export type StepSignal =
  // The role/coordinator step just produced one of these outcomes.
  | { kind: "plan_ready" }
  | { kind: "plan_invalid" } // planner produced malformed output; FSM may retry or escalate
  | { kind: "execute_ok" }
  | { kind: "execute_blocked"; reason: string }
  | { kind: "review_pass" }
  | { kind: "review_needs_retry" }
  | { kind: "review_fail" }
  | { kind: "review_disagreement" } // critic + reviewer disagreed
  | { kind: "budget_overrun"; metric: "tokens" | "wall_clock_ms" | "tool_calls" }
  | { kind: "operator_done" }
  | { kind: "fatal"; reason: string };

export interface StepResult {
  next_state: CoordinatorState;
  // Mutations the driver should apply to the snapshot before persisting.
  // FSM never mutates the snapshot itself; it returns intent.
  mutations: SnapshotMutation[];
  // Reason string for transition events.
  reason: string;
}

export type SnapshotMutation =
  | { type: "set_subtask_status"; id: string; status: SubTaskStatus }
  | { type: "incr_subtask_attempts"; id: string }
  | { type: "advance_subtask_index" }
  | { type: "set_subtask_index"; index: number };

// Pure transition function. The driver calls this with the latest snapshot
// and the signal it observed, then applies the returned mutations and
// transitions to the returned next_state.
export function step(snapshot: MachineSnapshot, signal: StepSignal): StepResult {
  // Budget overrun always wins.
  if (signal.kind === "budget_overrun") {
    return {
      next_state: "escalate",
      mutations: [],
      reason: `budget overrun on ${signal.metric}`,
    };
  }

  if (signal.kind === "fatal") {
    return {
      next_state: "escalate",
      mutations: [],
      reason: `fatal: ${signal.reason}`,
    };
  }

  if (signal.kind === "operator_done") {
    return { next_state: "complete", mutations: [], reason: "operator ended" };
  }

  switch (snapshot.state) {
    case "init":
      return { next_state: "plan", mutations: [], reason: "starting plan" };

    case "plan": {
      if (signal.kind === "plan_ready") {
        return {
          next_state: "dispatch",
          mutations: [{ type: "set_subtask_index", index: 0 }],
          reason: "plan ready, dispatching first sub-task",
        };
      }
      if (signal.kind === "plan_invalid") {
        // Planner gets exactly one retry. Coordinator tracks attempts in
        // a virtual "planner" entry of subtask_states for simplicity.
        const plannerKey = "__planner__";
        const prior = snapshot.subtask_states[plannerKey];
        const attempts = (prior?.attempts ?? 0) + 1;
        if (attempts > 2) {
          return {
            next_state: "escalate",
            mutations: [
              { type: "set_subtask_status", id: plannerKey, status: "escalated" },
            ],
            reason: "planner produced invalid plan twice",
          };
        }
        return {
          next_state: "plan",
          mutations: [{ type: "incr_subtask_attempts", id: plannerKey }],
          reason: "planner output invalid, retrying once",
        };
      }
      break;
    }

    case "dispatch": {
      const plan = snapshot.plan;
      if (!plan || plan.subtasks.length === 0) {
        return {
          next_state: "escalate",
          mutations: [],
          reason: "dispatch with no plan",
        };
      }
      const idx = snapshot.current_subtask_index;
      if (idx >= plan.subtasks.length) {
        return { next_state: "complete", mutations: [], reason: "all sub-tasks done" };
      }
      const subtask = plan.subtasks[idx]!;
      return {
        next_state: "execute",
        mutations: [{ type: "set_subtask_status", id: subtask.id, status: "executing" }],
        reason: `dispatching sub-task ${idx + 1}/${plan.subtasks.length}: ${subtask.title}`,
      };
    }

    case "execute": {
      if (signal.kind === "execute_ok") {
        const subtask = currentSubtask(snapshot);
        if (!subtask) {
          return { next_state: "escalate", mutations: [], reason: "no current sub-task" };
        }
        return {
          next_state: "review_step",
          mutations: [{ type: "set_subtask_status", id: subtask.id, status: "reviewing" }],
          reason: `executor produced output for ${subtask.id}`,
        };
      }
      if (signal.kind === "execute_blocked") {
        const subtask = currentSubtask(snapshot);
        const muts: SnapshotMutation[] = [];
        if (subtask) {
          muts.push({ type: "set_subtask_status", id: subtask.id, status: "failed" });
        }
        return { next_state: "block", mutations: muts, reason: signal.reason };
      }
      break;
    }

    case "review_step": {
      const subtask = currentSubtask(snapshot);
      if (!subtask) {
        return { next_state: "escalate", mutations: [], reason: "no current sub-task at review" };
      }
      if (signal.kind === "review_pass") {
        return {
          next_state: "next_subtask",
          mutations: [{ type: "set_subtask_status", id: subtask.id, status: "passed" }],
          reason: `reviewer passed ${subtask.id}`,
        };
      }
      if (signal.kind === "review_needs_retry") {
        const state = snapshot.subtask_states[subtask.id];
        const attempts = state?.attempts ?? 0;
        if (attempts + 1 > snapshot.budgets.max_retries_per_subtask) {
          return {
            next_state: "escalate",
            mutations: [
              { type: "set_subtask_status", id: subtask.id, status: "escalated" },
            ],
            reason: `${subtask.id} exceeded max retries (${snapshot.budgets.max_retries_per_subtask})`,
          };
        }
        return {
          next_state: "retry",
          mutations: [
            { type: "set_subtask_status", id: subtask.id, status: "retrying" },
            { type: "incr_subtask_attempts", id: subtask.id },
          ],
          reason: `reviewer requested retry on ${subtask.id}`,
        };
      }
      if (signal.kind === "review_fail") {
        return {
          next_state: "escalate",
          mutations: [{ type: "set_subtask_status", id: subtask.id, status: "escalated" }],
          reason: `reviewer failed ${subtask.id}`,
        };
      }
      if (signal.kind === "review_disagreement") {
        return {
          next_state: "block",
          mutations: [{ type: "set_subtask_status", id: subtask.id, status: "failed" }],
          reason: `critic disagreement on ${subtask.id}`,
        };
      }
      break;
    }

    case "retry":
      return {
        next_state: "execute",
        mutations: [],
        reason: "re-dispatching to executor with reviewer feedback",
      };

    case "next_subtask": {
      const plan = snapshot.plan;
      if (!plan) return { next_state: "escalate", mutations: [], reason: "no plan at advance" };
      const nextIdx = snapshot.current_subtask_index + 1;
      if (nextIdx >= plan.subtasks.length) {
        return { next_state: "complete", mutations: [], reason: "all sub-tasks passed" };
      }
      return {
        next_state: "dispatch",
        mutations: [{ type: "advance_subtask_index" }],
        reason: `advancing to sub-task ${nextIdx + 1}/${plan.subtasks.length}`,
      };
    }

    case "block":
    case "escalate":
    case "complete":
      return { next_state: snapshot.state, mutations: [], reason: "terminal" };
  }

  return {
    next_state: "escalate",
    mutations: [],
    reason: `unhandled FSM transition from ${snapshot.state} on ${signal.kind}`,
  };
}

function currentSubtask(snapshot: MachineSnapshot): SubTask | null {
  if (!snapshot.plan) return null;
  return snapshot.plan.subtasks[snapshot.current_subtask_index] ?? null;
}

// Apply a list of mutations to a snapshot. Returns a new snapshot; does not
// mutate the input. The driver calls this with the result of `step` and
// persists the resulting snapshot.
export function applyMutations(snap: MachineSnapshot, muts: SnapshotMutation[]): MachineSnapshot {
  if (muts.length === 0) return snap;
  const subtask_states: Record<string, SubTaskState> = { ...snap.subtask_states };
  let current_subtask_index = snap.current_subtask_index;
  const nowIso = "__pure_iso__"; // Replaced by the driver with a real ISO before persisting.
  for (const m of muts) {
    switch (m.type) {
      case "set_subtask_status": {
        const prev = subtask_states[m.id] ?? {
          id: m.id,
          status: "pending" as const,
          attempts: 0,
        };
        subtask_states[m.id] = {
          ...prev,
          status: m.status,
          ...(m.status === "executing" && !prev.started_at ? { started_at: nowIso } : {}),
          ...(m.status === "passed" || m.status === "failed" || m.status === "escalated"
            ? { finished_at: nowIso }
            : {}),
        };
        break;
      }
      case "incr_subtask_attempts": {
        const prev = subtask_states[m.id] ?? {
          id: m.id,
          status: "pending" as const,
          attempts: 0,
        };
        subtask_states[m.id] = { ...prev, attempts: prev.attempts + 1 };
        break;
      }
      case "advance_subtask_index":
        current_subtask_index = current_subtask_index + 1;
        break;
      case "set_subtask_index":
        current_subtask_index = m.index;
        break;
    }
  }
  return { ...snap, subtask_states, current_subtask_index };
}
