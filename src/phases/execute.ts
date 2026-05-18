import type {
  AgentAdapter,
  Brief,
  Message,
  RunnerIO,
  ExecutionMode,
  StreamEvent,
  DetectorSnapshot,
  ToolDefinition,
  ToolCall,
  ToolResultForRound,
} from "../types.js";
import type { SandboxContext } from "../sandbox/types.js";
import type { ToolExecutor } from "../tools/types.js";
import { snapshotWithConsultations } from "../detectors/index.js";
import { checkAuthorization } from "../auth/check.js";
import { Tracer, nullTracer } from "../state/trace.js";
import type { DetectorSensitivityMap } from "../state/learned-profile.js";

export interface ExecuteOpts {
  brief: Brief;
  adapter: AgentAdapter;
  system: string;
  io: RunnerIO;
  mode: ExecutionMode;
  history: Message[];
  maxSteps?: number;
  // Per-step inner tool-call round cap. Prevents thrashing.
  maxToolRoundsPerStep?: number;
  signal?: AbortSignal;
  onMessage?: (m: Message) => void;
  onToolCall?: (call: ToolCall, result: ToolResultForRound) => void;
  // Tool calling. When provided, the runner enables tools for the LLM and
  // dispatches tool calls through the registry + sandbox.
  toolDefinitions?: ToolDefinition[];
  toolExecutors?: Map<string, ToolExecutor>;
  sandbox?: SandboxContext;
  // Categories the operator approved session-wide at prior Phase 3 prompts.
  sessionApproved?: string[];
  // v0.8: structured trace emitter. Optional so test callers and the
  // coordinator's executor adapter can pass nullTracer().
  tracer?: Tracer;
  // v0.9.1: per-detector sensitivity map from a loaded learned profile.
  // Threaded into snapshot() so detectors honor the overrides. Optional
  // because most runs do not set learned_profile in frontmatter.
  detectorSensitivities?: DetectorSensitivityMap;
}

export interface ExecuteResult {
  history: Message[];
  outcome: "completion" | "blocker" | "destructive_denied" | "max_steps" | "operator_done";
  reason?: string;
  blocking_detectors?: DetectorSnapshot;
  // When outcome === "destructive_denied" due to a tool-call auth gate,
  // this carries the call that needs operator approval.
  destructive_tool_call?: ToolCall;
  destructive_missing_categories?: readonly string[];
}

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_MAX_TOOL_ROUNDS_PER_STEP = 3;

const PHASE_1_KICKOFF = `
The Confirmation Summary has been accepted. Begin Phase 1: Execution.

Execute the brief one step at a time. After each step, briefly state what you did and what's next.
Surface decision points and meaningful checkpoints. Flag blockers (Phase 2) and any
destructive or out-of-directive actions (Phase 3) before performing them.
`.trim();

interface StreamCollectResult {
  text: string;
  toolCalls: ToolCall[];
}

