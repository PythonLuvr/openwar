// Coordinator driver. The IO-bearing partner to state-machine.ts.
//
// Responsibilities:
//   - Resolve role definitions + per-role tool subsets at start
//   - Walk the FSM, invoking the right role per state
//   - Stream adapter output through detectors (banned phrases, blocker)
//   - Parse handoffs and convert outcomes into StepSignals for the FSM
//   - Maintain CostUsage; emit budget_overrun signals when limits are hit
//   - Handle Phase 3 prompts at the executor's tool-call gate
//   - Persist snapshot after every state transition
//   - Handle SIGINT/abort cleanly (kills in-flight tool processes via the
//     existing sandbox timeout/kill paths)
//
// Public entrypoint: `runCoordinator(opts)`. Returns RunResult-compatible
// shape so the main runner can defer to it transparently.

import type {
  AgentAdapter,
  Brief,
  Budgets,
  CoordinatorEvent,
  CoordinatorState,
  CostUsage,
  ExecutionHandoff,
  Message,
  PlanHandoff,
  ReviewHandoff,
  RoleDefinition,
  RoleId,
  RunnerIO,
  RunResult,
  SubTask,
  SubTaskState,
  ToolCallRecord,
  ToolDefinition,
  StreamEvent,
} from "../types.js";
import { DEFAULT_BUDGETS } from "../types.js";
import { snapshot as detectorSnapshot } from "../detectors/index.js";
import { buildSystemPrompt } from "../roles/prompt-overlay.js";
import { renderMemoryForRole } from "../roles/memory-visibility.js";
import { getRole } from "../roles/registry.js";
import { parseHandoffFromText } from "../orchestration/handoff.js";
import { parsePlanFromText, scopeWarningsForPlan } from "./plan-parser.js";
import {
  step,
  applyMutations,
  type MachineSnapshot,
  type StepSignal,
} from "./state-machine.js";
import {
  newCostUsage,
  estimateTokens,
  addTokens,
  setWallClock,
  recordToolCall,
  checkBudgets,
  type BudgetMetric,
} from "./cost-tracker.js";
import { aggregateResults, type SubtaskOutcome } from "./result-aggregator.js";
import type { SandboxContext } from "../sandbox/types.js";
import type { ToolExecutor } from "../tools/types.js";
import { checkAuthorizationWithRole } from "../auth/check.js";

export interface RunCoordinatorOptions {
  brief: Brief;
  framework: string;
  // v0.5.1: per-role adapter resolution. The runner builds adapters from the
  // brief's role_adapters map (or falls back to the runtime default) and hands
  // a resolver in. Lazy resolution matters because cli-bridge spawns a child
  // on first send, so roles the run never reaches stay un-spawned.
  // Back-compat: callers may pass `adapter` instead, in which case every role
  // resolves to the same adapter.
  getAdapter?: (roleId: RoleId) => AgentAdapter;
  adapter?: AgentAdapter;
  io: RunnerIO;
  // Active roles (already validated; first element is the planner role).
  roleIds: RoleId[];
  // Budgets, with defaults already applied by the caller.
  budgets: Budgets;
  // For executor's tool dispatch. Pass through from the main runner.
  toolDefinitions: ToolDefinition[];
  toolExecutors: Map<string, ToolExecutor>;
  sandbox: SandboxContext;
  // Persistence callback. Called after every state transition with the
  // up-to-date snapshot serialized into a session-meta shape.
  onSnapshot: (s: MachineSnapshot, ev: CoordinatorEvent[]) => void;
  // Existing session-approved categories from prior Phase 3 prompts.
  sessionApproved: string[];
  // Append-message sink (mirrors into session transcript + JSONL).
  onMessage: (m: Message) => void;
  // Initial snapshot when resuming an existing session. When omitted, a
  // fresh snapshot in `init` state is built.
  initialSnapshot?: MachineSnapshot;
  signal?: AbortSignal;
  // Resolved session id (used in role transcripts and result-aggregator output).
  sessionId: string;
  // Tracker of all destructive approvals that occurred during this run.
  onApproval: (a: { action: string; approved: boolean; session_categories?: string[] }) => void;
}

