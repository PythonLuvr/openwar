// v0.12.0: request_permission native tool.
//
// Bridged CLIs (and any tool-calling adapter) call this BEFORE attempting
// a potentially-destructive action. The runtime prompts the operator (or
// denies-by-default in headless non-TTY mode) and returns a structured
// grant or denial. The grant is registered in the per-session
// GrantLedger; Phase 3 honors matching grants instead of re-prompting on
// the subsequent destructive call.
//
// This tool itself is NEVER destructive. Requesting permission is just
// asking. `authorization_categories: []` means default-allowed; the auth
// gate does not apply.
//
// IO + ledger access come via `ctx.io` and `ctx.grantLedger`, which the
// runner populates on the session's SandboxContext at run start. Tests /
// minimal sandboxes without those fields surface a structured error
// result so callers see a clear failure shape rather than a thrown
// exception. The brief's design note: PermissionBridge degrades
// gracefully when wired into a stripped-down sandbox.

import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from "../types.js";
import type { PermissionScope, Grant } from "../../types.js";

export const REQUEST_PERMISSION_DEFINITION: ToolDefinition = {
  name: "request_permission",
  description:
    "Ask the operator for permission to perform a potentially-destructive action BEFORE attempting it. " +
    "Returns a grant id if approved; Phase 3 honors the grant on the subsequent tool call without re-prompting. " +
    "Scope controls grant lifetime: this_call covers exactly one upcoming destructive call, this_session " +
    "lasts until session end, persistent saves to project memory and survives across sessions.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Concrete description of the action. The operator reads this verbatim; write it like you would explain to a peer.",
      },
      scope: {
        type: "string",
        enum: ["this_call", "this_session", "persistent"],
        default: "this_call",
        description: "How long this grant should live.",
      },
      reasoning: {
        type: "string",
        description: "Why the action is needed. One or two sentences.",
      },
      fallback: {
        type: "string",
        description: "Optional. What you will do if denied. Helps the operator gauge cost of denial.",
      },
      category: {
        type: "string",
        description: "Optional auth category tag for grant matching (e.g. filesystem_write, shell_exec). Phase 3 matches grants to upcoming destructive calls by category.",
      },
    },
    required: ["action", "reasoning"],
  },
  origin: "native",
  // Requesting permission is itself never destructive. Default-allowed.
  authorization_categories: [],
};

interface ParsedArgs {
  action: string;
  scope: PermissionScope;
  reasoning: string;
  fallback: string | null;
  category: string | null;
}

function parseArgs(call: ToolCall): ParsedArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.action !== "string" || a.action.trim() === "") {
    return { error: "action must be a non-empty string" };
  }
  if (typeof a.reasoning !== "string" || a.reasoning.trim() === "") {
    return { error: "reasoning must be a non-empty string" };
  }
  let scope: PermissionScope = "this_call";
  if (a.scope !== undefined) {
    if (a.scope !== "this_call" && a.scope !== "this_session" && a.scope !== "persistent") {
      return { error: 'scope must be one of "this_call", "this_session", "persistent"' };
    }
    scope = a.scope;
  }
  let fallback: string | null = null;
  if (a.fallback !== undefined) {
    if (typeof a.fallback !== "string") return { error: "fallback must be a string if provided" };
    fallback = a.fallback;
  }
  let category: string | null = null;
  if (a.category !== undefined) {
    if (typeof a.category !== "string") return { error: "category must be a string if provided" };
    category = a.category;
  }
  return { action: a.action, scope, reasoning: a.reasoning, fallback, category };
}

function failResult(call: ToolCall, code: string, message: string): ToolResult {
  return {
    call_id: call.id,
    success: false,
    content: message,
    error: { code, message },
  };
}

// Build the multi-line prompt the operator sees in the chat REPL or on
// stderr in headless mode. Format B from Phase 0:
//   Permission request from agent:
//     ACTION    ...
//     REASON    ...
//     FALLBACK  ...                <-- omitted line if no fallback
//     REQUESTED SCOPE  this_call
//
//   Approve at what scope?
//     y         grant at requested scope (...)
//     s         grant for the rest of this session
//     p         grant persistently (saved to project memory)
//     n         deny
//     n: <msg>  deny with a note for the agent
//   >
export function renderPermissionPrompt(parsed: ParsedArgs): string {
  const lines: string[] = [];
  lines.push("Permission request from agent:");
  lines.push(`  ACTION    ${parsed.action}`);
  lines.push(`  REASON    ${parsed.reasoning}`);
  if (parsed.fallback) lines.push(`  FALLBACK  ${parsed.fallback}`);
  if (parsed.category) lines.push(`  CATEGORY  ${parsed.category}`);
  lines.push(`  REQUESTED SCOPE  ${parsed.scope}`);
  lines.push("");
  lines.push("Approve at what scope?");
  lines.push(`  y         grant at requested scope (${parsed.scope})`);
  lines.push("  s         grant for the rest of this session");
  lines.push("  p         grant persistently (saved to project memory)");
  lines.push("  n         deny");
  lines.push("  n: <msg>  deny with a note for the agent");
  return lines.join("\n");
}

