import type { AgentAdapter, Message, RunnerIO, StreamEvent } from "../types.js";

export interface CompletionOpts {
  adapter: AgentAdapter;
  system: string;
  io: RunnerIO;
  history: Message[];
  signal?: AbortSignal;
}

const FINAL_REPORT_PROMPT = `
Produce the Phase 4 completion report now. Be concise:

- What was delivered
- Anything unresolved
- Anything left open / handed back to the operator

Do not restate the diff or anything visible in the work itself. Surface what the operator cannot see by reading the result.
`.trim();

export async function runCompletion(opts: CompletionOpts): Promise<Message> {
  const { adapter, system, io, history, signal } = opts;
  io.banner("Phase 4: Completion");

  const request: Message = {
    role: "user",
    content: FINAL_REPORT_PROMPT,
    at: new Date().toISOString(),
    meta: { phase: "completion", step_index: 0 },
  };

  let assembled = "";
  for await (const ev of adapter.sendMessage({
    system,
    messages: [...history, request],
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
      break;
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }

  return {
    role: "assistant",
    content: assembled,
    at: new Date().toISOString(),
    meta: { phase: "completion", step_index: 1 },
  };
}
