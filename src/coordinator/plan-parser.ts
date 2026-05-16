// Wraps the handoff parser to specifically extract a PlanHandoff from
// planner output. Returns a discriminated result the driver uses to decide
// between retry (one shot) and escalation.

import type { PlanHandoff, Brief } from "../types.js";
import { parseHandoffFromText } from "../orchestration/handoff.js";

export type ParsePlanResult =
  | { ok: true; plan: PlanHandoff }
  | { ok: false; reason: "no_fence" | "bad_json" | "validation"; message: string };

export function parsePlanFromText(text: string): ParsePlanResult {
  const res = parseHandoffFromText(text);
  if (!res.ok) return res;
  if (res.handoff.kind !== "plan") {
    return {
      ok: false,
      reason: "validation",
      message: `expected plan handoff, got "${res.handoff.kind}"`,
    };
  }
  return { ok: true, plan: res.handoff };
}

// Post-parse scope check: ensure the plan does not include sub-tasks that
// reference categories outside the brief's authorized_costs. We do this by
// scanning the sub-task instruction text for keywords matching unauthorized
// categories. Conservative; flags as warnings, not errors. The reviewer is
// still the final scope check.
export interface ScopeWarning {
  subtask_id: string;
  category: string;
  match: string;
}

const CATEGORY_KEYWORDS: Array<{ category: string; pattern: RegExp }> = [
  { category: "shell_exec", pattern: /\b(?:run a shell command|execute via shell|spawn process|kill process)\b/i },
  { category: "filesystem_write", pattern: /\b(?:write to disk|create the file|overwrite|append to)\b/i },
  { category: "filesystem_delete", pattern: /\b(?:delete the|rm -rf|wipe|remove the directory)\b/i },
  { category: "http_fetch", pattern: /\b(?:fetch from the internet|curl|http get|http post|hit the api)\b/i },
  { category: "deploy", pattern: /\b(?:deploy to (?:prod|production|staging)|kubectl apply)\b/i },
  { category: "git_push", pattern: /\bgit push\b/i },
  { category: "git_write", pattern: /\bgit (?:commit|rebase|reset --hard|merge)\b/i },
];

export function scopeWarningsForPlan(plan: PlanHandoff, brief: Brief): ScopeWarning[] {
  const warnings: ScopeWarning[] = [];
  const authorized = new Set(brief.frontmatter.authorized_costs.map((s) => s.toLowerCase()));
  const wildcard = [...authorized].some((c) => c === "*" || c === "all");
  if (wildcard) return warnings;
  for (const st of plan.subtasks) {
    const text = `${st.title} ${st.instruction}`;
    for (const { category, pattern } of CATEGORY_KEYWORDS) {
      if (!authorized.has(category) && pattern.test(text)) {
        const m = pattern.exec(text);
        warnings.push({ subtask_id: st.id, category, match: m?.[0] ?? "" });
      }
    }
  }
  return warnings;
}
