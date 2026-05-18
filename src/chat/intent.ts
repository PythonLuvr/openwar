// v0.10.0: chat-agent intent contract.
//
// The conversation agent declares its intent through a tool call, not free
// text. Four intents map to four tools the agent can call exactly once per
// turn:
//
//   ask_clarification: { questions: string[] }
//   propose_plan:      { plan_text: string, draft_brief: BriefDraft }
//   start_execution:   { approval_phrase: string }
//   summarize_result:  { summary: string, offer_save: boolean }
//
// The session manager parses each turn's tool-call output. If no recognized
// tool call lands, the manager increments a drift counter and re-prompts with
// a stricter system reminder. Three consecutive non-tool-call turns trigger
// a deterministic fallback question to the user; if THAT fails, the chat
// session halts cleanly with a "the conversation agent could not pick an
// intent" message and an inspect-trace pointer.
//
// This is the load-bearing piece of v0.10. Tests in
// tests/chat/intent.test.ts exercise adversarial cases (off-topic mid-
// conversation, premature approval, hallucinated fifth intent, free-text
// drift) so regressions in the contract surface immediately.

import type { JsonSchema, ToolDefinition, ToolCall } from "../tools/types.js";

export const INTENT_TOOL_NAMES = [
  "ask_clarification",
  "propose_plan",
  "start_execution",
  "summarize_result",
] as const;

export type IntentName = (typeof INTENT_TOOL_NAMES)[number];

export function isIntentName(s: string): s is IntentName {
  return (INTENT_TOOL_NAMES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// BriefDraft. The shape the conversation agent uses to describe a candidate
// brief. The compiler (src/chat/compile.ts) takes this draft + the full
// conversation buffer and produces a real Brief, applying the conservative
// authorized_costs invariant.
//
// Kept minimal here. Anything the agent isn't expected to confidently fill
// (project slug, deadlines, frontmatter) stays out of the draft and gets
// derived by the compiler from working directory / project memory / explicit
// user mentions.

export interface BriefDraft {
  // What the user wants. Required.
  deliverables: string[];
  // Plain-language description of constraints if any. Optional.
  constraints?: string[];
  // What the agent thinks it needs to be able to do. The compiler does NOT
  // trust this directly for destructive categories; it filters before grant.
  intended_actions: IntendedAction[];
  // Optional explicit out-of-scope items the agent will refuse.
  out_of_scope?: string[];
}

export interface IntendedAction {
  // Short verb phrase: "read files", "write files", "run shell commands",
  // "make git commits", "publish to remote", "send messages".
  description: string;
  // Maps to an auth category. The compiler uses this to assemble the
  // authorized_costs list (after the destructive filter).
  category: string;
}

// ---------------------------------------------------------------------------
// Intent payloads. Parsed from tool-call arguments.

export interface AskClarificationIntent {
  intent: "ask_clarification";
  questions: string[];
}

export interface ProposePlanIntent {
  intent: "propose_plan";
  plan_text: string;
  draft_brief: BriefDraft;
}

export interface StartExecutionIntent {
  intent: "start_execution";
  // The agent signals it heard the user approve. The session manager double-
  // checks against actual user input before kicking off execution; the agent
  // does not get to bypass approval by claiming the user said yes.
  approval_phrase: string;
}

export interface SummarizeResultIntent {
  intent: "summarize_result";
  summary: string;
  offer_save: boolean;
}

export type Intent =
  | AskClarificationIntent
  | ProposePlanIntent
  | StartExecutionIntent
  | SummarizeResultIntent;

// ---------------------------------------------------------------------------
// Tool definitions exposed to the conversation-agent adapter. Each adapter
// translates these to its provider's function-calling schema. Adapters
// without tool-call support cannot run the conversation agent (cli-bridge
// being the canonical example); this is enforced in src/cli/chat.ts at
// startup.

const ASK_CLARIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: { type: "string", description: "One clarifying question for the user." },
      description: "One to four clarifying questions. Ask only what you genuinely need to compile a plan.",
    },
  },
  required: ["questions"],
};

