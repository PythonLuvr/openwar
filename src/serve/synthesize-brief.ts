// v0.13.0: synthesize an in-memory Brief from an OpenAI Chat Completions
// request. The brief never touches disk under `~/.openwar/projects/`;
// proxy sessions are project-less by design. Only the trace at
// `~/.openwar/sessions/proxy-<uuid>.trace.ndjson` is persisted.
//
// Mode is always "auto" because the proxy cannot pause for operator
// approval mid-request (no operator at the other end of the HTTP wire).
// scope_locked is true so the synthesized brief behaves like a frozen
// production run.

import { randomUUID } from "node:crypto";
import type { Brief } from "../types.js";
import type { OpenAIChatRequest, OpenAIChatMessage } from "./types.js";

export interface SynthesizedBriefResult {
  brief: Brief;
  requestId: string;
  modelSubstitutedFrom: string | null;
}

export interface SynthesizeOptions {
  request: OpenAIChatRequest;
  // authorized_costs categories the synthesized brief carries. Defaults
  // to ["filesystem_read"] at the serve layer per Phase 0 ruling.
  authorizedCosts: string[];
  // When set, the upstream adapter's expected model name. If the request
  // model does not match, the proxy substitutes upstreamModel and records
  // the substitution on the proxy_request trace event.
  upstreamModel: string | null;
}

export function synthesizeBrief(opts: SynthesizeOptions): SynthesizedBriefResult {
  const requestId = `proxy-${randomUUID()}`;
  const { request, authorizedCosts, upstreamModel } = opts;

  // Model substitution: if upstreamModel is configured AND differs from
  // the requested model, fall back to upstreamModel. The original is
  // recorded on the proxy_request event so the operator can see what
  // happened via openwar inspect.
  let modelSubstitutedFrom: string | null = null;
  let effectiveModel = request.model;
  if (upstreamModel && request.model !== upstreamModel) {
    modelSubstitutedFrom = request.model;
    effectiveModel = upstreamModel;
  }

  // Build a markdown brief body that the rest of the runtime can parse.
  // The Phase 0 confirmation that single-agent execute looks for is
  // synthesized as the operator's "ok" since the proxy is auto-mode.
  const body = renderBriefMarkdown({
    requestId,
    model: effectiveModel,
    messages: request.messages,
    authorizedCosts,
  });

  // Construct the Brief structure the runner expects. We bypass the
  // markdown parser and build the structure directly to avoid round-
  // tripping through disk-shaped brief loading.
  const brief: Brief = {
    raw: body,
    frontmatter: {
      project: "openwar-proxy",
      brief_id: requestId,
      scope_locked: true,
      mode: "auto",
      authorized_costs: [...authorizedCosts],
    },
    sections: {
      objective: extractFirstUserMessage(request.messages),
      deliverables: "Respond to the proxied OpenAI request.",
      constraints: "auto-mode proxy session; cannot prompt operator",
      tools_required: "",
      notes: "synthesized brief from openwar serve --openai-compat",
      extra: {},
    },
  };

  return { brief, requestId, modelSubstitutedFrom };
}

interface RenderInput {
  requestId: string;
  model: string;
  messages: OpenAIChatMessage[];
  authorizedCosts: string[];
}

function renderBriefMarkdown(input: RenderInput): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("project: openwar-proxy");
  lines.push(`brief_id: ${input.requestId}`);
  lines.push("mode: auto");
  lines.push("scope_locked: true");
  lines.push("authorized_costs:");
  for (const c of input.authorizedCosts) lines.push(`  - ${c}`);
  lines.push("---");
  lines.push("");
  lines.push(`# Proxy request ${input.requestId}`);
  lines.push("");
  lines.push("# Objective");
  lines.push("");
  lines.push(extractFirstUserMessage(input.messages));
  lines.push("");
  lines.push("# Deliverables");
  lines.push("");
  lines.push("- Respond to the proxied OpenAI request.");
  lines.push("");
  lines.push("# Conversation");
  lines.push("");
  for (const m of input.messages) {
    const content = typeof m.content === "string" ? m.content : "(non-text content)";
    lines.push(`**${m.role}:** ${content}`);
    lines.push("");
  }
  return lines.join("\n");
}

function extractFirstUserMessage(messages: readonly OpenAIChatMessage[]): string {
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0) {
      // Truncate to keep the objective field reasonable.
      return m.content.length > 500 ? m.content.slice(0, 497) + "..." : m.content;
    }
  }
  return "Proxied request (no user message body provided).";
}
