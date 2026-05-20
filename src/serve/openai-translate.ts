// v0.13.0: OpenAI response translation. The proxy runs a synthesized
// brief through OpenWar's runtime and converts the result back into an
// OpenAI Chat Completions response shape: either the non-streaming
// JSON shape or the streaming SSE chunks (see openai-streaming.ts).
//
// v0.13.0 ships text-only output. The synthesized brief's runtime sends
// assistant text to a RunnerIO that this module captures; tool calls
// are NOT translated yet (deferred to v0.13.1 per the agreed split).

import { randomUUID } from "node:crypto";
import type { OpenAIChatResponse } from "./types.js";

// Build a complete non-streaming OpenAI Chat Completions response from
// the assembled assistant text. `model` is the model name the response
// should report (typically the proxy's upstream model). `finishReason`
// captures end-of-stream semantics: "stop" for ordinary completion,
// "content_filter" for Phase 3 denial-path refusals per the v0.13.0
// design (Q2 ruling (a) accepted).
export interface BuildResponseOptions {
  requestId: string;
  model: string;
  text: string;
  finishReason: OpenAIChatResponse["choices"][number]["finish_reason"];
  // Optional token bookkeeping. v0.13.0 does not run a tokenizer; if the
  // upstream adapter surfaces usage we pass it through, otherwise the
  // usage field is omitted (OpenAI clients tolerate the absence).
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function buildNonStreamingResponse(opts: BuildResponseOptions): OpenAIChatResponse {
  const resp: OpenAIChatResponse = {
    id: `chatcmpl-${opts.requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.text },
        finish_reason: opts.finishReason,
      },
    ],
  };
  if (opts.usage) resp.usage = opts.usage;
  return resp;
}

// Plain text refusal body for Phase 3 denial path. Returned alongside
// finish_reason: "content_filter" so the client sees the assistant
// emitting a refusal explanation and stopping. The trace captures the
// actual destructive action via the X-OpenWar-Trace-Id header.
export function denialRefusalText(action: string, missingCategories: readonly string[]): string {
  const cats = missingCategories.length > 0 ? missingCategories.join(", ") : "unspecified";
  return [
    "I attempted to take an action that the runtime blocked.",
    "",
    `Action:               ${action}`,
    `Missing authorization: ${cats}`,
    "",
    "Re-run with broader --authorized-costs to permit this action, or",
    "phrase the request so the action is not required.",
  ].join("\n");
}

// Build the X-OpenWar-Trace-Id header value for a request_id so the
// operator (and tool integrators) can call `openwar inspect proxy-<uuid>`
// to audit the run. Standardised in one place so the router and the
// streaming path agree.
export function traceIdHeader(requestId: string): { name: "X-OpenWar-Trace-Id"; value: string } {
  return { name: "X-OpenWar-Trace-Id", value: requestId };
}

// Generate a chatcmpl id for callers that need it before the response is
// constructed (e.g., the streaming path emits per-chunk ids).
export function generateChatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}