const PROPOSE_PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    plan_text: {
      type: "string",
      description: "Plain-English plan: what you will do, in order. Bulleted, three to seven lines.",
    },
    draft_brief: {
      type: "object",
      properties: {
        deliverables: {
          type: "array",
          items: { type: "string" },
          description: "Concrete deliverables the user will see at the end.",
        },
        constraints: {
          type: "array",
          items: { type: "string" },
          description: "Plain-language constraints the user mentioned or implied.",
        },
        intended_actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              category: {
                type: "string",
                description:
                  "Short auth category id. Examples: filesystem_read, filesystem_write, shell_exec, git_push, deploy, external_message. The compiler filters destructive categories from the auto-grant list.",
              },
            },
            required: ["description", "category"],
          },
          description: "Actions the agent expects to take. The compiler decides which to auto-grant.",
        },
        out_of_scope: {
          type: "array",
          items: { type: "string" },
          description: "Things you will explicitly NOT do, surfaced in the plan presentation.",
        },
      },
      required: ["deliverables", "intended_actions"],
    },
  },
  required: ["plan_text", "draft_brief"],
};

const START_EXECUTION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    approval_phrase: {
      type: "string",
      description:
        "Quote the user's approval phrase. The session manager verifies this against the actual last user turn; agents cannot fabricate approval.",
    },
  },
  required: ["approval_phrase"],
};

const SUMMARIZE_RESULT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two to five sentences describing what was accomplished.",
    },
    offer_save: {
      type: "boolean",
      description:
        "True when the workflow is general enough to save as a reusable brief. False when the task was one-off (e.g., debug-this-specific-error).",
    },
  },
  required: ["summary", "offer_save"],
};

export const INTENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "ask_clarification",
    description:
      "Ask the user one to four clarifying questions before proposing a plan. Use ONLY when you genuinely cannot compile a plan yet. Do not use to chit-chat.",
    input_schema: ASK_CLARIFICATION_SCHEMA,
    origin: "native",
    authorization_categories: [],
  },
  {
    name: "propose_plan",
    description:
      "Propose a plan to the user. Use ONLY when you have enough information to compile a concrete brief. Include the draft_brief object so the compiler can derive the real brief on user approval.",
    input_schema: PROPOSE_PLAN_SCHEMA,
    origin: "native",
    authorization_categories: [],
  },
  {
    name: "start_execution",
    description:
      "Signal that the user approved the most recent plan and execution should begin. Quote the user's approval phrase verbatim from their last turn.",
    input_schema: START_EXECUTION_SCHEMA,
    origin: "native",
    authorization_categories: [],
  },
  {
    name: "summarize_result",
    description:
      "Summarize the completed execution for the user. Use only after the runtime has reported completion. Set offer_save=true when the workflow generalizes to other inputs.",
    input_schema: SUMMARIZE_RESULT_SCHEMA,
    origin: "native",
    authorization_categories: [],
  },
];

// ---------------------------------------------------------------------------
// Parser. Takes the tool calls produced by an adapter turn and returns either
// a parsed Intent or a parse failure. The session manager handles the drift
// counter externally; the parser is pure.

export type ParseResult =
  | { ok: true; intent: Intent; raw_call: ToolCall }
  | { ok: false; reason: ParseFailureReason; detail: string };

export type ParseFailureReason =
  | "no_tool_call"
  | "multiple_tool_calls"
  | "unknown_tool"
  | "invalid_args"
  | "fabricated_approval";

export interface ParseOptions {
  // When start_execution claims an approval_phrase, the session manager
  // passes the user's actual last turn for verification. Optional; the
  // parser skips verification if absent (tests, replay).
  lastUserTurn?: string;
}