// Parse the operator response. Returns the granted scope ("denied" if
// rejected), plus an optional operator note for denials. Tolerant of
// whitespace + casing. Unknown responses are treated as deny.
export interface OperatorResponse {
  granted: boolean;
  scope_granted: PermissionScope | null;
  operator_note: string;
}

export function parseOperatorReply(reply: string, requestedScope: PermissionScope): OperatorResponse {
  const trimmed = reply.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "y" || trimmed.toLowerCase() === "yes") {
    return { granted: true, scope_granted: requestedScope, operator_note: "" };
  }
  const lower = trimmed.toLowerCase();
  if (lower === "s") return { granted: true, scope_granted: "this_session", operator_note: "" };
  if (lower === "p") return { granted: true, scope_granted: "persistent", operator_note: "" };
  // n: <note> form. Case-insensitive prefix.
  if (/^n\s*:/i.test(trimmed)) {
    const note = trimmed.replace(/^n\s*:\s*/i, "");
    return { granted: false, scope_granted: null, operator_note: note };
  }
  if (lower === "n" || lower === "no") {
    return { granted: false, scope_granted: null, operator_note: "" };
  }
  // Unknown response: treat as deny with the raw text as the note (so the
  // agent sees what the operator actually typed). Defensive, not pretty.
  return { granted: false, scope_granted: null, operator_note: `(unrecognized response: ${trimmed})` };
}

// Build the structured tool-result the LLM sees. Mirrors the brief's
// output schema exactly.
function grantResult(call: ToolCall, grant: Grant, operator_note: string): ToolResult {
  const body = {
    granted: true,
    scope_granted: grant.scope,
    operator_note,
    grant_id: grant.grant_id,
  };
  return {
    call_id: call.id,
    success: true,
    content: JSON.stringify(body),
  };
}

function denyResult(call: ToolCall, grant_id: string, operator_note: string): ToolResult {
  const body = {
    granted: false,
    operator_note,
    grant_id,
  };
  return {
    call_id: call.id,
    // Denial is not an error; the agent decides what to do next. success=true
    // so the model treats it as a normal tool result and reads the JSON body.
    success: true,
    content: JSON.stringify(body),
  };
}

import { randomUUID } from "node:crypto";

export const requestPermissionExecutor: ToolExecutor = async (
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> => {
  const parsed = parseArgs(call);
  if ("error" in parsed) return failResult(call, "INVALID_ARGS", parsed.error);

  const ledger = ctx.grantLedger;
  if (!ledger) {
    return failResult(
      call,
      "NO_LEDGER",
      "request_permission requires a grant ledger on the sandbox context. The runner populates this automatically; bare contexts (tests, minimal sandboxes) cannot grant permissions.",
    );
  }

  // The trace emits a stable grant_id for `permission_requested` even
  // before the operator answers (so denials carry the same id). The id
  // of the actual ledger grant on approval is generated by addGrant; we
  // emit the granted event with that id afterward.
  const requestId = randomUUID();
  const requestedAt = new Date().toISOString();
  ctx.tracer?.emit({
    type: "permission_requested",
    grant_id: requestId,
    action: parsed.action,
    category: parsed.category,
    scope_requested: parsed.scope,
    reasoning: parsed.reasoning,
    fallback: parsed.fallback,
    at: requestedAt,
  });

  const io = ctx.io;
  if (!io) {
    // Headless / minimal context: deny by default with a structured note
    // so the agent knows there is no operator to ask.
    ctx.tracer?.emit({
      type: "permission_denied",
      grant_id: requestId,
      operator_note: "no interactive operator available",
      at: new Date().toISOString(),
    });
    return denyResult(call, requestId, "no interactive operator available");
  }

  // Render the prompt and ask the operator.
  const prompt = renderPermissionPrompt(parsed);
  io.write(prompt + "\n");
  let reply: string;
  try {
    reply = await io.prompt("> ");
  } catch (err) {
    return failResult(call, "PROMPT_FAILED", `operator prompt failed: ${(err as Error).message}`);
  }
  const response = parseOperatorReply(reply, parsed.scope);

  if (!response.granted) {
    ctx.tracer?.emit({
      type: "permission_denied",
      grant_id: requestId,
      operator_note: response.operator_note,
      at: new Date().toISOString(),
    });
    return denyResult(call, requestId, response.operator_note);
  }

  // Approve at the operator's chosen scope (may differ from requested).
  const finalScope = response.scope_granted ?? parsed.scope;
  const grant = ledger.addGrant({
    action: parsed.action,
    category: parsed.category,
    scope: finalScope,
    reasoning: parsed.reasoning,
  });
  ctx.tracer?.emit({
    type: "permission_granted",
    grant_id: grant.grant_id,
    scope_granted: grant.scope,
    operator_note: response.operator_note,
    at: new Date().toISOString(),
  });
  return grantResult(call, grant, response.operator_note);
};