export interface CoordinatorRunResult extends Omit<RunResult, "session_id"> {
  session_id: string;
  final_state: CoordinatorState;
  snapshot: MachineSnapshot;
  cost: CostUsage;
  events: CoordinatorEvent[];
}

const MAX_PHASE_3_PROMPTS_PER_SUBTASK = 6;

export async function runCoordinator(
  opts: RunCoordinatorOptions,
): Promise<CoordinatorRunResult> {
  const { brief, framework, io, signal } = opts;
  if (!opts.getAdapter && !opts.adapter) {
    throw new Error("runCoordinator: must provide either getAdapter or adapter");
  }
  const resolveAdapter: (roleId: RoleId) => AgentAdapter =
    opts.getAdapter ?? (() => opts.adapter!);
  const events: CoordinatorEvent[] = [];
  const sessionApproved = [...opts.sessionApproved];
  const startTime = Date.now();
  const cost = newCostUsage();

  let snap: MachineSnapshot =
    opts.initialSnapshot ?? {
      state: "init",
      plan: null,
      current_subtask_index: -1,
      subtask_states: {},
      active_roles: opts.roleIds,
      budgets: opts.budgets,
      cost: { tokens_used: 0, wall_clock_ms: 0, tool_calls_by_subtask: {} },
    };

  // Per-role conversation history. Each role sees its own thread.
  const roleHistories: Record<RoleId, Message[]> = {};
  for (const id of opts.roleIds) roleHistories[id] = [];

  // Per-sub-task outcomes (for the aggregator).
  const outcomes = new Map<string, SubtaskOutcome>();

  const recordEvent = (ev: CoordinatorEvent): void => {
    events.push(ev);
  };

  const transitionTo = (next: CoordinatorState, reason: string, subtaskId?: string): void => {
    snap = { ...snap, state: next };
    recordEvent({
      type: "state_enter",
      state: next,
      at: new Date().toISOString(),
      ...(subtaskId ? { subtask_id: subtaskId } : {}),
    });
    void reason;
    persist();
  };

  const persist = (): void => {
    setWallClock(cost, Date.now() - startTime);
    snap = {
      ...snap,
      cost: {
        tokens_used: cost.tokens_used,
        wall_clock_ms: cost.wall_clock_ms,
        tool_calls_by_subtask: { ...cost.tool_calls_by_subtask },
      },
    };
    opts.onSnapshot(snap, events);
  };

  const advance = (sig: StepSignal): void => {
    const result = step(snap, sig);
    snap = applyMutations(snap, result.mutations);
    transitionTo(result.next_state, result.reason);
  };

  const budgetCheck = (subtaskId: string | null): BudgetMetric | null => {
    const check = checkBudgets(cost, opts.budgets, subtaskId);
    if (check.exceeded) {
      recordEvent({
        type: "budget_halt",
        metric: check.exceeded,
        used: check.used,
        limit: check.limit,
        at: new Date().toISOString(),
      });
      return check.exceeded;
    }
    return null;
  };

  // Main loop. Bounded by an outer iteration cap so a misbehaving role can't
  // loop forever even if its signals confuse the FSM.
  const ITERATION_CAP = 200;
  for (let iter = 0; iter < ITERATION_CAP; iter++) {
    if (signal?.aborted) {
      transitionTo("escalate", "operator aborted");
      break;
    }
    if (
      snap.state === "complete" ||
      snap.state === "block" ||
      snap.state === "escalate"
    ) {
      break;
    }

    // Budget check before every IO-bearing state.
    if (snap.state === "plan" || snap.state === "execute" || snap.state === "review_step") {
      const sub = currentSubtask(snap);
      const over = budgetCheck(sub?.id ?? null);
      if (over) {
        advance({ kind: "budget_overrun", metric: over });
        continue;
      }
    }

    if (snap.state === "init") {
      advance({ kind: "execute_ok" }); // init transitions unconditionally
      continue;
    }

    if (snap.state === "plan") {
      const sig = await runPlanState({
        brief,
        framework,
        adapter: resolveAdapter("planner"),
        io,
        roleHistories,
        cost,
        events,
        recordEvent,
        signal,
      });
      if (sig.kind === "plan_ready" && sig.kind === "plan_ready") {
        // Capture the plan into the snapshot.
        snap = { ...snap, plan: { subtasks: sig._subtasks } };
      }
      advance({ kind: sig.kind, ...("reason" in sig ? { reason: sig.reason } : {}) } as StepSignal);
      continue;
    }

    if (snap.state === "dispatch") {
      advance({ kind: "execute_ok" }); // dispatch transitions unconditionally to execute
      continue;
    }

    if (snap.state === "execute") {
      const sub = currentSubtask(snap);
      if (!sub) {
        advance({ kind: "fatal", reason: "no current sub-task at execute" });
        continue;
      }
      io.banner(`executor [${snap.current_subtask_index + 1}/${snap.plan!.subtasks.length}] ${sub.title}`);
      const sig = await runExecuteState({
        brief,
        framework,
        adapter: resolveAdapter("executor"),
        io,
        subtask: sub,
        priorReview: outcomes.get(sub.id)?.review,
        roleHistories,
        toolDefinitions: opts.toolDefinitions,
        toolExecutors: opts.toolExecutors,
        sandbox: opts.sandbox,
        sessionApproved,
        cost,
        events,
        recordEvent,
        onMessage: opts.onMessage,
        onApproval: opts.onApproval,
        budgets: opts.budgets,
        signal,
      });
      if (sig.handoff) {
        outcomes.set(sub.id, {
          id: sub.id,
          title: sub.title,
          execution: sig.handoff,
          ...(outcomes.get(sub.id) ?? {}),
        });
        // Re-assign because the spread above duplicated; force-update.
        outcomes.set(sub.id, { id: sub.id, title: sub.title, execution: sig.handoff });
      }
      advance(sig.signal);
      continue;
    }

    if (snap.state === "review_step") {
      const sub = currentSubtask(snap);
      if (!sub) {
        advance({ kind: "fatal", reason: "no current sub-task at review" });
        continue;
      }
      const exec = outcomes.get(sub.id)?.execution;
      if (!exec) {
        advance({ kind: "fatal", reason: "no execution handoff at review" });
        continue;
      }
      io.banner(`reviewer [${snap.current_subtask_index + 1}/${snap.plan!.subtasks.length}] ${sub.title}`);
      const reviewSig = await runReviewState({
        brief,
        framework,
        reviewerAdapter: resolveAdapter("reviewer"),
        criticAdapter: opts.roleIds.includes("critic") ? resolveAdapter("critic") : undefined,
        io,
        subtask: sub,
        executionHandoff: exec,
        roleHistories,
        cost,
        events,
        recordEvent,
        signal,
        includeCritic: opts.roleIds.includes("critic"),
      });
      if (reviewSig.review) {
        const prior = outcomes.get(sub.id);
        outcomes.set(sub.id, {
          id: sub.id,
          title: sub.title,
          ...(prior ?? {}),
          review: reviewSig.review,
        });
      }
      advance(reviewSig.signal);
      continue;
    }

    if (snap.state === "retry") {
      // FSM-internal transition; no IO. Just step.
      advance({ kind: "execute_ok" });
      continue;
    }

    if (snap.state === "next_subtask") {
      advance({ kind: "execute_ok" });
      continue;
    }

    advance({ kind: "fatal", reason: `unknown state ${snap.state}` });
  }

  // Phase 4 / final report.
  if (snap.state === "complete" && snap.plan) {
    const report = aggregateResults({
      plan: { kind: "plan", subtasks: snap.plan.subtasks, rationale: "" },
      outcomes: [...outcomes.values()],
    });
    io.banner("Phase 4: Completion");
    io.write(report.text + "\n");
    opts.onMessage({
      role: "assistant",
      content: report.text,
      at: new Date().toISOString(),
      meta: { phase: "completion", step_index: 0, orch_role: null },
    });
  }

  return {
    session_id: opts.sessionId,
    final_phase: snap.state === "complete" ? "done" : "blocker",
    completed: snap.state === "complete",
    halted: snap.state !== "complete",
    halt_reason: snap.state === "complete" ? undefined : snap.state,
    final_state: snap.state,
    snapshot: snap,
    cost,
    events,
    messages: [], // The runner owns the full session message list.
  };
}

