// v0.6: per-role memory visibility for inherit_memory mode.
//
// Visibility decision (locked in v0.6 Phase 0):
//   planner   sees all three categories (full project context for planning)
//   reviewer  sees all three categories (full context to judge against)
//   executor  sees constraints + knowledge only (no decisions)
//   critic    sees all three categories (independent re-review)
//   <other>   sees all three categories (custom roles default to full view)
//   null      (single-agent / no role) sees all three categories
//
// Rationale: decisions are "why we went with X" records that bias execution
// toward past patterns. Reviewer needs that bias to evaluate consistency;
// executor should solve the current sub-task on its own merits and let the
// reviewer raise prior-decisions concerns if needed.

import type { RoleId } from "../types.js";
import {
  renderMemoryForPrompt,
  MEMORY_CATEGORIES,
  type MemoryCategory,
} from "../state/memory.js";

export function categoriesForRole(roleId: RoleId | null): MemoryCategory[] {
  if (roleId === "executor") {
    return ["constraints", "knowledge"];
  }
  return [...MEMORY_CATEGORIES];
}

export async function renderMemoryForRole(
  projectSlug: string,
  roleId: RoleId | null,
  perCategoryLimit = 20,
): Promise<string> {
  return renderMemoryForPrompt(projectSlug, {
    perCategoryLimit,
    categories: categoriesForRole(roleId),
  });
}
