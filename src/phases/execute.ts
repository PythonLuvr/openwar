import type {
  AgentAdapter,
  Brief,
  Message,
  RunnerIO,
  ExecutionMode,
  StreamEvent,
  DetectorSnapshot,
} from "../types.js";
import { snapshot } from "../detectors/index.js";

export interface ExecuteOpts {
  brief: Brief;
  adapter: AgentAdapter;
  system: string;
  io: RunnerIO;
  mode: ExecutionMode;
  history: Message[];
  maxSteps?: number;
  signal?: AbortSignal;
  onMessage?: (m: Message) => void;
}

export interface ExecuteResult {
  history: Message[];
  outcome: "completion" | "blocker" | "destructive_denied" | "max_steps" | "operator_done";
  reason?: string;
  blocking_detectors?: DetectorSnapshot;
}

const DEFAULT_MAX_STEPS = 30;

const PHASE_1_KICKOFF = `
The Confirmation Summary has been accepted. Begin Phase 1: Execution.

Execute the brief one step at a time. After each step, briefly state what you did and what's next.
Surface decision points and meaningful checkpoints. Flag blockers (Phase 2) and any
destructive or out-of-directive actions (Phase 3) before performing them.
`.trim();

export async function runExecute(opts: ExecuteOpts): Promise<ExecuteResult> {
  const { brief, adapter, system, io, mode, signal, onMessage } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const history = [...opts.history];

  io.banner(`Phase 1: Execution (${mode})`);

  // Seed Phase 1 with the kickoff instruction.
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
    const assistantText = await streamAndCollect(adapter, system, history, io, signal);
    const detectors = snapshot(assistantText, {
      authorized_costs: brief.frontmatter.authorized_costs,
    });
    const assistant: Message = {
      role: "assistant",
      content: assistantText,
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
      // Auto-pilot: prompt the model to continue. The model decides when it's done.
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
  signal?: AbortSignal,
): Promise<string> {
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
      if (ev.message && ev.message.length >= assembled.length) {
        assembled = ev.message;
      }
      return assembled;
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }
  return assembled;
}
