// v0.7: OpenWar-native MCP server runtime.
//
// Bridges the McpServer (generic JSON-RPC framing) into OpenWar's native
// tool layer (read_file, write_file, list_dir, shell_exec, http_fetch,
// apply_patch, read_project_memory, write_project_memory).
//
// Booted by the `openwar mcp-serve` subcommand when a bridged CLI spawns
// this process as its MCP server. The bridged CLI then calls
// `openwar:<tool_name>` (standard MCP namespace prefix) and we execute
// the same code path the in-process runtime uses.
//
// Authorization: every call passes through checkAuthorization against the
// brief's authorized_costs (forwarded into this process via CLI flags).
// Rejected calls return an MCP isError result with a message prefixed
// "OpenWar denied:" so the operator can tell which layer rejected
// (the bridged CLI's own permission errors are not prefixed).
//
// Transcript capture: every call (allowed or denied) is appended to a
// per-session JSONL log at --tool-log-path. The parent runtime reads
// the log at session end and folds entries into the SessionMeta
// tool_calls list with meta.via = "mcp_bridge".

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer, rpcError, RPC_ERR_INVALID_PARAMS, RPC_ERR_OPENWAR_AUTH } from "./server.js";
import { MCP_PROTOCOL_VERSION, type CallToolParams, type CallToolResult, type ListToolsResult, type McpTool } from "./types.js";
import { NATIVE_TOOLS } from "../tools/native/index.js";
import { SandboxContext } from "../sandbox/types.js";
import { checkAuthorization } from "../auth/check.js";
import { loadHostAllowlist } from "../sandbox/host-allowlist.js";
import type { ToolCall } from "../tools/types.js";

export interface OpenwarMcpServerOpts {
  workdir: string;
  authorizedCosts: readonly string[];
  sessionApproved?: readonly string[];
  project_slug?: string;
  brief_id?: string;
  shellEnabled?: boolean;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  httpAllowlistPath?: string;
  // JSONL log path. Every call (allowed and denied) appends one record.
  toolLogPath?: string;
  // Override input/output streams (tests). Defaults to process.stdin/stdout.
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  // Override server name (tests). Defaults to "openwar".
  serverName?: string;
  serverVersion?: string;
}

// Tool name presented to the bridged CLI. We namespace with "openwar:" per
// the MCP convention so the bridged agent can distinguish OpenWar tools
// from its own native tools.
const NAMESPACE = "openwar:";

function exposedName(internalName: string): string {
  return NAMESPACE + internalName;
}

function internalName(exposedName: string): string | null {
  if (!exposedName.startsWith(NAMESPACE)) return null;
  return exposedName.slice(NAMESPACE.length);
}

