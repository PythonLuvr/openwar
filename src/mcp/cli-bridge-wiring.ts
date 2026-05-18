// v0.7: runner-side wiring for cli-bridge MCP-server-mode.
//
// When the adapter is cli-bridge and the brief's cli.mcp_forward is not
// disabled, the runner:
//   1. Looks up the bridged CLI in the bridged-cli-registry.
//   2. Writes a temp MCP config file pointing at `node bin/openwar mcp-serve ...`.
//   3. Injects the CLI-specific config args into the adapter via addExtraArgs.
//   4. Emits a startup warning when the bridged binary is unknown so the
//      operator sees the fallback path explicitly.
//   5. At session end, replays the per-session tool log into the OpenWar
//      transcript so MCP-mediated tool calls are visible to `openwar inspect`.

import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath, join } from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Brief, RunnerIO, ToolCallRecord } from "../types.js";
import type { CliBridgeAdapter } from "../adapters/cli-bridge.js";
import { resolveBridgedCliStrategy, buildMcpConfigFile } from "./bridged-cli-registry.js";
import { upsertTomlSection } from "./toml-writer.js";

export interface CliBridgeMcpSetup {
  enabled: boolean;
  // Path to the per-session JSONL log of MCP-mediated tool calls. Replayed
  // into the transcript at session end.
  toolLogPath: string;
  // Path to the MCP config file passed to the bridged CLI. May be a temp
  // path (Claude Code, fallback) or a CLI-known location (Gemini CLI's
  // .gemini/settings.json under the workdir).
  configPath: string;
  // Display name from the registry (or "unknown") for diagnostics.
  bridgedCliName: string;
  // True when the bridged CLI is in the known registry; false when the
  // operator's binary triggered the fallback (config written but CLI args
  // not injected, with a startup warning).
  known: boolean;
  // Whether to delete the config file at session end. True for temp paths;
  // false when the strategy wrote to a CLI-known location the operator
  // expects to persist (e.g. Gemini's .gemini/settings.json).
  cleanupConfigFile: boolean;
}

export interface SetupOptions {
  brief: Brief;
  adapter: CliBridgeAdapter;
  io: RunnerIO;
  workdir: string;
  briefId: string;
  // Override the openwar CLI binary path. Defaults to the bin shim of the
  // currently-running openwar package. Tests can override.
  openwarBin?: string;
}

// The openwar CLI binary path. Resolves from the dist directory at runtime.
function defaultOpenwarBin(): string {
  // dist/mcp/cli-bridge-wiring.js is __filename. The bin shim is
  // ../../bin/openwar relative to that.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..", "..", "bin", "openwar");
}

function defaultToolLogPath(briefId: string): string {
  return join(tmpdir(), `openwar-mcp-tool-log-${briefId}-${randomBytes(4).toString("hex")}.jsonl`);
}

function defaultConfigPath(briefId: string): string {
  return join(tmpdir(), `openwar-mcp-config-${briefId}-${randomBytes(4).toString("hex")}.json`);
}

