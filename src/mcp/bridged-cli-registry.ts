// v0.7: registry of known bridged-CLI MCP config-injection strategies.
//
// Different CLI agents accept MCP server configuration differently. Claude
// Code reads a JSON config and accepts an `--mcp-config <path>` flag.
// Codex and aider have their own shapes; v0.7.0 ships Claude Code only,
// the others land in v0.7.1+ per the operator-approved v0.7.0 scope.
//
// Unknown binaries fall back to writing a generic MCP config file in the
// workdir and emitting a startup warning so the operator sees the gap.
//
// Registry keys are matched against the basename of the configured CLI
// binary (lowercased, `.cmd` / `.bat` stripped). This handles
// `--cli-binary claude`, `--cli-binary claude.cmd`, and absolute paths.

import { basename } from "node:path";

export interface BridgedCliStrategy {
  // CLI agent display name (for warnings + docs).
  display_name: string;
  // Whether OpenWar knows this CLI accepts MCP server configuration.
  // false means "fall back to temp-config-file + startup warning".
  mcp_supported: boolean;
  // Extra CLI args to inject before the user's args. Receives:
  //   - The path to the OpenWar-written MCP config file.
  //   - The MCP server command Claude Code (or equivalent) should spawn.
  //   - The MCP server arguments.
  // Returns the args to append to the bridged CLI invocation. Returns []
  // for fallback strategies (the CLI doesn't accept config-on-CLI).
  buildArgs(opts: { configPath: string; serverCommand: string; serverArgs: string[] }): string[];
  // Whether to write the temp MCP config file at all. Some CLIs read config
  // from a known location instead of accepting a path; future entries can
  // set this false.
  writeConfigFile: boolean;
}

// Map of binary basename → strategy. Match is case-insensitive; .cmd / .bat
// extensions are stripped at lookup time.
const STRATEGIES = new Map<string, BridgedCliStrategy>([
  ["claude", {
    display_name: "Claude Code",
    mcp_supported: true,
    writeConfigFile: true,
    buildArgs: ({ configPath }) => ["--mcp-config", configPath],
  }],
]);

// Fallback used when the binary is unknown. Writes the config file, does not
// inject CLI args (we don't know how this CLI consumes config). Caller emits
// a startup warning so the operator can wire the config manually.
const FALLBACK_STRATEGY: BridgedCliStrategy = {
  display_name: "unknown bridged CLI",
  mcp_supported: false,
  writeConfigFile: true,
  buildArgs: () => [],
};

function normalizeBinary(binary: string): string {
  const base = basename(binary).toLowerCase();
  return base.replace(/\.(cmd|bat|exe)$/i, "");
}

export function resolveBridgedCliStrategy(binary: string): BridgedCliStrategy {
  const key = normalizeBinary(binary);
  return STRATEGIES.get(key) ?? FALLBACK_STRATEGY;
}

// Public for tests and future operator-contributed entries. Returns the list
// of CLI agents OpenWar knows how to wire MCP forwarding for.
export function listKnownBridgedClis(): Array<{ key: string; display_name: string }> {
  return [...STRATEGIES.entries()].map(([key, s]) => ({ key, display_name: s.display_name }));
}

// Build the MCP config file content. Standard Claude-Code-shaped JSON; other
// CLIs that support a similar config can layer on top. v0.7.0 emits this
// shape unconditionally because every entry in the registry expects it.
export interface McpConfigFileContent {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

export function buildMcpConfigFile(opts: {
  serverName?: string;
  serverCommand: string;
  serverArgs: string[];
  env?: Record<string, string>;
}): McpConfigFileContent {
  const name = opts.serverName ?? "openwar";
  return {
    mcpServers: {
      [name]: {
        command: opts.serverCommand,
        args: opts.serverArgs,
        ...(opts.env && { env: opts.env }),
      },
    },
  };
}