// ---------- State helpers ----------

function currentSubtask(snap: MachineSnapshot): SubTask | null {
  if (!snap.plan) return null;
  return snap.plan.subtasks[snap.current_subtask_index] ?? null;
}

// ---------- runPlanState ----------

interface PlanStateResult {
  kind: "plan_ready" | "plan_invalid";
  _subtasks: SubTask[];
  reason?: string;
}

async function runPlanState(args: {
  brief: Brief;
  framework: string;
  adapter: AgentAdapter;
  io: RunnerIO;
  roleHistories: Record<RoleId, Message[]>;
  cost: CostUsage;
  events: CoordinatorEvent[];
  recordEvent: (e: CoordinatorEvent) => void;
  signal?: AbortSignal;
}): Promise<PlanStateResult> {
  const role = getRole("planner");
  if (!role) {
    return { kind: "plan_invalid", _subtasks: [], reason: "planner role missing from registry" };
  }
  args.recordEvent({ type: "role_invoked", role: role.id, at: new Date().toISOString() });
  args.io.banner("planner");

  const memory = args.brief.frontmatter.inherit_memory
    ? await renderMemoryForRole(args.brief.frontmatter.project, "planner")
    : "";
  const system = buildSystemPrompt({
    framework: args.framework,
    brief: args.brief,
    role,
    memory,
    extra:
      "You are now in Phase 1 of the orchestration. Produce the plan handoff.",
  });

  const userTurn: Message = {
    role: "user",
    content:
      "Decompose this brief into linear sub-tasks. End with the fenced JSON plan handoff.",
    at: new Date().toISOString(),
    meta: { phase: "execute", orch_role: "planner", step_index: 0 },
  };
  const history = [...(args.roleHistories["planner"] ?? []), userTurn];
  const { text } = await streamAndCollect(args.adapter, system, history, args.io, args.signal);
  args.cost.tokens_used += estimateTokens(system) + estimateTokens(userTurn.content) + estimateTokens(text);

  const assistant: Message = {
    role: "assistant",
    content: text,
    at: new Date().toISOString(),
    meta: { phase: "execute", orch_role: "planner", step_index: 1 },
  };
  args.roleHistories["planner"] = [...history, assistant];

  const parsed = parsePlanFromText(text);
  if (!parsed.ok) {
    args.io.warn(`planner output invalid (${parsed.reason}): ${parsed.message}`);
    return { kind: "plan_invalid", _subtasks: [], reason: parsed.message };
  }
  // Scope warnings (non-blocking).
  const warns = scopeWarningsForPlan(parsed.plan, args.brief);
  for (const w of warns) {
    args.io.warn(`plan scope warning: ${w.subtask_id} mentions ${w.category} which is not in authorized_costs`);
  }
  return { kind: "plan_ready", _subtasks: parsed.plan.subtasks };
}

