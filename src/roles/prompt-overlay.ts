// Assembles the system prompt for a role invocation. Layered as:
//
//   framework_doc + brief_rendering + role_overlay
//
// The role overlay never overrides the framework's hard rules; it scopes
// what the role does on top of them. Hard-rule words ("Phase 0", "Phase 3
// destructive flag", "blocker", banned phrases) are not redefined; the
// overlay only adds role-specific instructions.

import type { Brief, RoleDefinition } from "../types.js";
import { renderBriefForAgent } from "../brief.js";

export interface OverlayInput {
  framework: string;
  brief: Brief;
  role: RoleDefinition;
  // Optional extra context the coordinator wants to pin into the prompt
  // (sub-task instruction, prior handoff text, retry guidance).
  extra?: string;
  // v0.6: pre-rendered per-project memory block. The runner/coordinator
  // computes this with the right category visibility for the role and
  // hands it in. Empty string means no memory to inject.
  memory?: string;
}

export function buildSystemPrompt(input: OverlayInput): string {
  const parts: string[] = [];
  parts.push(input.framework.trim());
  parts.push("\n---\n");
  parts.push("# Brief (verbatim from the operator)\n");
  parts.push(renderBriefForAgent(input.brief).trim());
  if (input.memory && input.memory.trim()) {
    parts.push("\n---\n");
    parts.push(input.memory.trim());
  }
  parts.push("\n---\n");
  parts.push(`# Role: ${input.role.id}\n`);
  parts.push(input.role.prompt_overlay.trim());
  if (input.extra && input.extra.trim()) {
    parts.push("\n---\n");
    parts.push(input.extra.trim());
  }
  return parts.join("\n");
}
