// Authorization gate for tool calls. Runs at the boundary between
// "the LLM said call this tool" and "the sandbox actually runs it."
//
// Inputs:
//   - The tool definition (which categories does this tool require?)
//   - authorized_costs from the brief frontmatter
//   - A session-level set of categories approved at Phase 3 (operator
//     answered "Y" for session-wide on a prior call)
//
// Output: AuthDecision. allowed=false means the runtime must enter Phase 3
// and prompt the operator. After approval, the runtime re-runs the check
// with the session-approved set updated.

import type { AuthCategory } from "./categories.js";
import { DEFAULT_ALLOWED, isStaticCategory } from "./categories.js";
import { matchesAuthorization } from "./wildcards.js";
import type { ToolDefinition } from "../tools/types.js";

export interface AuthDecision {
  allowed: boolean;
  // The full required-category list from the tool definition.
  required_categories: readonly AuthCategory[];
  // Categories that were neither in authorized_costs nor session-approved
  // nor default-allowed. These are what the Phase 3 prompt asks about.
  missing_categories: readonly AuthCategory[];
}

export interface AuthCheckInput {
  tool: ToolDefinition;
  authorizedCosts: readonly string[];
  // Categories the operator approved session-wide at a prior Phase 3 prompt.
  // Runtime tracks this in SessionMeta; the check itself is pure.
  sessionApproved?: readonly string[];
}

function isCovered(
  cat: AuthCategory,
  authorizedCosts: readonly string[],
  sessionApproved: readonly string[],
): boolean {
  if (isStaticCategory(cat) && DEFAULT_ALLOWED.has(cat)) return true;
  for (const entry of authorizedCosts) {
    if (matchesAuthorization(cat, entry)) return true;
  }
  for (const entry of sessionApproved) {
    if (matchesAuthorization(cat, entry)) return true;
  }
  return false;
}

export function checkAuthorization(input: AuthCheckInput): AuthDecision {
  const sessionApproved = input.sessionApproved ?? [];
  const required = input.tool.authorization_categories;
  const missing: AuthCategory[] = [];
  for (const cat of required) {
    if (!isCovered(cat, input.authorizedCosts, sessionApproved)) {
      missing.push(cat);
    }
  }
  return {
    allowed: missing.length === 0,
    required_categories: required,
    missing_categories: missing,
  };
}