// ---------- runExecuteState ----------

interface ExecuteStateResult {
  signal: StepSignal;
  handoff?: ExecutionHandoff;
}

async function runExecuteState(args: {
  brief: Brief;
  framework: string;
  adapter: AgentAdapter;
  io: RunnerIO;
  subtask: SubTask;
  priorReview?: ReviewHandoff;
  roleHistories: Record<RoleId, Message[]>;
  toolDefinitions: ToolDefinition[];
  toolExecutors: Map<string, ToolExecutor>;
  sandbox: SandboxContext;
  sessionApproved: string[];
  cost: CostUsage;
  events: CoordinatorEvent[];
  recordEvent: (e: CoordinatorEvent) => void;
  onMessage: (m: Message) => void;
  onApproval: RunCoordinatorOptions["onApproval"];
  budgets: Budgets;
  signal?: AbortSignal;
}): Promise<ExecuteStateResult> {
  const role = getRole("executor");
  if (!role) {
    return { signal: { kind: "fatal", reason: "executor role missing" } };
  }
  args.recordEvent({
    type: "role_invoked",
    role: role.id,
    subtask_id: args.subtask.id,
    at: new Date().toISOString(),
  });

  const subBrief = subtaskAsSubBrief(args.subtask, args.priorReview);
  const memory = args.brief.frontmatter.inherit_memory
    ? await renderMemoryForRole(args.brief.frontmatter.project, "executor")
    : "";
  const system = buildSystemPrompt({
    framework: args.framework,
    brief: args.brief,
    role,
    memory,
    extra: subBrief,
  });

  const userTurn: Message = {
    role: "user",
    content: subBrief,
    at: new Date().toISOString(),
    meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id, step_index: 0 },
  };
  args.onMessage(userTurn);

  const history = [...(args.roleHistories["executor"] ?? []), userTurn];

  // Inner tool-call loop, capped per the brief's budget.
  let assembledText = "";
  let toolCallsThisStep = 0;
  const maxToolCalls = args.budgets.max_tool_calls_per_subtask;
  const recordedCalls: ToolCallRecord[] = [];

  for (let round = 0; round < maxToolCalls + 1; round++) {
    const collected = await streamAndCollectWithTools(
      args.adapter,
      system,
      history,
      args.io,
      args.toolDefinitions,
      args.signal,
    );
    assembledText = collected.text;
    args.cost.tokens_used += estimateTokens(collected.text);

    if (collected.toolCalls.length === 0) break;

    const assistant: Message = {
      role: "assistant",
      content:
        collected.text +
        (collected.text ? "\n" : "") +
        collected.toolCalls
          .map((c) => `[tool: ${c.name}(${JSON.stringify(c.arguments)})]`)
          .join("\n"),
      at: new Date().toISOString(),
      meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id, step_index: round + 1 },
    };
    history.push(assistant);
    args.onMessage(assistant);

    for (const call of collected.toolCalls) {
      toolCallsThisStep++;
      if (toolCallsThisStep > maxToolCalls) {
        return {
          signal: { kind: "execute_blocked", reason: `tool-call budget exceeded for ${args.subtask.id}` },
        };
      }
      const toolDef = args.toolDefinitions.find((t) => t.name === call.name);
      if (!toolDef) {
        history.push({
          role: "user",
          content: `[tool_result ${call.id} (error)]\nTool "${call.name}" is not registered.`,
          at: new Date().toISOString(),
          meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id },
        });
        continue;
      }
      // Two-tier auth: role scope first, then brief auth.
      const decision = checkAuthorizationWithRole({
        tool: toolDef,
        role,
        authorizedCosts: args.brief.frontmatter.authorized_costs,
        sessionApproved: args.sessionApproved,
      });
      if (decision.kind === "role_scope_violation") {
        return {
          signal: {
            kind: "fatal",
            reason: `executor attempted ${call.name} outside its role scope (missing: ${decision.missing_categories.join(", ")})`,
          },
        };
      }
      if (decision.kind === "needs_operator") {
        const approved = await args.io.confirm(
          `Phase 3: executor wants to call ${call.name}, requires categories: ${decision.decision.missing_categories.join(", ")}. Approve?`,
        );
        if (!approved) {
          args.onApproval({ action: call.name, approved: false });
          history.push({
            role: "user",
            content: `[tool_result ${call.id} (error)]\nOperator denied this tool call.`,
            at: new Date().toISOString(),
            meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id },
          });
          continue;
        }
        // Promote categories session-wide.
        for (const c of decision.decision.missing_categories) {
          if (!args.sessionApproved.includes(c)) args.sessionApproved.push(c);
        }
        args.onApproval({
          action: call.name,
          approved: true,
          session_categories: [...decision.decision.missing_categories],
        });
      }
      // Dispatch.
      const executor = args.toolExecutors.get(call.name);
      if (!executor) {
        history.push({
          role: "user",
          content: `[tool_result ${call.id} (error)]\nTool "${call.name}" has no executor registered.`,
          at: new Date().toISOString(),
          meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id },
        });
        continue;
      }
      const result = await executor(call, args.sandbox);
      recordToolCall(args.cost, args.subtask.id);
      recordedCalls.push({
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        at: new Date().toISOString(),
        authorized: true,
        result: { success: result.success, content: result.content },
      });
      history.push({
        role: "user",
        content: `[tool_result ${call.id}${result.success ? "" : " (error)"}]\n${result.content}`,
        at: new Date().toISOString(),
        meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id },
      });
    }
  }

  // Final assistant turn (text without trailing tool calls).
  const finalAssistant: Message = {
    role: "assistant",
    content: assembledText,
    at: new Date().toISOString(),
    meta: { phase: "execute", orch_role: "executor", subtask_id: args.subtask.id },
  };
  history.push(finalAssistant);
  args.onMessage(finalAssistant);
  args.roleHistories["executor"] = history;

  // Parse handoff.
  const parsed = parseHandoffFromText(assembledText);
  if (parsed.ok && parsed.handoff.kind === "execution") {
    // Merge in recorded tool calls (executor may have summarized; we trust the runtime record).
    const handoff: ExecutionHandoff = {
      ...parsed.handoff,
      subtask_id: args.subtask.id,
      tool_calls:
        parsed.handoff.tool_calls.length > 0 ? parsed.handoff.tool_calls : recordedCalls,
    };
    // Detector pass for blocker.
    const det = detectorSnapshot(assembledText, {
      authorized_costs: args.brief.frontmatter.authorized_costs,
    });
    if (det.blocker?.blocked) {
      return {
        signal: { kind: "execute_blocked", reason: det.blocker.reason ?? "blocker" },
        handoff,
      };
    }
    return { signal: { kind: "execute_ok" }, handoff };
  }
  if (parsed.ok && parsed.handoff.kind === "escalation") {
    return {
      signal: { kind: "execute_blocked", reason: parsed.handoff.reason },
    };
  }
  return {
    signal: { kind: "execute_blocked", reason: parsed.ok ? "wrong handoff kind" : parsed.message },
  };
}

