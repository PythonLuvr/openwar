// MCP server registry. Loads server configurations from:
//   1. ~/.openwar/mcp.json (global per-user)
//   2. Brief frontmatter `mcp_servers:` (per-session)
//
// Per-session entries take precedence on name collision.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerConfig {
  name: string;
  // Stdio servers: a shell-style command. We split on whitespace; first token is
  // the binary, rest are args. Quoted segments are not supported (keep config simple).
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface GlobalMcpConfig {
  servers?: McpServerConfig[];
}

const DEFAULT_PATH = join(homedir(), ".openwar", "mcp.json");

export async function loadGlobalMcpConfig(path: string = DEFAULT_PATH): Promise<McpServerConfig[]> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = JSON.parse(content) as GlobalMcpConfig;
    if (!parsed.servers) return [];
    if (!Array.isArray(parsed.servers)) {
      throw new Error(`${path}: "servers" must be an array`);
    }
    for (const s of parsed.servers) {
      if (typeof s.name !== "string" || s.name.length === 0) {
        throw new Error(`${path}: every server needs a non-empty "name"`);
      }
      if (typeof s.command !== "string" || s.command.length === 0) {
        throw new Error(`${path}: server "${s.name}" needs a "command"`);
      }
    }
    return parsed.servers;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

// Merge per-session (brief) configs over global configs by name.
export function mergeServerConfigs(
  global: McpServerConfig[],
  perSession: McpServerConfig[],
): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const s of global) byName.set(s.name, s);
  for (const s of perSession) byName.set(s.name, s);
  return [...byName.values()];
}

// Split a server.command string into [binary, ...args]. Whitespace-separated.
export function splitCommand(command: string): { bin: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") {
    throw new Error("empty command");
  }
  return { bin: parts[0]!, args: parts.slice(1) };
}
