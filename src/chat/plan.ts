// v0.10.0: plain-English plan presenter.
//
// Takes a compiled Brief + refused_categories (from the conservative compiler)
// and renders the three-section block the chat surface shows before asking
// for approval:
//
//   Plan: bulleted actions in order
//   Authorized: plain-English description of what's pre-approved
//   Not authorized: what the agent will refuse / ask about during execution
//
// The "Not authorized" list is the load-bearing piece. Non-devs need to see
// what is excluded as visibly as what is included.

import type { Brief } from "../types.js";
import type { ProposePlanIntent } from "./intent.js";

// Plain-language descriptions for each known auth category. Used in both
// the Authorized and Not-authorized sections. Keys are auth category ids.
export const AUTH_DESCRIPTIONS: Record<string, string> = {
  filesystem_read: "read files in this directory",
  filesystem_write: "read and write files in this directory",
  filesystem_delete: "delete files",
  shell_exec: "run shell commands",
  http_fetch: "make HTTP requests to external sites",
  paid_api_call: "call paid APIs (which costs money)",
  git_write: "make local git commits",
  git_push: "publish changes to your repository (git push)",
  deploy: "deploy to a live environment",
  external_message: "send messages outside this session (Slack, email, etc.)",
};

function describeCategory(cat: string): string {
  const desc = AUTH_DESCRIPTIONS[cat];
  if (desc) return desc;
  // Unknown category: render verbatim with a hint. The compiler's
  // explanations field also surfaces this.
  return `${cat} (unknown action; will ask before running)`;
}

export interface PresentPlanOptions {
  // The compiled brief produced by src/chat/compile.ts.
  brief: Brief;
  // The plan_text from the agent's propose_plan intent (the bulleted plan).
  proposal: ProposePlanIntent;
  // Destructive categories the compiler refused to auto-grant. Surfaced in
  // "Not authorized."
  refused_categories: readonly string[];
  // Optional learned-profile summary, e.g.,
  // "Learned profile loaded: 2 detector adjustments, 1 phase budget."
  learnedProfileSummary?: string;
  // Optional project-memory summary, e.g.,
  // "Project memory: 3 prior decisions, 1 constraint."
  memorySummary?: string;
}

export function presentPlan(opts: PresentPlanOptions): string {
  const out: string[] = [];
  out.push("Plan:");
  for (const line of opts.proposal.plan_text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Normalize leading bullets so the presenter looks consistent regardless
    // of how the agent formatted its plan.
    const bullet = /^[-*]\s*/.test(trimmed) ? trimmed : `- ${trimmed}`;
    out.push(`  ${bullet}`);
  }
  out.push("");

  out.push("Authorized:");
  const grants = opts.brief.frontmatter.authorized_costs;
  if (grants.length === 0) {
    out.push("  (none beyond default read access)");
  } else {
    for (const cat of grants) {
      out.push(`  - ${describeCategory(cat)}`);
    }
  }
  out.push("");

  out.push("Not authorized:");
  if (opts.refused_categories.length === 0) {
    out.push("  (everything the agent intends to do is in the authorized list above)");
  } else {
    for (const cat of opts.refused_categories) {
      out.push(`  - ${describeCategory(cat)}`);
    }
    out.push("");
    out.push("  If the agent needs any of these during execution, I'll ask you in plain English first.");
  }
  out.push("");

  if (opts.learnedProfileSummary) {
    out.push(opts.learnedProfileSummary);
    out.push("");
  }
  if (opts.memorySummary) {
    out.push(opts.memorySummary);
    out.push("");
  }

  // Out-of-scope from the agent's draft, if any. Plain-language render.
  const out_of_scope = (opts.proposal.draft_brief.out_of_scope ?? []);
  if (out_of_scope.length > 0) {
    out.push("Explicitly out of scope:");
    for (const item of out_of_scope) out.push(`  - ${item}`);
    out.push("");
  }

  out.push("Proceed? (yes / no / change something)");
  return out.join("\n");
}