function subtaskAsSubBrief(st: SubTask, priorReview: ReviewHandoff | undefined): string {
  const lines: string[] = [];
  lines.push(`# Sub-task ${st.id}: ${st.title}`);
  lines.push("");
  lines.push(`Instruction:\n${st.instruction}`);
  lines.push("");
  lines.push(`Acceptance criteria:`);
  for (const c of st.acceptance_criteria) lines.push(`- ${c}`);
  if (priorReview && priorReview.verdict === "needs_retry") {
    lines.push("");
    lines.push(`---`);
    lines.push(`The reviewer asked for a retry. Address this revision:`);
    lines.push(priorReview.suggested_revision ?? priorReview.rationale);
  }
  lines.push("");
  lines.push("Phase 0 of OpenWar applies recursively to this sub-task: confirm you have understood the instruction and acceptance criteria in your own words at the top of your reply, then execute. End with the fenced JSON ExecutionHandoff.");
  return lines.join("\n");
}

// ---------- runReviewState ----------

interface ReviewStateResult {
  signal: StepSignal;
  review?: ReviewHandoff;
}

async function runReviewState(args: {
  brief: Brief;
  framework: string;
  reviewerAdapter: AgentAdapter;
  criticAdapter?: AgentAdapter;
  io: RunnerIO;
  subtask: SubTask;
  executionHandoff: ExecutionHandoff;
  roleHistories: Record<RoleId, Message[]>;
  cost: CostUsage;
  events: CoordinatorEvent[];
  recordEvent: (e: CoordinatorEvent) => void;
  signal?: AbortSignal;
  includeCritic: boolean;
}): Promise<ReviewStateResult> {
  const reviewer = getRole("reviewer");
  if (!reviewer) {
    return { signal: { kind: "fatal", reason: "reviewer role missing" } };
  }
  const reviewerResult = await invokeReviewer(reviewer, { ...args, adapter: args.reviewerAdapter });
  if (!reviewerResult.review) {
    return { signal: { kind: "fatal", reason: "reviewer produced no valid handoff" } };
  }

  if (!args.includeCritic) {
    return { signal: verdictToSignal(reviewerResult.review.verdict), review: reviewerResult.review };
  }

  const critic = getRole("critic");
  if (!critic) {
    // No critic registered; fall back to reviewer alone.
    return { signal: verdictToSignal(reviewerResult.review.verdict), review: reviewerResult.review };
  }
  const criticResult = await invokeReviewer(critic, { ...args, adapter: args.criticAdapter ?? args.reviewerAdapter });
  if (!criticResult.review) {
    return { signal: verdictToSignal(reviewerResult.review.verdict), review: reviewerResult.review };
  }
  if (reviewerResult.review.verdict !== criticResult.review.verdict) {
    args.io.warn(
      `reviewer/critic disagreement on ${args.subtask.id}: reviewer=${reviewerResult.review.verdict} critic=${criticResult.review.verdict}`,
    );
    return { signal: { kind: "review_disagreement" }, review: reviewerResult.review };
  }
  return { signal: verdictToSignal(reviewerResult.review.verdict), review: reviewerResult.review };
}

