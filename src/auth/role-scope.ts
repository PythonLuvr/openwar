// Per-role authorization scoping (v0.4). On top of the brief-level
// authorized_costs check, every tool call is also checked against the
// role's own tool_categories allowlist. The two checks compose:
//
//   1. Role scope check: is this tool's category in the role's allowlist?
//      If no, this is a *programming error* (the coordinator routed a tool
//      call to a role that shouldn't have it). Halt the coordinator.
//
//   2. Brief authorization check: does the brief's authorized_costs cover
//      the tool's categories? If no, run the Phase 3 operator prompt.
//
// The role-scope check is therefore fail-closed and structural; the brief
// check is the operator-decision gate.

import type { ToolDefinition } from "../tools/types.js";
import type { RoleDefinition } from "../types.js";
import { matchesAuthorization } from "./wildcards.js";

export interface RoleScopeDecision {
  in_scope: boolean;
  missing_categories: string[];
}

// Pure. Returns whether the tool's required auth categories are all covered
// by the role's tool_categories allowlist (plus a free `read_file` if the
// role opted in via `allow_read_file`).
export function checkRoleScope(input: {
  tool: ToolDefinition;
  role: RoleDefinition;
}): RoleScopeDecision {
  const required = input.tool.authorization_categories;

  // Special exemption: read_file (and other tools that only require
  // filesystem_read) is allowed for any role with allow_read_file: true,
  // regardless of the role's tool_categories list.
  const onlyReads =
    required.length === 0 ||
    required.every((c) => c === "filesystem_read");
  if (onlyReads && input.role.allow_read_file) {
    return { in_scope: true, missing_categories: [] };
  }

  const allowed = input.role.tool_categories;
  const missing: string[] = [];
  for (const cat of required) {
    if (cat === "filesystem_read" && input.role.allow_read_file) continue;
    let covered = false;
    for (const entry of allowed) {
      if (matchesAuthorization(cat, entry)) { covered = true; break; }
    }
    if (!covered) missing.push(cat);
  }
  return { in_scope: missing.length === 0, missing_categories: missing };
}

// Thrown when the coordinator detects a role-scope violation. Distinct from
// a Phase 3 prompt: this represents a programming bug or a misconfigured
// custom role, not an operator decision.
export class RoleScopeViolation extends Error {
  readonly code = "ROLE_SCOPE_VIOLATION" as const;
  constructor(
    public readonly role_id: string,
    public readonly tool_name: string,
    public readonly missing_categories: string[],
  ) {
    super(
      `Role "${role_id}" attempted to call "${tool_name}" but its scope ` +
        `does not include: ${missing_categories.join(", ")}`,
    );
    this.name = "RoleScopeViolation";
  }
}