export function parseIntent(toolCalls: readonly ToolCall[], opts: ParseOptions = {}): ParseResult {
  if (toolCalls.length === 0) {
    return { ok: false, reason: "no_tool_call", detail: "Agent turn contained no tool call." };
  }
  if (toolCalls.length > 1) {
    return {
      ok: false,
      reason: "multiple_tool_calls",
      detail: `Agent emitted ${toolCalls.length} tool calls in one turn; intent contract is one per turn.`,
    };
  }
  const call = toolCalls[0]!;
  if (!isIntentName(call.name)) {
    return {
      ok: false,
      reason: "unknown_tool",
      detail: `Tool "${call.name}" is not one of: ${INTENT_TOOL_NAMES.join(", ")}.`,
    };
  }
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case "ask_clarification": {
      if (!Array.isArray(args.questions) || args.questions.length === 0 || !args.questions.every((q): q is string => typeof q === "string")) {
        return { ok: false, reason: "invalid_args", detail: "ask_clarification: questions must be a non-empty string array." };
      }
      return { ok: true, intent: { intent: "ask_clarification", questions: args.questions as string[] }, raw_call: call };
    }
    case "propose_plan": {
      if (typeof args.plan_text !== "string" || args.plan_text.trim().length === 0) {
        return { ok: false, reason: "invalid_args", detail: "propose_plan: plan_text must be a non-empty string." };
      }
      const draft = args.draft_brief;
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
        return { ok: false, reason: "invalid_args", detail: "propose_plan: draft_brief must be an object." };
      }
      const d = draft as Record<string, unknown>;
      if (!Array.isArray(d.deliverables) || d.deliverables.length === 0 || !d.deliverables.every((x): x is string => typeof x === "string")) {
        return { ok: false, reason: "invalid_args", detail: "propose_plan: draft_brief.deliverables must be a non-empty string array." };
      }
      if (!Array.isArray(d.intended_actions) || !d.intended_actions.every((a) => a && typeof a === "object" && typeof (a as { description?: unknown }).description === "string" && typeof (a as { category?: unknown }).category === "string")) {
        return { ok: false, reason: "invalid_args", detail: "propose_plan: draft_brief.intended_actions must be an array of {description, category}." };
      }
      const draftBrief: BriefDraft = {
        deliverables: d.deliverables as string[],
        intended_actions: d.intended_actions as IntendedAction[],
      };
      if (Array.isArray(d.constraints) && d.constraints.every((c): c is string => typeof c === "string")) {
        draftBrief.constraints = d.constraints as string[];
      }
      if (Array.isArray(d.out_of_scope) && d.out_of_scope.every((c): c is string => typeof c === "string")) {
        draftBrief.out_of_scope = d.out_of_scope as string[];
      }
      return {
        ok: true,
        intent: { intent: "propose_plan", plan_text: args.plan_text as string, draft_brief: draftBrief },
        raw_call: call,
      };
    }
    case "start_execution": {
      if (typeof args.approval_phrase !== "string" || args.approval_phrase.trim().length === 0) {
        return { ok: false, reason: "invalid_args", detail: "start_execution: approval_phrase must be a non-empty string." };
      }
      // Approval verification. If the supplied lastUserTurn doesn't contain
      // an affirmative phrase, the agent is fabricating approval; reject.
      if (opts.lastUserTurn !== undefined) {
        if (!looksLikeApproval(opts.lastUserTurn)) {
          return {
            ok: false,
            reason: "fabricated_approval",
            detail:
              `start_execution: agent claimed user approved, but the user's last turn (${truncate(opts.lastUserTurn, 80)}) ` +
              "does not contain an approval phrase. Ask explicitly before starting execution.",
          };
        }
      }
      return { ok: true, intent: { intent: "start_execution", approval_phrase: args.approval_phrase as string }, raw_call: call };
    }
    case "summarize_result": {
      if (typeof args.summary !== "string" || args.summary.trim().length === 0) {
        return { ok: false, reason: "invalid_args", detail: "summarize_result: summary must be a non-empty string." };
      }
      if (typeof args.offer_save !== "boolean") {
        return { ok: false, reason: "invalid_args", detail: "summarize_result: offer_save must be a boolean." };
      }
      return {
        ok: true,
        intent: { intent: "summarize_result", summary: args.summary as string, offer_save: args.offer_save as boolean },
        raw_call: call,
      };
    }
  }
}