export async function runOpenwarMcpServer(opts: OpenwarMcpServerOpts): Promise<McpServer> {
  // Build the sandbox once; every tool call shares it.
  let httpAllowlist = null;
  if (opts.httpAllowlistPath) {
    try { httpAllowlist = await loadHostAllowlist(opts.httpAllowlistPath); }
    catch { httpAllowlist = null; }
  }
  const sandbox = SandboxContext._create({
    workdir: opts.workdir,
    defaultTimeoutMs: opts.defaultTimeoutMs ?? 30_000,
    defaultMaxOutputBytes: opts.defaultMaxOutputBytes ?? 1_000_000,
    httpAllowlist,
    shellEnabled: opts.shellEnabled ?? true,
    ...(opts.project_slug && { project_slug: opts.project_slug }),
    ...(opts.brief_id && { brief_id: opts.brief_id }),
  });

  const server = new McpServer({
    input: (opts.input ?? process.stdin) as NodeJS.ReadableStream as import("node:stream").Readable,
    output: (opts.output ?? process.stdout) as NodeJS.WritableStream as import("node:stream").Writable,
    serverInfo: {
      name: opts.serverName ?? "openwar",
      version: opts.serverVersion ?? MCP_PROTOCOL_VERSION,
    },
  });

  server.setToolsListHandler((): ListToolsResult => {
    const tools: McpTool[] = [];
    for (const [name, t] of NATIVE_TOOLS.entries()) {
      tools.push({
        name: exposedName(name),
        ...(t.definition.description && { description: t.definition.description }),
        inputSchema: t.definition.input_schema as Record<string, unknown>,
      });
    }
    return { tools };
  });

  server.setCallToolHandler(async (params: CallToolParams): Promise<CallToolResult> => {
    if (!params || typeof params.name !== "string") {
      throw rpcError(RPC_ERR_INVALID_PARAMS, "OpenWar: tools/call params missing name");
    }
    const native = internalName(params.name);
    if (!native) {
      throw rpcError(
        RPC_ERR_INVALID_PARAMS,
        `OpenWar: tool name must be prefixed with "${NAMESPACE}"; got "${params.name}"`,
      );
    }
    const entry = NATIVE_TOOLS.get(native);
    if (!entry) {
      throw rpcError(
        RPC_ERR_INVALID_PARAMS,
        `OpenWar: unknown tool "${native}". Available: ${[...NATIVE_TOOLS.keys()].join(", ")}`,
      );
    }

    // Authorization. Mirror the in-process gate. Rejection here is the
    // "OpenWar denied" layer; the bridged CLI's own permission rejection
    // happens elsewhere (in the CLI's process) and surfaces as the bridged
    // agent declaring Phase 2.
    const auth = checkAuthorization({
      tool: entry.definition,
      authorizedCosts: opts.authorizedCosts,
      sessionApproved: opts.sessionApproved ?? [],
    });
    if (!auth.allowed) {
      const denyResult: CallToolResult = {
        content: [{
          type: "text",
          text:
            `OpenWar denied: tool "${native}" requires ${auth.missing_categories.join(", ")}, ` +
            `which is not in the brief's authorized_costs. ` +
            `Add it to the brief frontmatter or pre-approve in the OpenWar session.`,
        }],
        isError: true,
      };
      await appendToolLog(opts.toolLogPath, {
        call_id: randomUUID(),
        name: native,
        arguments: params.arguments ?? {},
        at: new Date().toISOString(),
        authorized: false,
        auth_note: `missing: ${auth.missing_categories.join(", ")}`,
        denied_by: "openwar",
      });
      return denyResult;
    }

    // Execute. Same code path as in-process. Errors bubble back to the
    // bridged CLI as MCP errors; the operator sees them prefixed.
    const call: ToolCall = {
      id: randomUUID(),
      name: native,
      arguments: (params.arguments ?? {}) as Record<string, unknown>,
    };
    const start = Date.now();
    try {
      const result = await entry.executor(call, sandbox);
      await appendToolLog(opts.toolLogPath, {
        call_id: call.id,
        name: native,
        arguments: call.arguments,
        at: new Date().toISOString(),
        authorized: true,
        result: { success: result.success, content_preview: result.content.slice(0, 500) },
        duration_ms: Date.now() - start,
      });
      return {
        content: [{ type: "text", text: result.content }],
        ...(!result.success && { isError: true }),
      };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      await appendToolLog(opts.toolLogPath, {
        call_id: call.id,
        name: native,
        arguments: call.arguments,
        at: new Date().toISOString(),
        authorized: true,
        result: { success: false, content_preview: msg.slice(0, 500) },
        duration_ms: Date.now() - start,
      });
      return {
        content: [{ type: "text", text: `OpenWar tool "${native}" threw: ${msg}` }],
        isError: true,
      };
    }
  });

  // Unused but reserved for future MCP methods.
  void RPC_ERR_OPENWAR_AUTH;

  return server;
}

// Append-only tool log entry. The parent runtime reads this back at session
// end and folds entries into the OpenWar transcript with meta.via = "mcp_bridge".
export interface ToolLogEntry {
  call_id: string;
  name: string;
  arguments: unknown;
  at: string;
  authorized: boolean;
  auth_note?: string;
  denied_by?: "openwar" | "bridged_cli";
  result?: { success: boolean; content_preview: string };
  duration_ms?: number;
}

async function appendToolLog(path: string | undefined, entry: ToolLogEntry): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Logging failure must not bring down the tool call. Bridged agent
    // already has the call result; the log is a parent-runtime convenience.
  }
}
