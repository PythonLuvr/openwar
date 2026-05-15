import type { DestructiveDetection, Message, RunnerIO } from "../types.js";

// Phase 3: explicit per-session yes required. Returns true if approved.

export interface DestructiveOpts {
  io: RunnerIO;
  detection: DestructiveDetection;
  lastAssistant?: Message;
}

export async function awaitOperatorYes(opts: DestructiveOpts): Promise<boolean> {
  const { io, detection, lastAssistant } = opts;
  io.banner("Phase 3: Destructive flag");
  io.write(`Action category: ${detection.action ?? "unspecified"}\n`);
  if (lastAssistant) {
    io.write("\nProposed action (from the agent):\n");
    io.write(lastAssistant.content.trim() + "\n\n");
  }
  io.write(
    "This action falls outside the brief's authorized_costs and requires explicit approval.\n",
  );
  const approved = await io.confirm("Approve this action for the current session?");
  return approved;
}

export function denialMessage(detection: DestructiveDetection): Message {
  return {
    role: "user",
    content:
      `The operator has DENIED the destructive action ("${detection.action ?? "unspecified"}"). ` +
      "Do not perform it. Propose a non-destructive alternative or stop and ask for a scope clarification.",
    at: new Date().toISOString(),
    meta: { phase: "destructive", step_index: 0 },
  };
}

export function approvalMessage(detection: DestructiveDetection): Message {
  return {
    role: "user",
    content:
      `The operator has APPROVED the destructive action ("${detection.action ?? "unspecified"}") ` +
      "for the current session. Proceed, then report what was done.",
    at: new Date().toISOString(),
    meta: { phase: "destructive", step_index: 0 },
  };
}
