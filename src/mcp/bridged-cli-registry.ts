// v0.7: registry of known bridged-CLI MCP config-injection strategies.
//
// Different CLI agents accept MCP server configuration differently. Three
// strategy axes:
//   1. Where the MCP config lives (default temp file, or a CLI-specific
//      known location like .gemini/settings.json).
//   2. Whether the CLI accepts a config-path flag or auto-discovers.
//   3. Whether the file should be cleaned up at session end.
//
// v0.7.0 ships entries for Claude Code (JSON config, --mcp-config flag,
// temp path) and Gemini CLI (JSON config, auto-discovered from a
// workdir-local .gemini/settings.json, no flag injection). Codex is
// deferred: its MCP config lives in ~/.codex/config.toml, which would
// require shipping a TOML serializer (significant scope vs the
// operator-approved straightforward bar). Aider stays on the unknown
// fallback path (no native MCP).
//
// Unknown binaries fall back to writing a generic MCP config file at the
// default temp path and emitting a startup warning so the operator sees the
// gap.
//
// Registry keys are matched against the basename of the configured CLI
// binary (lowercased, .cmd / .bat / .exe stripped). This handles
// --cli-binary claude, --cli-binary claude.cmd, and absolute paths.

import { basename, join } from "node:path";

export interface ConfigPathContext {
  workdir: string;
  briefId: string;
  // The runner-computed default temp-path. Strategies that override this
  // return their own path; strategies that don't override return this value.
  defaultTmpPath: string;
}

export interface BridgedCliStrategy {
  // CLI agent display name (for warnings + docs).
  display_name: string;
  // Whether OpenWar knows this CLI accepts MCP server configuration.
  // false means "fall back to temp-config-file + startup warning".
  mcp_supported: boolean;
  // Extra CLI args to inject before the user's args. Receives:
  //   - The path to the OpenWar-written MCP config file.
  //   - The MCP server command the CLI should spawn.
  //   - The MCP server arguments.
  // Returns the args to append to the bridged CLI invocation. Returns []
  // for strategies whose CLI auto-discovers config from a known path.
  buildArgs(opts: { configPath: string; serverCommand: string; serverArgs: string[] }): string[];
  // Whether to write the MCP config file at all. Some CLIs ignore config-on-
  // CLI entirely and need a file at a fixed location to work.
  writeConfigFile: boolean;
  // Where to write the config file. Default is the runner-computed temp
  // path. Strategies that need a known location (Gemini's .gemini/settings.json)
  // override to return that path. The runner creates parent directories.
  configPath?(ctx: ConfigPathContext): string;
  // Whether the runner should delete the config file at session end. True for
  // temp paths; false for known-location overrides where the operator may
  // want the config to persist for future runs.
  cleanupConfigFile?: boolean;
}

// Map of binary basename → strategy. Match is case-insensitive; .cmd / .bat /
// .exe extensions are stripped at lookup time.
const STRATEGIES = new Map<string, BridgedCliStrategy>([
  ["claude", {
    display_name: "Claude Code",
    mcp_supported: true,
    writeConfigFile: true,
    cleanupConfigFile: true,
    buildArgs: ({ configPath }) => ["--mcp-config", configPath],
  }],
  ["gemini", {
    display_name: "Gemini CLI",
    mcp_supported: true,
    writeConfigFile: true,
    // Gemini CLI auto-discovers MCP server config from a workdir-local
    // .gemini/settings.json. No CLI args needed. The file persists across
    // runs deliberately: an operator who wires Gemini's MCP forwarding
    // typically wants the wiring sticky.
    cleanupConfigFile: false,
    configPath: ({ workdir }) => join(workdir, ".gemini", "settings.json"),
    buildArgs: () => [],
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