export async function runExecute(opts: ExecuteOpts): Promise<ExecuteResult> {
  const { brief, adapter, system, io, mode, signal, onMessage } = opts;
  const tracer = opts.tracer ?? nullTracer();
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxToolRounds = opts.maxToolRoundsPerStep ?? DEFAULT_MAX_TOOL_ROUNDS_PER_STEP;
  const history = [...opts.history];
  const hasTools = (opts.toolDefinitions?.length ?? 0) > 0 && !!opts.toolExecutors && !!opts.sandbox;

  io.banner(`Phase 1: Execution (${mode})${hasTools ? ` [tools: ${opts.toolDefinitions!.length}]` : ""}`);

  const kickoff: Message = {
    role: "user",
    content:
      mode === "auto"
        ? `${PHASE_1_KICKOFF}\n\nMode: auto-pilot. Execute clean steps without asking; only stop for blockers (Phase 2) or destructive / out-of-directive actions (Phase 3).`
        : `${PHASE_1_KICKOFF}\n\nMode: per-step gating. After each step, wait for the operator's "ok" before continuing.`,
    at: new Date().toISOString(),
    meta: { phase: "execute", step_index: 0 },
  };
  history.push(kickoff);
  onMessage?.(kickoff);

  for (let step = 0; step < maxSteps; step++) {
    // ---- Inner tool-call loop. Multiple LLM turns may happen per step if
    //      the model calls tools, we run them, and the model continues. ----
    let priorToolCalls: ToolCall[] = [];
    let priorToolResults: ToolResultForRound[] = [];
    let stepText = "";

    let roundsThisStep = 0;
    while (true) {
      const collected = await streamAndCollect(
        adapter,
        system,
        history,
        io,
        opts.toolDefinitions,
        priorToolCalls,
        priorToolResults,
        signal,
      );
      stepText = collected.text;

      if (collected.toolCalls.length === 0) break;

      // Authorization check across all calls. Any unauthorized call halts.
      for (const call of collected.toolCalls) {
        const toolDef = opts.toolDefinitions!.find(t => t.name === call.name);
        if (!toolDef) {
          // Unknown tool. Surface as a denial-style tool result for the LLM
          // to react to (not a Phase 3, just an error).
          priorToolCalls = [...collected.toolCalls];
          priorToolResults = collected.toolCalls.map(c => ({
            call_id: c.id,
            content: `Tool "${c.name}" is not registered.`,
            is_error: true,
          }));
          break;
        }
        const decision = checkAuthorization({
          tool: toolDef,
          authorizedCosts: brief.frontmatter.authorized_costs,
          sessionApproved: opts.sessionApproved ?? [],
        });
        tracer.emit({
          type: "auth_check_fired",
          layer: "openwar",
          tool: call.name,
          decision: decision.allowed ? "allow" : "deny",
          reason: decision.allowed
            ? `categories ok: ${decision.required_categories.join(", ") || "(none)"}`
            : `missing: ${decision.missing_categories.join(", ")}`,
          at: new Date().toISOString(),
        });
        if (!decision.allowed) {
          return {
            history,
            outcome: "destructive_denied",
            reason: `tool "${call.name}" requires unauthorized categories: ${decision.missing_categories.join(", ")}`,
            destructive_tool_call: call,
            destructive_missing_categories: decision.missing_categories,
          };
        }
      }

      // Execute each call sequentially via its executor.
      priorToolCalls = collected.toolCalls;
      priorToolResults = [];
      for (const call of collected.toolCalls) {
        const executor = opts.toolExecutors!.get(call.name);
        if (!executor) {
          priorToolResults.push({
            call_id: call.id,
            content: `Tool "${call.name}" has no executor registered.`,
            is_error: true,
          });
          continue;
        }
        io.write(`\n→ ${call.name}(${JSON.stringify(call.arguments).slice(0, 120)})\n`);
        tracer.emit({
          type: "tool_call",
          call_id: call.id,
          name: call.name,
          args: call.arguments,
          auth_decision: "allow",
          at: new Date().toISOString(),
        });
        const toolStartMs = Date.now();
        const result = await executor(call, opts.sandbox!);
        const round: ToolResultForRound = {
          call_id: call.id,
          content: result.content,
          ...(result.success ? {} : { is_error: true }),
        };
        priorToolResults.push(round);
        opts.onToolCall?.(call, round);
        const durationMs = result.meta?.duration_ms ?? Date.now() - toolStartMs;
        tracer.emit({
          type: "tool_result",
          call_id: call.id,
          success: result.success,
          duration_ms: durationMs,
          bytes: Buffer.byteLength(result.content ?? "", "utf8"),
          at: new Date().toISOString(),
        });
        io.write(`  ↳ ${result.success ? "ok" : "error"} (${durationMs}ms)\n`);
      }

      // Persist the round in transcript history as assistant + tool messages.
      const assistantToolUseMsg: Message = {
        role: "assistant",
        content: stepText + (stepText && priorToolCalls.length ? "\n" : "") +
          priorToolCalls.map(c => `[tool: ${c.name}(${JSON.stringify(c.arguments)})]`).join("\n"),
        at: new Date().toISOString(),
        meta: { phase: "execute", step_index: step + 1 },
      };
      history.push(assistantToolUseMsg);
      onMessage?.(assistantToolUseMsg);
      for (const r of priorToolResults) {
        const m: Message = {
          role: "user",
          content: `[tool_result ${r.call_id}${r.is_error ? " (error)" : ""}]\n${r.content}`,
          at: new Date().toISOString(),
          meta: { phase: "execute", step_index: step + 1 },
        };
        history.push(m);
        onMessage?.(m);
      }

      roundsThisStep++;
      if (roundsThisStep >= maxToolRounds) {
        io.warn(`Tool-call round cap reached for step ${step + 1}.`);
        break;
      }
      // Next inner-loop iteration: send the LLM the tool results.
    }

    // ---- Detector pass on the final assistant text of this step. ----
    const detectorRun = snapshotWithConsultations(stepText, {
      authorized_costs: brief.frontmatter.authorized_costs,
      ...(opts.detectorSensitivities ? { sensitivities: opts.detectorSensitivities } : {}),
    });
    const detectors = detectorRun.snapshot;
    // v0.9.1: emit one learned_sensitivity_consulted event per non-default
    // detector consultation. Audit trail shows the operator exactly which
    // adjustments were honored and which fired.
    const consultAt = new Date().toISOString();
    for (const c of detectorRun.consultations) {
      tracer.emit({
        type: "learned_sensitivity_consulted",
        at: consultAt,
        detector: c.detector,
        sensitivity: c.sensitivity,
        fired: c.fired,
      });
    }
    // v0.8: emit detector_fired for each detector that returned a meaningful
    // signal. Detectors that returned no signal (blocker.blocked=false etc.)
    // don't produce events, keeping the trace focused on actionable fires.
    const detectorAt = new Date().toISOString();
    if (detectors.confirmation?.found) {
      tracer.emit({ type: "detector_fired", detector: "confirmation", payload: detectors.confirmation, at: detectorAt });
    }
    if (detectors.blocker?.blocked) {
      tracer.emit({ type: "detector_fired", detector: "blocker", payload: detectors.blocker, at: detectorAt });
    }
    if (detectors.destructive?.destructive) {
      tracer.emit({ type: "detector_fired", detector: "destructive", payload: detectors.destructive, at: detectorAt });
    }
    if (detectors.banned_phrases && detectors.banned_phrases.count > 0) {
      tracer.emit({ type: "detector_fired", detector: "banned_phrases", payload: detectors.banned_phrases, at: detectorAt });
    }
    if (detectors.phase_marker && detectors.phase_marker.declared.length > 0) {
      tracer.emit({ type: "detector_fired", detector: "phase_marker", payload: detectors.phase_marker, at: detectorAt });
    }
    if (detectors.completion?.complete) {
      tracer.emit({ type: "detector_fired", detector: "completion", payload: detectors.completion, at: detectorAt });
    }
    const assistant: Message = {
      role: "assistant",
      content: stepText,
      at: new Date().toISOString(),
      meta: { phase: "execute", step_index: step + 1, detectors },
    };
    history.push(assistant);
    onMessage?.(assistant);

    if (detectors.banned_phrases && detectors.banned_phrases.count > 0) {
      io.warn(
        `Voice rules: ${detectors.banned_phrases.count} banned phrase(s) detected: ${detectors.banned_phrases.phrases.join(", ")}`,
      );
    }

    if (detectors.blocker?.blocked) {
      return {
        history,
        outcome: "blocker",
        reason: detectors.blocker.reason ?? "unspecified blocker",
        blocking_detectors: detectors,
      };
    }

    if (detectors.destructive?.destructive && !detectors.destructive.authorized) {
      return {
        history,
        outcome: "destructive_denied",
        reason: detectors.destructive.action ?? "destructive intent",
        blocking_detectors: detectors,
      };
    }

    if (detectors.completion?.complete) {
      return { history, outcome: "completion" };
    }

    if (mode === "gated") {
      const reply = await io.prompt(
        'Continue? Type "ok"/"go" to proceed, "done" to finish, or send a redirect:',
      );
      const lower = reply.trim().toLowerCase();
      if (lower === "done" || lower === "stop" || lower === "halt") {
        return { history, outcome: "operator_done", reason: reply };
      }
      const next: Message = {
        role: "user",
        content: lower === "" || /^(ok|go|continue|next|proceed|y|yes)$/.test(lower)
          ? "Continue with the next step."
          : reply,
        at: new Date().toISOString(),
        meta: { phase: "execute", step_index: step + 1 },
      };
      history.push(next);
      onMessage?.(next);
    } else {
      const next: Message = {
        role: "user",
        content: "Continue with the next step. If the brief is complete, declare Phase 4 and stop.",
        at: new Date().toISOString(),
        meta: { phase: "execute", step_index: step + 1 },
      };
      history.push(next);
      onMessage?.(next);
    }
  }

  return { history, outcome: "max_steps", reason: `reached max_steps=${maxSteps}` };
}

