import type {
  AgentAdapter,
  Brief,
  Message,
  RunnerIO,
  StreamEvent,
} from "../types.js";
import { renderBriefForAgent } from "../brief.js";
import { detectConfirmationSummary, snapshot } from "../detectors/index.js";

// Phase 0 result.
export interface IntakeResult {
  // Operator's acknowledgement: did they accept the Confirmation Summary?
  accepted: boolean;
  // The free-form operator response, in case the runner needs to forward it
  // (e.g. operator typed a correction instead of "go").
  operator_reply: string;
  // Final assistant message of intake. Always present even if not accepted.
  assistant_message: Message;
  // User-message form of the brief, prepended to history before Phase 1.
  brief_prompt: Message;
}

export interface IntakeOpts {
  brief: Brief;
  adapter: AgentAdapter;
  system: string;
  io: RunnerIO;
  signal?: AbortSignal;
}

const INTAKE_INSTRUCTION = `
You have just received a brief under the OpenWar framework. Execute Phase 0 (Brief Intake) now.

1. Read the entire brief.
2. Produce a Confirmation Summary with these sections, in this order:
   - Objective
   - Deliverables
   - Constraints
   - Tools required
   - Unknowns
3. End by asking which execution mode the operator wants (per-step gating or auto-pilot), unless the brief's frontmatter already specifies mode.

Do not begin execution. Stop after the Confirmation Summary and wait for the operator.
`.trim();

export async function runIntake(opts: IntakeOpts): Promise<IntakeResult> {
  const { brief, adapter, system, io, signal } = opts;

  const briefBody = renderBriefForAgent(brief);
  const briefPrompt: Message = {
    role: "user",
    content: `${briefBody}\n\n---\n\n${INTAKE_INSTRUCTION}\n`,
    at: new Date().toISOString(),
    meta: { phase: "intake", step_index: 0 },
  };

  io.banner("Phase 0: Brief intake");

  const assistantText = await streamAndCollect(adapter, system, [briefPrompt], io, signal);
  let assistantMessage: Message = {
    role: "assistant",
    content: assistantText,
    at: new Date().toISOString(),
    meta: {
      phase: "intake",
      step_index: 0,
      detectors: snapshot(assistantText, { authorized_costs: brief.frontmatter.authorized_costs }),
    },
  };

  // If the model skipped the Confirmation Summary shape, nudge it once.
  const conf = detectConfirmationSummary(assistantText);
  if (!conf.found) {
    io.warn(
      "Confirmation Summary not detected in agent reply. Asking the model to restate in OpenWar shape.",
    );
    const nudge: Message = {
      role: "user",
      content:
        "That reply did not contain a Confirmation Summary in OpenWar's required shape. " +
        "Restate as: Objective / Deliverables / Constraints / Tools required / Unknowns, " +
        "then ask which execution mode the operator wants. Do not begin execution.",
      at: new Date().toISOString(),
      meta: { phase: "intake", step_index: 1 },
    };
    const retry = await streamAndCollect(
      adapter,
      system,
      [briefPrompt, assistantMessage, nudge],
      io,
      signal,
    );
    assistantMessage = {
      role: "assistant",
      content: retry,
      at: new Date().toISOString(),
      meta: {
        phase: "intake",
        step_index: 1,
        detectors: snapshot(retry, { authorized_costs: brief.frontmatter.authorized_costs }),
      },
    };
  }

  // Hand control to operator.
  io.write("\n");
  const reply = await io.prompt(
    'Acknowledge Confirmation Summary. Type "go" to accept, or describe a correction:',
  );
  const accepted = isAcceptance(reply);

  return {
    accepted,
    operator_reply: reply,
    assistant_message: assistantMessage,
    brief_prompt: briefPrompt,
  };
}

function isAcceptance(reply: string): boolean {
  const trimmed = reply.trim().toLowerCase();
  if (!trimmed) return false;
  return /^(go|ok|okay|yes|y|approved|approve|confirmed|confirm|ship it|run it|do it|sounds good|looks good)$/.test(
    trimmed,
  );
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
      // Some adapters won't have streamed every chunk into `assembled`;
      // prefer the canonical message.
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