// Affirmative-phrase detector for approval verification. Conservative: an
// ambiguous turn ("maybe...", "could you..." etc.) does NOT count as approval.
// Tests pin the canonical positive and negative cases.
const APPROVAL_PATTERNS: RegExp[] = [
  /\byes\b/i,
  /\byeah\b/i,
  /\byep\b/i,
  /\bgo (?:ahead|for it)\b/i,
  /\b(?:ok|okay)\b\s*(?:go|sounds good|let'?s go|proceed)?/i,
  /\bproceed\b/i,
  /\bdo it\b/i,
  /\bsounds good\b/i,
  /\bship it\b/i,
  /\bapproved\b/i,
  /\blooks good\b/i,
  /\bcommit and push\b/i, // happens when user routes the second turn to a destructive action
];
const REJECTION_PATTERNS: RegExp[] = [
  /\bno\b/i,
  /\bnope\b/i,
  /\bnot yet\b/i,
  /\bwait\b/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
  /\bcancel\b/i,
  /\babort\b/i,
];

export function looksLikeApproval(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  // Rejection wins ties: "no, don't do that" is a no, not a yes.
  for (const p of REJECTION_PATTERNS) {
    if (p.test(trimmed)) return false;
  }
  for (const p of APPROVAL_PATTERNS) {
    if (p.test(trimmed)) return true;
  }
  return false;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + "...";
}

// ---------------------------------------------------------------------------
// Drift counter. The session manager tracks how many consecutive non-tool-
// call turns the agent has produced. After DRIFT_THRESHOLD, the manager
// falls back to a deterministic question to the user. After
// HARD_FAIL_THRESHOLD, the session halts with a clean error.

export const DRIFT_THRESHOLD = 3;
export const HARD_FAIL_THRESHOLD = 5;

// Deterministic fallback question, shown to the user after DRIFT_THRESHOLD
// failed agent turns. Plain language; never references "tool calls" or
// "intents" so non-devs are not confused.
export const DRIFT_FALLBACK_QUESTION =
  "I'm having trouble understanding what to do next. Could you tell me directly: " +
  "are you still describing what you want, asking me a question, ready for me to start, " +
  "or wrapping up? If you can rephrase your last message, I'll try again.";

// Hard-fail message. Shown when even the fallback question doesn't recover.
export const HARD_FAIL_MESSAGE =
  "I'm not able to make progress on this conversation. " +
  "The chat session is saved at ~/.openwar/chats/<chat_id>.ndjson; " +
  "you can inspect it with 'openwar inspect <chat_id>' or resume with " +
  "'openwar chat --resume <chat_id>' after editing your last few messages.";

// Stricter reminder injected as a system-prompt addendum after a failed turn.
// The session manager appends one of these (cycling through them) before the
// next agent call so the model gets escalating pressure to use the tools.
export const REMINDER_AFTER_DRIFT: readonly string[] = [
  "Reminder: every turn MUST end with exactly one tool call. Pick from ask_clarification, propose_plan, start_execution, summarize_result. Do not respond with free text only.",
  "Reminder: free-text responses without a tool call are not valid. Use ask_clarification if you need more from the user, or propose_plan if you have enough to compile a brief.",
  "Final reminder: this is the last attempt before the session falls back to a direct user question. Emit exactly one tool call this turn. If unsure, ask_clarification.",
];

export function reminderForDriftCount(driftCount: number): string {
  const idx = Math.min(driftCount - 1, REMINDER_AFTER_DRIFT.length - 1);
  return REMINDER_AFTER_DRIFT[idx]!;
}