async function invokeReviewer(
  role: RoleDefinition,
  args: {
    brief: Brief;
    framework: string;
    adapter: AgentAdapter;
    io: RunnerIO;
    subtask: SubTask;
    executionHandoff: ExecutionHandoff;
    roleHistories: Record<RoleId, Message[]>;
    cost: CostUsage;
    events: CoordinatorEvent[];
    recordEvent: (e: CoordinatorEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{ review?: ReviewHandoff }> {
  args.recordEvent({
    type: "role_invoked",
    role: role.id,
    subtask_id: args.subtask.id,
    at: new Date().toISOString(),
  });
  const memory = args.brief.frontmatter.inherit_memory
    ? await renderMemoryForRole(args.brief.frontmatter.project, role.id)
    : "";
  const system = buildSystemPrompt({
    framework: args.framework,
    brief: args.brief,
    role,
    memory,
    extra: `# Sub-task being reviewed: ${args.subtask.id}\n\n` +
      `Title: ${args.subtask.title}\n\n` +
      `Acceptance criteria:\n${args.subtask.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`,
  });
  const userTurn: Message = {
    role: "user",
    content:
      "Evaluate the executor's ExecutionHandoff below against the acceptance criteria above. End your reply with the fenced JSON ReviewHandoff.\n\n```json\n" +
      JSON.stringify(args.executionHandoff, null, 2) +
      "\n```",
    at: new Date().toISOString(),
    meta: { phase: "execute", orch_role: role.id, subtask_id: args.subtask.id },
  };
  const history = [...(args.roleHistories[role.id] ?? []), userTurn];
  const { text } = await streamAndCollect(args.adapter, system, history, args.io, args.signal);
  args.cost.tokens_used += estimateTokens(text);

  const assistant: Message = {
    role: "assistant",
    content: text,
    at: new Date().toISOString(),
    meta: { phase: "execute", orch_role: role.id, subtask_id: args.subtask.id },
  };
  args.roleHistories[role.id] = [...history, assistant];

  const parsed = parseHandoffFromText(text);
  if (!parsed.ok) return {};
  if (parsed.handoff.kind !== "review") return {};
  return { review: parsed.handoff };
}

function verdictToSignal(verdict: ReviewHandoff["verdict"]): StepSignal {
  if (verdict === "pass") return { kind: "review_pass" };
  if (verdict === "needs_retry") return { kind: "review_needs_retry" };
  return { kind: "review_fail" };
}

// ---------- Streaming helpers ----------

interface CollectResult {
  text: string;
  toolCalls: import("../types.js").ToolCall[];
}

async function streamAndCollect(
  adapter: AgentAdapter,
  system: string,
  messages: Message[],
  io: RunnerIO,
  signal?: AbortSignal,
): Promise<{ text: string }> {
  let assembled = "";
  for await (const ev of adapter.sendMessage({
    system,
    messages,
    ...(signal ? { signal } : {}),
  }) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text_delta") {
      io.write(ev.delta);
      assembled += ev.delta;
    } else if (ev.type === "done") {
      io.write("\n");
      if (ev.message && ev.message.length >= assembled.length) assembled = ev.message;
      return { text: assembled };
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }
  return { text: assembled };
}

async function streamAndCollectWithTools(
  adapter: AgentAdapter,
  system: string,
  messages: Message[],
  io: RunnerIO,
  tools: ToolDefinition[] | undefined,
  signal?: AbortSignal,
): Promise<CollectResult> {
  let assembled = "";
  const toolCalls: import("../types.js").ToolCall[] = [];
  const opts: Parameters<AgentAdapter["sendMessage"]>[0] = { system, messages };
  if (tools && tools.length > 0) opts.tools = tools;
  if (signal) opts.signal = signal;
  for await (const ev of adapter.sendMessage(opts) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text_delta") {
      io.write(ev.delta);
      assembled += ev.delta;
    } else if (ev.type === "tool_call_complete") {
      toolCalls.push(ev.call);
    } else if (ev.type === "done") {
      io.write("\n");
      if (ev.message && ev.message.length >= assembled.length) assembled = ev.message;
      if (ev.tool_calls && ev.tool_calls.length > 0) {
        for (const c of ev.tool_calls) {
          if (!toolCalls.find((t) => t.id === c.id)) toolCalls.push(c);
        }
      }
      return { text: assembled, toolCalls };
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }
  return { text: assembled, toolCalls };
}

// Helper to extract SubTaskState defaults used elsewhere.
export function newSubtaskState(id: string): SubTaskState {
  return { id, status: "pending", attempts: 0 };
}

// Compute initial Budgets from the brief.
export function resolveBudgets(brief: Brief): Budgets {
  const fmBudgets = brief.frontmatter.budgets ?? {};
  return {
    max_tokens: fmBudgets.max_tokens ?? DEFAULT_BUDGETS.max_tokens,
    max_wall_clock_minutes:
      fmBudgets.max_wall_clock_minutes ?? DEFAULT_BUDGETS.max_wall_clock_minutes,
    max_tool_calls_per_subtask:
      fmBudgets.max_tool_calls_per_subtask ?? DEFAULT_BUDGETS.max_tool_calls_per_subtask,
    max_retries_per_subtask:
      fmBudgets.max_retries_per_subtask ?? DEFAULT_BUDGETS.max_retries_per_subtask,
  };
}

void MAX_PHASE_3_PROMPTS_PER_SUBTASK;
