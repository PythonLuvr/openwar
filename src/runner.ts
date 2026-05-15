import type {
  Brief,
  Message,
  Phase,
  RunOptions,
  RunResult,
  RunnerIO,
  SessionMeta,
  SessionState,
  ExecutionMode,
  PhaseTransition,
} from "./types.js";
import { parseBrief, validateBrief, generateBriefId } from "./brief.js";
import { loadFrameworkDoc } from "./framework.js";
import { runIntake } from "./phases/intake.js";
import { runExecute } from "./phases/execute.js";
import { reportBlocker } from "./phases/blocker.js";
import {
  awaitOperatorYes,
  approvalMessage,
  denialMessage,
} from "./phases/destructive.js";
import { runCompletion } from "./phases/completion.js";
import { createTerminalIO } from "./io.js";
import { writeSession, readSession } from "./state/persist.js";
import { appendTranscript } from "./state/transcript.js";

export async function run(opts: RunOptions): Promise<RunResult> {
  if (!opts.briefPath && !opts.briefSource) {
    throw new Error("run() requires either briefPath or briefSource.");
  }
  const briefInput = opts.briefSource ?? opts.briefPath!;
  const brief: Brief = parseBrief(briefInput);

  const validation = validateBrief(brief);
  const errors = validation.issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new Error(
      `Brief is invalid: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
    );
  }

  const io = opts.io ?? createTerminalIO();
  const adapter = opts.adapter;
  if (!adapter.isConfigured()) {
    throw new Error(
      `Adapter "${adapter.id}" is not configured. Check API key environment variable.`,
    );
  }

  // Compose the system prompt: framework doc verbatim, no inlining.
  const framework = loadFrameworkDoc();
  const system = framework;

  // Resolve / open session.
  const briefId = opts.sessionId ?? brief.frontmatter.brief_id ?? generateBriefId();
  let session: SessionState;
  let isResumed = false;
  if (!opts.ephemeral && opts.resume) {
    const prior = readSession(briefId);
    if (prior) {
      session = prior;
      isResumed = true;
      io.banner(`Resuming session ${briefId} (phase: ${session.meta.phase})`);
    } else {
      session = createSession(brief, briefId);
    }
  } else {
    session = createSession(brief, briefId);
  }

  const persist = () => {
    if (opts.ephemeral) return;
    session.meta.updated_at = new Date().toISOString();
    writeSession(session);
  };

  const recordMessage = (m: Message) => {
    session.messages.push(m);
    if (!opts.ephemeral) appendTranscript(session.meta.brief_id, m);
  };

  const transition = (to: Phase, reason: string) => {
    const t: PhaseTransition = {
      from: session.meta.phase,
      to,
      at: new Date().toISOString(),
      reason,
    };
    session.meta.phase = to;
    session.meta.transitions.push(t);
  };

  // ------------------- Phase 0 -------------------
  let mode: ExecutionMode;
  let historyForExecute: Message[];

  if (!isResumed || session.meta.phase === "intake") {
    transition("intake", "starting");
    persist();
    const intake = await runIntake({ brief, adapter, system, io });
    recordMessage(intake.brief_prompt);
    recordMessage(intake.assistant_message);
    persist();

    if (!intake.accepted) {
      // Operator did not accept. Persist their correction as the next user
      // turn so a future `resume` can pick it up.
      if (intake.operator_reply.trim()) {
        recordMessage({
          role: "user",
          content: intake.operator_reply,
          at: new Date().toISOString(),
          meta: { phase: "intake", step_index: 2 },
        });
      }
      persist();
      io.write(
        "\nConfirmation Summary not accepted. Session paused at Phase 0. Resume with adjustments or restart.\n",
      );
      return {
        session_id: session.meta.brief_id,
        final_phase: "intake",
        completed: false,
        halted: true,
        halt_reason: "intake_not_accepted",
        messages: session.messages,
      };
    }

    mode = await resolveMode(brief, opts, io, intake.operator_reply);
    session.meta.mode = mode;
    historyForExecute = [intake.brief_prompt, intake.assistant_message];
  } else {
    mode = session.meta.mode ?? (await resolveMode(brief, opts, io, ""));
    session.meta.mode = mode;
    historyForExecute = session.messages.slice();
  }

  // ------------------- Phase 1 -------------------
  transition("execute", "intake accepted");
  persist();
  let executeResult = await runExecute({
    brief,
    adapter,
    system,
    io,
    mode,
    history: historyForExecute,
    onMessage: (m) => {
      // The execute phase already pushed onto its own local history;
      // mirror into the session.
      recordMessage(m);
      persist();
    },
  });

  // ------------------- Phase 3 (loop) -------------------
  while (executeResult.outcome === "destructive_denied") {
    const last = lastAssistant(executeResult.history);
    const detection = executeResult.blocking_detectors?.destructive;
    if (!detection || !detection.destructive) break;

    transition("destructive", "destructive intent detected");
    persist();
    const approved = await awaitOperatorYes({
      io,
      detection,
      ...(last ? { lastAssistant: last } : {}),
    });
    session.meta.destructive_approvals.push({
      at: new Date().toISOString(),
      action: detection.action ?? "unspecified",
      approved,
    });
    persist();

    const followUp = approved ? approvalMessage(detection) : denialMessage(detection);
    recordMessage(followUp);
    transition("execute", approved ? "destructive approved" : "destructive denied");
    persist();

    executeResult = await runExecute({
      brief,
      adapter,
      system,
      io,
      mode,
      history: [...executeResult.history, followUp],
      onMessage: (m) => {
        recordMessage(m);
        persist();
      },
    });
  }

  // ------------------- Phase 2 -------------------
  if (executeResult.outcome === "blocker") {
    transition("blocker", executeResult.reason ?? "blocker");
    persist();
    reportBlocker({
      io,
      reason: executeResult.reason ?? "unspecified",
      ...(lastAssistant(executeResult.history) ? { lastAssistant: lastAssistant(executeResult.history)! } : {}),
    });
    return {
      session_id: session.meta.brief_id,
      final_phase: "blocker",
      completed: false,
      halted: true,
      halt_reason: executeResult.reason ?? "blocker",
      messages: session.messages,
    };
  }

  if (executeResult.outcome === "max_steps") {
    transition("blocker", "max_steps");
    persist();
    io.banner("Phase 2: Blocker (max_steps reached)");
    io.write(`Stopping: ${executeResult.reason}\n`);
    return {
      session_id: session.meta.brief_id,
      final_phase: "blocker",
      completed: false,
      halted: true,
      halt_reason: "max_steps",
      messages: session.messages,
    };
  }

  if (executeResult.outcome === "operator_done") {
    transition("completion", "operator ended");
    persist();
    // Skip the model's completion report when the operator manually stopped.
    return {
      session_id: session.meta.brief_id,
      final_phase: "completion",
      completed: true,
      halted: false,
      messages: session.messages,
    };
  }

  // ------------------- Phase 4 -------------------
  transition("completion", "completion detected");
  persist();
  const finalReport = await runCompletion({
    adapter,
    system,
    io,
    history: executeResult.history,
  });
  recordMessage(finalReport);
  transition("done", "completion report delivered");
  persist();

  return {
    session_id: session.meta.brief_id,
    final_phase: "done",
    completed: true,
    halted: false,
    messages: session.messages,
  };
}

function createSession(brief: Brief, briefId: string): SessionState {
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    brief_id: briefId,
    project: brief.frontmatter.project,
    started_at: now,
    updated_at: now,
    phase: "intake",
    mode: null,
    destructive_approvals: [],
    transitions: [],
  };
  return { meta, brief, messages: [] };
}

function lastAssistant(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "assistant") return m;
  }
  return undefined;
}

async function resolveMode(
  brief: Brief,
  opts: RunOptions,
  io: RunnerIO,
  operatorReply: string,
): Promise<ExecutionMode> {
  // Precedence: CLI override > brief frontmatter > operator-typed > prompt.
  if (opts.mode) return opts.mode;
  if (brief.frontmatter.mode) return brief.frontmatter.mode;
  const reply = operatorReply.toLowerCase();
  if (/\bauto(?:-?pilot)?\b/.test(reply)) return "auto";
  if (/\b(gated|per[-\s]?step|step)\b/.test(reply)) return "gated";
  const picked = await io.prompt('Execution mode? Type "gated" or "auto":');
  return picked.trim().toLowerCase() === "auto" ? "auto" : "gated";
}

