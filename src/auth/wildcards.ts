// Wildcard matching for authorization entries. Supported patterns:
//
//   "*"                       matches every category (with linter warning)
//   "mcp_tool:*"              matches any "mcp_tool:..." category
//   "mcp_tool:server:*"       matches any tool from the named MCP server
//                             (and the server umbrella itself)
//
// Exact entries match by string equality (case-sensitive; categories are
// lower_snake_case by convention).

import type { AuthCategory } from "./categories.js";

export function matchesAuthorization(required: AuthCategory, authorizedEntry: string): boolean {
  if (required === authorizedEntry) return true;
  if (authorizedEntry === "*") return true;
  if (authorizedEntry === "mcp_tool:*" && required.startsWith("mcp_tool:")) return true;
  if (authorizedEntry.startsWith("mcp_tool:") && authorizedEntry.endsWith(":*")) {
    const prefix = authorizedEntry.slice(0, -2);
    // "mcp_tool:server:*" matches "mcp_tool:server:anytool"
    if (required.startsWith(prefix + ":")) return true;
    // "mcp_tool:server:*" also matches the server umbrella "mcp_tool:server"
    if (required === prefix) return true;
  }
  return false;
}

// Emitted by brief lint when "*" appears in authorized_costs. Brief frontmatter
// validation surfaces this; it is not a hard error because operators may opt in
// deliberately. The runtime still runs.
export const WILDCARD_ALL_WARNING =
  "authorized_costs contains '*'. This authorizes every destructive category. " +
  "Almost always you want a specific list (filesystem_write, shell_exec, etc.).";

export function detectWildcardAllWarning(authorizedCosts: readonly string[]): string | null {
  return authorizedCosts.includes("*") ? WILDCARD_ALL_WARNING : null;
}
