// v0.13.0: parse + validate an incoming OpenAI Chat Completions JSON
// body into the typed OpenAIChatRequest shape. Defensive against the
// many fields OpenAI clients may include; tolerant of fields we do not
// recognize (per the brief: lowest-common-denominator surface).
//
// Returns a discriminated-union result so the router can map parse
// failures to OpenAI-shaped 400 errors without throwing across the
// async boundary.

import type { OpenAIChatRequest, OpenAIChatMessage, OpenAIErrorResponse } from "./types.js";

export type ParseResult =
  | { ok: true; request: OpenAIChatRequest }
  | { ok: false; status: 400; body: OpenAIErrorResponse };

export function parseChatRequest(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) {
    return invalid("request body must be a JSON object", "missing_request_object");
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.model !== "string" || o.model.length === 0) {
    return invalid("`model` must be a non-empty string", "missing_model");
  }
  if (!Array.isArray(o.messages) || o.messages.length === 0) {
    return invalid("`messages` must be a non-empty array", "missing_messages");
  }
  const messages: OpenAIChatMessage[] = [];
  for (let i = 0; i < o.messages.length; i++) {
    const m = o.messages[i];
    const parsed = parseMessage(m, i);
    if ("error" in parsed) return invalid(parsed.error, parsed.code);
    messages.push(parsed.message);
  }

  // Optional fields. Each is type-checked but otherwise pass-through.
  const request: OpenAIChatRequest = { model: o.model, messages };
  if (typeof o.stream === "boolean") request.stream = o.stream;
  if (typeof o.temperature === "number") request.temperature = o.temperature;
  if (typeof o.max_tokens === "number" && o.max_tokens > 0) request.max_tokens = o.max_tokens;
  if (Array.isArray(o.tools)) request.tools = o.tools as OpenAIChatRequest["tools"];
  if (o.tool_choice !== undefined) request.tool_choice = o.tool_choice as OpenAIChatRequest["tool_choice"];
  // Preserve unknown fields on the same object (the index signature
  // permits it). Documented in docs/openai-proxy.md as silently-ignored.
  for (const [k, v] of Object.entries(o)) {
    if (!(k in request)) (request as Record<string, unknown>)[k] = v;
  }
  return { ok: true, request };
}

function parseMessage(
  raw: unknown,
  index: number,
): { message: OpenAIChatMessage } | { error: string; code: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: `messages[${index}] must be an object`, code: "invalid_message" };
  }
  const m = raw as Record<string, unknown>;
  const role = m.role;
  if (
    role !== "system" &&
    role !== "user" &&
    role !== "assistant" &&
    role !== "tool" &&
    role !== "developer"
  ) {
    return {
      error: `messages[${index}].role must be one of system/user/assistant/tool/developer`,
      code: "invalid_role",
    };
  }
  // content may be a string or null (the latter for assistant turns that
  // only emit tool_calls; v0.13.1 surface, but we accept the shape now).
  let content: string | null;
  if (typeof m.content === "string") content = m.content;
  else if (m.content === null || m.content === undefined) content = null;
  else {
    return {
      error: `messages[${index}].content must be a string or null`,
      code: "invalid_content",
    };
  }
  const message: OpenAIChatMessage = { role, content };
  if (typeof m.name === "string") message.name = m.name;
  if (Array.isArray(m.tool_calls)) message.tool_calls = m.tool_calls as OpenAIChatMessage["tool_calls"];
  if (typeof m.tool_call_id === "string") message.tool_call_id = m.tool_call_id;
  return { message };
}

function invalid(message: string, code: string): ParseResult {
  return {
    ok: false,
    status: 400,
    body: {
      error: {
        message,
        type: "invalid_request_error",
        code,
      },
    },
  };
}
