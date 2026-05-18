// v0.10.0: conversation agent.
//
// LLM-driven half of the chat layer. Takes the conversation so far + the
// four intent tool definitions and asks the adapter for one turn. Parses
// the returned tool call into an Intent (or returns a drift result the
// session manager handles).
//
// Stateless beyond the system prompt. The session manager owns the
// conversation buffer and drift counter.

import type { AgentAdapter, Message, StreamEvent } from "../types.js";
import type { ToolCall } from "../tools/types.js";
import { INTENT_TOOL_DEFINITIONS, parseIntent, reminderForDriftCount, type ParseResult } from "./intent.js";
import type { ConversationBuffer } from "./compile.js";

// System prompt for the conversation agent. Distinct from the runtime
// framework prompt: the conversation agent does NOT execute the brief.
// Its job is to gather requirements, propose plans, translate phase events
// into natural language, and never invent or run anything outside the
// brief-compile flow.
export const CONVERSATION_AGENT_SYSTEM_PROMPT = `You are the OpenWar conversation agent.

Your job is to help a user describe what they want done, propose a plan for it, then hand the actual execution off to the OpenWar runtime. You never call tools to read files or run commands directly. The runtime is the actor; you are a translator between the user and the runtime.

Every turn you take MUST end with exactly one tool call from this set:

  ask_clarification    Ask the user one to four clarifying questions before you propose a plan. Use ONLY when you genuinely cannot compile a plan yet.

  propose_plan         Propose a concrete plan. Include a plain-English plan_text AND a draft_brief object with deliverables and intended_actions. The user will see the plan, approve or refine.

  start_execution      Signal the user approved the most recent plan. Quote their approval phrase verbatim from their last turn. Do not fabricate approval.

  summarize_result     After the runtime reports completion, summarize what was done in two to five sentences. Set offer_save=true when the workflow generalizes to other inputs.

Rules:
- One tool call per turn. Never zero, never more than one.
- Conservative authorized_costs: when listing intended_actions in propose_plan, declare the categories you'd want. The compiler will refuse to auto-grant destructive ones (git_push, deploy, external_message, paid_api_call, shell_exec, filesystem_delete, http_fetch, git_write). Those route through the runtime's Phase 3 prompts instead.
- If the user goes off-topic mid-conversation, do NOT compile a second brief. Use ask_clarification to acknowledge the side request and offer to remember it for after: "I'm focused on X right now. After it's done I can help with Y. Want me to remember it for after?"
- Plain language. Never expose internal terms like "tool call", "Phase 3", "intent", "frontmatter" to the user. Translate them.
- One brief per session. After summarize_result, the session is winding down. Do not start a new brief in the same chat.

If the user is just asking a question about OpenWar itself ("what tools does OpenWar have?"), answer the question conversationally in your turn's free-text response, then call ask_clarification to ask if there's anything you can help them do.`;

export interface CallAgentOptions {
  adapter: AgentAdapter;
  buffer: ConversationBuffer;
  // Drift count from prior consecutive non-tool-call turns. Used to escalate
  // the system reminder. Zero means clean state.
  driftCount: number;
  // The user's last turn, used to verify start_execution approval phrases.
  lastUserTurn?: string;
  // Optional project-memory + learned-profile context. Appended to the
  // system prompt so the agent can reference past decisions naturally.
  contextNotes?: string[];
  signal?: AbortSignal;
}

export interface CallAgentResult {
  // The raw free-text the agent emitted alongside the tool call (may be empty).
  text: string;
  // The tool calls the adapter emitted. Should be exactly one for a valid
  // intent turn; the parser flags multiple as a drift.
  toolCalls: ToolCall[];
  // Parsed intent result.
  parsed: ParseResult;
}

export async function callConversationAgent(opts: CallAgentOptions): Promise<CallAgentResult> {
  const systemParts: string[] = [CONVERSATION_AGENT_SYSTEM_PROMPT];
  if (opts.contextNotes && opts.contextNotes.length > 0) {
    systemParts.push("");
    systemParts.push("Context from prior work on this project (do not reference unless relevant to the user's request):");
    for (const n of opts.contextNotes) systemParts.push(`- ${n}`);
  }
  if (opts.driftCount > 0) {
    systemParts.push("");
    systemParts.push(reminderForDriftCount(opts.driftCount));
  }
  const system = systemParts.join("\n");

  const messages: Message[] = opts.buffer.turns.map((t) => ({
    role: t.role === "user" ? "user" : "assistant",
    content: t.content,
    at: t.at,
  }));

  // The adapter's sendMessage signature uses the StreamEvent contract from
  // the runtime. We collect text deltas + tool-call-complete events into
  // one turn's worth of output.
  let text = "";
  const toolCalls: ToolCall[] = [];
  const sendOpts: Parameters<typeof opts.adapter.sendMessage>[0] = {
    system,
    messages,
    tools: INTENT_TOOL_DEFINITIONS,
  };
  if (opts.signal !== undefined) sendOpts.signal = opts.signal;
  for await (const ev of opts.adapter.sendMessage(sendOpts) as AsyncIterable<StreamEvent>) {
    if (ev.type === "text_delta") {
      text += ev.delta;
    } else if (ev.type === "tool_call_complete") {
      toolCalls.push(ev.call);
    } else if (ev.type === "done") {
      // Adapter signaled end of turn. Capture any tool_calls in the done
      // event that weren't already streamed.
      if (ev.tool_calls) {
        for (const c of ev.tool_calls) {
          if (!toolCalls.some((existing) => existing.id === c.id)) toolCalls.push(c);
        }
      }
      if (ev.message && ev.message.length > text.length) text = ev.message;
      break;
    } else if (ev.type === "error") {
      throw ev.error;
    }
  }

  const parsed = parseIntent(
    toolCalls,
    opts.lastUserTurn !== undefined ? { lastUserTurn: opts.lastUserTurn } : {},
  );
  return { text, toolCalls, parsed };
}
