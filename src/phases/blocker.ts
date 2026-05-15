import type { Message, RunnerIO } from "../types.js";

// Phase 2 is a halt. The runner has already detected the blocker via the
// execute loop; this helper formats the operator-facing report and returns.

export interface BlockerOpts {
  io: RunnerIO;
  reason: string;
  lastAssistant?: Message;
}

export function reportBlocker(opts: BlockerOpts): void {
  const { io, reason, lastAssistant } = opts;
  io.banner("Phase 2: Blocker");
  io.write(`Reason: ${reason}\n`);
  if (lastAssistant) {
    io.write("\nLast assistant message:\n");
    io.write(lastAssistant.content.trim() + "\n");
  }
  io.write("\nRuntime has stopped. Resume with `openwar resume <brief_id>` after resolving.\n");
}
