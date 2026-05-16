// Combines the executor's per-sub-task outputs into a single final report
// the operator sees as the brief's Phase 4 result. Pure; the driver
// supplies the inputs and writes the output.

import type { ExecutionHandoff, ReviewHandoff, PlanHandoff } from "../types.js";

export interface AggregatedResult {
  // Markdown-formatted final report.
  text: string;
  // Counts for transcript metadata.
  total_subtasks: number;
  passed: number;
  failed: number;
  escalated: number;
}

export interface SubtaskOutcome {
  id: string;
  title: string;
  execution?: ExecutionHandoff;
  review?: ReviewHandoff;
  // True when this sub-task was escalated; the operator may have decided
  // to skip it or merge a partial result.
  escalated?: boolean;
  // True when the sub-task was skipped (not attempted).
  skipped?: boolean;
}

export function aggregateResults(input: {
  plan: PlanHandoff;
  outcomes: SubtaskOutcome[];
}): AggregatedResult {
  const { plan, outcomes } = input;
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  let passed = 0;
  let failed = 0;
  let escalated = 0;

  const sections: string[] = [];
  sections.push("# Phase 4: Completion (multi-agent)");
  sections.push("");
  sections.push(`Project plan rationale: ${plan.rationale || "(no rationale)"}`);
  sections.push("");
  sections.push(`Total sub-tasks: ${plan.subtasks.length}`);

  for (const st of plan.subtasks) {
    const outcome = byId.get(st.id);
    const status = !outcome
      ? "skipped"
      : outcome.escalated
        ? "escalated"
        : outcome.review?.verdict === "pass"
          ? "passed"
          : outcome.review?.verdict === "fail"
            ? "failed"
            : "incomplete";
    if (status === "passed") passed++;
    else if (status === "failed") failed++;
    else if (status === "escalated") escalated++;

    sections.push("");
    sections.push(`## ${st.order + 1}. ${st.title} (${status})`);
    sections.push("");
    sections.push(`**Instruction:** ${st.instruction}`);
    if (outcome?.execution?.output) {
      sections.push("");
      sections.push("**Output:**");
      sections.push("");
      sections.push(outcome.execution.output.trim());
    }
    if (outcome?.review?.rationale) {
      sections.push("");
      sections.push(`**Review:** ${outcome.review.rationale.trim()}`);
    }
  }

  sections.push("");
  sections.push(`Summary: ${passed} passed, ${failed} failed, ${escalated} escalated.`);

  return {
    text: sections.join("\n"),
    total_subtasks: plan.subtasks.length,
    passed,
    failed,
    escalated,
  };
}