export async function setupCliBridgeMcpForwarding(
  opts: SetupOptions,
): Promise<CliBridgeMcpSetup | null> {
  // Default true. Operator must explicitly opt out to disable.
  const forwardEnabled = opts.brief.frontmatter.cli?.mcp_forward !== false;
  if (!forwardEnabled) {
    opts.io.write(
      "openwar: cli-bridge MCP forwarding disabled via cli.mcp_forward: false. " +
        "Bridged CLI will only see its own native tools.\n",
    );
    return null;
  }

  // Resolve the bridged binary from the adapter. CliBridgeAdapter exposes
  // model = binary by default, which is the cleanest accessor without
  // widening the public surface.
  const binary = opts.adapter.model;
  const strategy = resolveBridgedCliStrategy(binary);

  const toolLogPath = defaultToolLogPath(opts.briefId);
  const defaultCfg = defaultConfigPath(opts.briefId);
  // v0.7.0 (Gemini): the strategy may override where to write the config
  // file. Default keeps the temp-file behavior Claude Code expects.
  const configPath = strategy.configPath
    ? strategy.configPath({ workdir: opts.workdir, briefId: opts.briefId, defaultTmpPath: defaultCfg })
    : defaultCfg;
  const cleanupConfigFile = strategy.cleanupConfigFile !== false;

  // Compose the MCP server invocation. The bridged CLI will spawn this
  // command via its MCP config and talk JSON-RPC to it on stdio.
  const openwarBin = opts.openwarBin ?? defaultOpenwarBin();
  const serverArgs = [
    "mcp-serve",
    "--workdir", opts.workdir,
    "--authorized-costs", opts.brief.frontmatter.authorized_costs.join(","),
    ...(opts.brief.frontmatter.project ? ["--project", opts.brief.frontmatter.project] : []),
    ...(opts.briefId ? ["--brief-id", opts.briefId] : []),
    "--tool-log-path", toolLogPath,
  ];

  if (strategy.writeConfigFile) {
    const content = buildMcpConfigFile({
      serverCommand: "node",
      serverArgs: [openwarBin, ...serverArgs],
    });
    await mkdir(dirname(configPath), { recursive: true });
    // v0.7.1: per-strategy serializer (default JSON). Codex returns TOML.
    const serialized = strategy.serializeConfig
      ? strategy.serializeConfig(content)
      : JSON.stringify(content, null, 2);
    // v0.7.1: optional merge-into-existing. Codex sets this true so we
    // don't clobber operator hand-edits to other sections of config.toml.
    if (strategy.mergeIntoExisting && existsSync(configPath)) {
      const existing = await readFile(configPath, "utf8");
      const sectionHeader = strategy.mergeSectionHeader ?? "mcp_servers.openwar";
      // The serialized output is one [section]\nkey=val\n... block. Strip
      // the leading "[header]\n" so upsertTomlSection's body argument is
      // just the field lines; the helper re-adds the header verbatim.
      const headerLine = `[${sectionHeader}]\n`;
      const body = serialized.startsWith(headerLine)
        ? serialized.slice(headerLine.length).replace(/\n+$/, "")
        : serialized.replace(/\n+$/, "");
      const merged = upsertTomlSection(existing, sectionHeader, body);
      await writeFile(configPath, merged, "utf8");
    } else {
      await writeFile(configPath, serialized, "utf8");
    }
  }

  const cliArgs = strategy.buildArgs({
    configPath,
    serverCommand: "node",
    serverArgs: [openwarBin, ...serverArgs],
  });
  if (cliArgs.length > 0) {
    opts.adapter.addExtraArgs(cliArgs);
  }

  if (!strategy.mcp_supported) {
    opts.io.warn(
      `cli-bridge: "${binary}" is not in OpenWar's known-MCP-bridged-CLI registry. ` +
        `Wrote an MCP config to ${configPath} pointing at the OpenWar tool server, ` +
        `but did not inject CLI args because the registry does not know how this CLI ` +
        `consumes MCP config. Wire it manually if needed, or set cli.mcp_forward: false ` +
        `in the brief to fall back to stdout-only mode. v0.7.1+ adds Codex / aider entries.`,
    );
  }

  return {
    enabled: true,
    toolLogPath,
    configPath,
    bridgedCliName: strategy.display_name,
    known: strategy.mcp_supported,
    cleanupConfigFile,
  };
}

// Read the MCP server's tool log and fold each entry into the OpenWar
// transcript as a ToolCallRecord. Idempotent; the log file is deleted after
// successful replay so we don't double-count on resume.
export async function replayMcpToolLog(
  setup: CliBridgeMcpSetup,
): Promise<ToolCallRecord[]> {
  if (!existsSync(setup.toolLogPath)) return [];
  const out: ToolCallRecord[] = [];
  const raw = await readFile(setup.toolLogPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        call_id: string;
        name: string;
        arguments: unknown;
        at: string;
        authorized: boolean;
        auth_note?: string;
        denied_by?: string;
        result?: { success: boolean; content_preview: string };
      };
      out.push({
        call_id: parsed.call_id,
        name: parsed.name,
        arguments: parsed.arguments,
        at: parsed.at,
        authorized: parsed.authorized,
        ...(parsed.auth_note && { auth_note: parsed.auth_note }),
        ...(parsed.result && {
          result: {
            success: parsed.result.success,
            content: parsed.result.content_preview,
            meta: { via: "mcp_bridge", ...(parsed.denied_by && { denied_by: parsed.denied_by }) },
          },
        }),
      });
    } catch {
      // Skip corrupted lines silently; transcript should not block on a
      // malformed row from a crashed bridged session.
    }
  }
  try { await unlink(setup.toolLogPath); } catch { /* swallow */ }
  // v0.7.0 Gemini: skip config file cleanup when the strategy wrote to a
  // CLI-known location (the operator wants the wiring sticky for next runs).
  if (setup.cleanupConfigFile) {
    try { await unlink(setup.configPath); } catch { /* swallow */ }
  }
  return out;
}
