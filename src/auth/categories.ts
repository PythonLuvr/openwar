// Authorization categories. Brief.authorized_costs lists items from this set
// (or wildcards over it). Every tool call is checked against this list at the
// boundary between LLM intent and sandbox execution.
//
// MCP categories are dynamic ("mcp_tool:<server>" or
// "mcp_tool:<server>:<tool>") and represented as template literal types.

export const AUTH_CATEGORIES_STATIC = [
  "filesystem_read",
  "filesystem_write",
  "filesystem_delete",
  "shell_exec",
  "http_fetch",
  "paid_api_call",
  "git_write",
  "git_push",
  "deploy",
  "external_message",
] as const;

export type AuthCategoryStatic = (typeof AUTH_CATEGORIES_STATIC)[number];

// MCP category shapes. Server name and tool name are free-form strings the
// runtime resolves from the MCP registry; we only type the prefix.
export type AuthCategoryMcpServer = `mcp_tool:${string}`;
export type AuthCategoryMcpTool = `mcp_tool:${string}:${string}`;

export type AuthCategory = AuthCategoryStatic | AuthCategoryMcpServer | AuthCategoryMcpTool;

// Default-allowed categories. Reads are not destructive; everything else
// requires explicit pre-approval in authorized_costs or a Phase 3 prompt.
export const DEFAULT_ALLOWED: ReadonlySet<AuthCategoryStatic> = new Set([
  "filesystem_read",
]);

export function isStaticCategory(s: string): s is AuthCategoryStatic {
  return (AUTH_CATEGORIES_STATIC as readonly string[]).includes(s);
}

export function isMcpCategory(s: string): s is AuthCategoryMcpServer | AuthCategoryMcpTool {
  return s.startsWith("mcp_tool:");
}

// Parse "mcp_tool:server" or "mcp_tool:server:tool" into parts.
// Returns null for malformed input.
export function parseMcpCategory(s: string): { server: string; tool?: string } | null {
  if (!s.startsWith("mcp_tool:")) return null;
  const rest = s.slice("mcp_tool:".length);
  if (rest.length === 0) return null;
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) return { server: rest };
  const server = rest.slice(0, firstColon);
  const tool = rest.slice(firstColon + 1);
  if (server.length === 0 || tool.length === 0) return null;
  return { server, tool };
}