async function streamAndCollect(
  adapter: AgentAdapter,
  system: string,
  messages: Message[],
  io: RunnerIO,
  tools: ToolDefinition[] | undefined,
  priorToolCalls: ToolCall[],
  priorToolResults: ToolResultForRound[],
  signal?: AbortSignal,
): Promise<StreamCollectResult> {
  let assembled = "";
  const toolCalls: ToolCall[] = [];
  for await (const ev of adapter.sendMessage({
    system,
    messages,
    ...(tools && tools.length > 0 && { tools }),
    ...(priorToolCalls.length > 0 && { prior_tool_calls: priorToolCalls }),
    ...(priorToolResults.length > 0 && { prior_tool_results: priorToolResults }),
    ...(signal ? { signal } : {}),
  }) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text_delta") {
      io.write(ev.delta);
      assembled += ev.delta;
    } else if (ev.type === "tool_call_complete") {
      toolCalls.push(ev.call);
    } else if (ev.type === "done") {
      io.write("\n");
      if (ev.message && ev.message.length >= assembled.length) {
        assembled = ev.message;
      }
      if (ev.tool_calls) {
        for (const c of ev.tool_calls) {
          if (!toolCalls.some(existing => existing.id === c.id)) toolCalls.push(c);
        }
      }
      return { text: assembled, toolCalls };
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }
  return { text: assembled, toolCalls };
}
