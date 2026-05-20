// v0.10.0: chat session manager.
//
// Orchestrates one chat session end-to-end:
//   user input -> command dispatch OR agent call
//   agent intent -> ask_clarification | propose_plan | start_execution | summarize_result
//   plan approval -> compile brief -> kick off runtime -> stream phase events back as chat
//   destructive prompts -> block on user input -> route to runtime gate
//   completion -> offer save-brief
//
// Decoupled from the readline I/O surface: tests inject a UserIO interface
// that returns scripted inputs and captures output to a string buffer.

import type { AgentAdapter, Brief, RunnerIO } from "../types.js";
import type { ConversationBuffer, ConversationTurn } from "./compile.js";
import { compileBriefFromChat } from "./compile.js";
import { presentPlan } from "./plan.js";
import { callConversationAgent } from "./agent.js";
import { PhaseEventRenderer } from "./render.js";
import { destructivePromptText } from "./destructive-phrases.js";
import { parseCommand, HELP_TEXT, slugify } from "./commands.js";
import {
  ChatStore,
  newChatId,
  type ChatEvent,
} from "../state/chat-store.js";
import { Tracer } from "../state/trace.js";
import { runtimeVersion } from "../version.js";
import {
  DRIFT_THRESHOLD,
  HARD_FAIL_THRESHOLD,
  DRIFT_FALLBACK_QUESTION,
  HARD_FAIL_MESSAGE,
  looksLikeApproval,
  type Intent,
  type ProposePlanIntent,
} from "./intent.js";
import { saveBriefFile, suggestUniqueName, SaveBriefError } from "./save-brief.js";

// ---------------------------------------------------------------------------
// IO contract. Production wires this to readline; tests inject a scripted IO.

export interface ChatIO {
  write: (text: string) => void;
  prompt: (question: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Session options.

export interface ChatSessionOptions {
  io: ChatIO;
  // The adapter the conversation agent runs on. MUST support tool calls
  // (verified upstream in src/cli/chat.ts).
  agentAdapter: AgentAdapter;
  // The adapter used to execute compiled briefs. May equal agentAdapter or
  // be different (per-role split).
  execAdapter: AgentAdapter;
  // Project slug; chat-compiled briefs use this as their project field.
  projectSlug: string;
  // Working directory the runtime should treat as the sandbox root.
  workdir: string;
  // Persistent chat store. Pass nullChatStore() for ephemeral / --no-save.
  store: ChatStore;
  // Optional resume context: events read from a prior chat-store.ndjson.
  // The session manager restores the conversation buffer from these and
  // appends new turns on top.
  resumeEvents?: readonly ChatEvent[];
  // Optional context notes from project memory + learned profile. Appended
  // to the conversation agent's system prompt.
  contextNotes?: string[];
  // Executes a compiled brief. Wired to runner.run() in production; tests
  // can swap in a stub that emits trace events synchronously.
  executeRun: (brief: Brief) => Promise<ExecuteOutcome>;
  // v0.12.0: PermissionBridge surface. The cli layer maintains a Session
  // reference for the live run and exposes the active grant ledger via
  // these callbacks. Both are optional so tests / library consumers that
  // don't expose grants still typecheck.
  getActiveGrants?: () => readonly import("../types.js").Grant[];
  revokeGrant?: (grant_id: string) => boolean;
}

export interface ExecuteOutcome {
  completed: boolean;
  halted: boolean;
  halt_reason?: string;
}

// ---------------------------------------------------------------------------
// Session manager.

export class ChatSession {
  private readonly opts: ChatSessionOptions;
  private readonly buffer: ConversationBuffer;
  private driftCount = 0;
  // Last propose_plan intent the agent emitted; held until the user approves
  // or refines.
  private pendingPlan: ProposePlanIntent | null = null;
  private pendingBrief: Brief | null = null;
  private pendingRefusedCategories: string[] = [];
  // Set when execution is in progress; used by /abort to signal cancel at
  // the next phase boundary.
  private executing = false;
  private abortRequested = false;
  // chat id (for trace correlation and save-brief provenance).
  readonly chatId: string;
  // v0.10.0: brief_id of the most recently executed brief in this session.
  // When set, the session mirrors chat_brief_saved trace events into that
  // brief's trace file so `openwar inspect <brief_id> --trace` shows the
  // save event alongside the rest of the run.
  private lastExecutedBriefId: string | null = null;

  constructor(opts: ChatSessionOptions) {
    this.opts = opts;
    this.chatId = opts.store.chatId;
    this.buffer = { turns: [] };
    if (opts.resumeEvents) this.restoreFromEvents(opts.resumeEvents);
    // v0.10.0: if we were resumed, recover the last executed brief id and
    // emit chat_session_resumed into both the chat-store AND that brief's
    // trace (so inspect surfaces the resume marker against the recent run).
    if (opts.resumeEvents) {
      for (const ev of opts.resumeEvents) {
        if (ev.type === "execution_started") this.lastExecutedBriefId = ev.brief_id;
      }
      const at = new Date().toISOString();
      // Chat-store: emit a session_started-style resume marker so the
      // audit trail shows when resumes happened. We use the chat-store
      // ended-reason approach: a synthetic event type isn't in the union,
      // so we emit a user_turn-shaped synthetic. Simpler: just emit the
      // resume into the trace, and rely on the chat-store's session
      // started timestamp + the resume cli emitting from outside.
      this.mirrorToLastBriefTrace({ type: "chat_session_resumed", at, chat_id: this.chatId });
    }
  }

  // Append a chat-* trace event to the most recently executed brief's trace
  // file, when one exists. The runtime's brief tracer is opaque to us; we
  // construct a thin Tracer pointed at the same path and emit there.
  // Multiple appendFileSync writers to the same trace file are safe (line-
  // atomic on POSIX, OK on Windows for our line sizes; same property the
  // v0.8 mcp-serve subprocess relies on).
  private mirrorToLastBriefTrace(event: import("../state/trace.js").TraceEvent): void {
    if (!this.lastExecutedBriefId) return;
    try {
      const tracer = new Tracer({
        briefId: this.lastExecutedBriefId,
        enabled: true,
        openwarVersion: runtimeVersion(),
      });
      tracer.emit(event);
    } catch {
      // Best effort. The chat-store record is the canonical audit trail;
      // missing brief trace mirror is not load-bearing.
    }
  }

  private restoreFromEvents(events: readonly ChatEvent[]): void {
    for (const ev of events) {
      if (ev.type === "user_turn") {
        this.buffer.turns.push({ role: "user", content: ev.content, at: ev.at });
      } else if (ev.type === "agent_turn") {
        this.buffer.turns.push({ role: "agent", content: ev.content, at: ev.at });
      }
    }
  }

  // Public entry: process one user input. Recursively continues until the
  // agent emits ask_clarification (then waits for next input) or
  // summarize_result (then offers save and waits). Returns "ended" when the
  // user typed /quit.
  async handleUserInput(input: string): Promise<"continue" | "ended"> {
    const cmd = parseCommand(input);
    if (cmd?.isCommand) {
      return await this.handleCommand(cmd.name, cmd.args);
    }
    const turn: ConversationTurn = { role: "user", content: input, at: new Date().toISOString() };
    this.buffer.turns.push(turn);
    this.opts.store.append({ type: "user_turn", at: turn.at, content: turn.content });
    // If a plan is pending, this user turn is either approval or refinement.
    if (this.pendingPlan && this.pendingBrief) {
      if (looksLikeApproval(input)) {
        this.opts.store.append({ type: "plan_approved", at: new Date().toISOString() });
        await this.runExecution();
        // After execution completes, let the agent produce summarize_result.
        await this.driveAgentUntilWaitState();
        return "continue";
      }
      // Treat as refinement: clear pending plan, fall through to agent so it
      // can ask follow-up questions or repropose.
      this.opts.store.append({ type: "plan_rejected", at: new Date().toISOString(), reason: input });
      this.pendingPlan = null;
      this.pendingBrief = null;
      this.pendingRefusedCategories = [];
    }
    await this.driveAgentUntilWaitState();
    return "continue";
  }

  private async handleCommand(name: string, args: string[]): Promise<"continue" | "ended"> {
    switch (name) {
      case "/help":
        this.opts.io.write(HELP_TEXT + "\n");
        if (args.length > 0 && args[0]!.startsWith("unknown")) this.opts.io.write(`(${args[0]})\n`);
        return "continue";
      case "/quit":
        this.opts.store.append({ type: "chat_session_ended", at: new Date().toISOString(), reason: "user_quit" });
        this.opts.io.write(`chat session saved (id: ${this.chatId}). Resume: openwar chat --resume ${this.chatId}\n`);
        return "ended";
      case "/history": {
        for (const t of this.buffer.turns) {
          this.opts.io.write(`[${t.role}] ${t.content}\n`);
        }
        return "continue";
      }
      case "/abort":
        if (this.executing) {
          this.abortRequested = true;
          this.opts.io.write("abort requested. The current step will finish and then the session halts.\n");
        } else {
          this.opts.io.write("nothing in progress to abort.\n");
        }
        return "continue";
      case "/save":
        return await this.handleSaveCommand(args);
      case "/inspect":
        this.opts.io.write(
          `Run: openwar inspect ${this.pendingBrief?.frontmatter.brief_id ?? this.chatId}\n` +
            `(For trace events from this chat's execution(s); the chat log itself is at ~/.openwar/chats/${this.chatId}.ndjson)\n`,
        );
        return "continue";
      case "/resume":
        this.opts.io.write(`Re-run with: openwar chat --resume ${args[0] ?? "<chat_id>"}\n`);
        return "continue";
      case "/grants": {
        // v0.12.0: list active permission grants from the live run, if any.
        const grants = this.opts.getActiveGrants?.() ?? [];
        if (grants.length === 0) {
          this.opts.io.write("no active permission grants in this session.\n");
          return "continue";
        }
        for (const g of grants) {
          const consumed = g.consumed ? " (consumed)" : "";
          const cat = g.category ?? "(no category)";
          this.opts.io.write(
            `  ${g.grant_id}  scope=${g.scope}  cat=${cat}${consumed}\n` +
              `    action: ${g.action}\n` +
              `    reason: ${g.reasoning}\n` +
              `    at:     ${g.granted_at}\n`,
          );
        }
        return "continue";
      }
      case "/revoke": {
        const id = args[0];
        if (!id) {
          this.opts.io.write("usage: /revoke <grant_id>\n");
          return "continue";
        }
        const ok = this.opts.revokeGrant?.(id) ?? false;
        this.opts.io.write(ok ? `revoked grant ${id}.\n` : `no active grant with id ${id}.\n`);
        return "continue";
      }
      default:
        this.opts.io.write(HELP_TEXT + "\n");
        return "continue";
    }
  }

  private async handleSaveCommand(args: string[]): Promise<"continue"> {
    if (!this.pendingBrief) {
      this.opts.io.write("There's no compiled brief in this session yet. Describe what you want first, then approve the plan.\n");
      return "continue";
    }
    // Resolve name: explicit arg > slugified first deliverable > suggest unique.
    let name = args.length > 0 ? slugify(args[0]!) : slugify(this.pendingBrief.sections.objective ?? "chat-brief");
    name = suggestUniqueName(name);
    try {
      const result = saveBriefFile({
        name,
        brief: this.pendingBrief,
        buffer: this.buffer,
        chatId: this.chatId,
      });
      const at = new Date().toISOString();
      this.opts.store.append({ type: "brief_saved", at, path: result.path });
      // v0.10.0: mirror chat_brief_saved into the most recently executed
      // brief's trace so `openwar inspect <brief_id> --trace` shows the
      // save action against the run that motivated it.
      this.mirrorToLastBriefTrace({ type: "chat_brief_saved", at, chat_id: this.chatId, path: result.path });
      this.opts.io.write(`saved to ${result.path}\nReplay: openwar run ${result.path}\n`);
    } catch (err) {
      if (err instanceof SaveBriefError) {
        this.opts.io.write(`could not save: ${err.message}\n`);
      } else {
        throw err;
      }
    }
    return "continue";
  }

  // Loop the conversation agent until we hit a state that requires user
  // input: clarification, plan presented (waiting for approval), or summary
  // after execution.
  private async driveAgentUntilWaitState(): Promise<void> {
    while (true) {
      if (this.driftCount >= HARD_FAIL_THRESHOLD) {
        this.opts.io.write(HARD_FAIL_MESSAGE + "\n");
        this.opts.store.append({ type: "chat_session_ended", at: new Date().toISOString(), reason: "hard_fail_intent_drift" });
        return;
      }

      const lastUserTurn = this.buffer.turns.filter((t) => t.role === "user").slice(-1)[0]?.content;
      const callOpts: Parameters<typeof callConversationAgent>[0] = {
        adapter: this.opts.agentAdapter,
        buffer: this.buffer,
        driftCount: this.driftCount,
      };
      if (lastUserTurn !== undefined) callOpts.lastUserTurn = lastUserTurn;
      if (this.opts.contextNotes !== undefined) callOpts.contextNotes = this.opts.contextNotes;
      const result = await callConversationAgent(callOpts);

      const at = new Date().toISOString();
      const agentTurn: ConversationTurn = { role: "agent", content: result.text, at };
      this.buffer.turns.push(agentTurn);

      if (!result.parsed.ok) {
        // Drift. Record the agent turn (so the user can /history audit it),
        // bump drift counter, escalate per threshold:
        //   - HARD_FAIL_THRESHOLD: close the session, write hard-fail event.
        //   - DRIFT_THRESHOLD (exactly): show the deterministic fallback and
        //     wait for user input.
        //   - Below DRIFT_THRESHOLD: silently retry with an escalating
        //     reminder in the next agent call.
        //   - Above DRIFT_THRESHOLD but below HARD_FAIL_THRESHOLD: another
        //     wait (we already showed the fallback; user is rephrasing and
        //     the agent still failed). Each subsequent waiting cycle moves
        //     us one step closer to HARD_FAIL_THRESHOLD.
        this.opts.store.append({ type: "agent_turn", at, content: result.text, intent: "drift" });
        this.driftCount++;
        if (this.driftCount >= HARD_FAIL_THRESHOLD) {
          // The top-of-loop check would also catch this on the next
          // iteration, but emitting here is more direct and avoids a
          // wasted iteration.
          this.opts.io.write(HARD_FAIL_MESSAGE + "\n");
          this.opts.store.append({ type: "chat_session_ended", at: new Date().toISOString(), reason: "hard_fail_intent_drift" });
          return;
        }
        if (this.driftCount === DRIFT_THRESHOLD) {
          this.opts.io.write(DRIFT_FALLBACK_QUESTION + "\n");
          return; // Wait for user to retry.
        }
        if (this.driftCount > DRIFT_THRESHOLD) {
          // Already showed the fallback once; just wait silently for the
          // next user input. The next failed agent turn brings us closer
          // to HARD_FAIL_THRESHOLD.
          return;
        }
        // Below threshold: retry with an escalating reminder.
        continue;
      }

      // Successful intent. Reset drift counter.
      this.driftCount = 0;
      this.opts.store.append({ type: "agent_turn", at, content: result.text, intent: result.parsed.intent.intent });

      const cont = await this.handleIntent(result.parsed.intent);
      if (cont === "wait") return;
      // "loop" cases continue the while loop (rare: e.g., the agent itself
      // wants to chain right back, which it shouldn't).
    }
  }

  private async handleIntent(intent: Intent): Promise<"wait" | "loop"> {
    switch (intent.intent) {
      case "ask_clarification": {
        if (intent.questions.length === 1) {
          this.opts.io.write(intent.questions[0]! + "\n");
        } else {
          this.opts.io.write("a few questions before I start:\n");
          intent.questions.forEach((q, i) => this.opts.io.write(`  ${i + 1}. ${q}\n`));
        }
        return "wait";
      }
      case "propose_plan": {
        const compile = compileBriefFromChat(this.buffer, intent, {
          projectSlug: this.opts.projectSlug,
          briefId: this.deriveBriefId(),
          workdir: this.opts.workdir,
          chatId: this.chatId,
        });
        if (!compile.ok) {
          // Missing required field. Surface the compiler's questions and wait.
          for (const q of compile.questions) this.opts.io.write(q + "\n");
          return "wait";
        }
        this.pendingPlan = intent;
        this.pendingBrief = compile.brief;
        this.pendingRefusedCategories = compile.refused_categories;
        this.opts.store.append({
          type: "plan_proposed",
          at: new Date().toISOString(),
          brief_draft: compile.brief,
          plan_text: intent.plan_text,
        });
        const planText = presentPlan({
          brief: compile.brief,
          proposal: intent,
          refused_categories: compile.refused_categories,
        });
        this.opts.io.write(planText + "\n");
        return "wait";
      }
      case "start_execution": {
        // The session manager double-checks against actual user input via the
        // parser's lastUserTurn verification. If the agent reached here, it
        // already passed that check OR the pending-plan was approved via the
        // handleUserInput approval path. Either way: kick off execution.
        if (this.pendingBrief) {
          await this.runExecution();
          // Let the loop continue so the agent can summarize.
          return "loop";
        }
        // Agent claimed start without a pending plan. Treat as drift.
        this.opts.io.write("I think we lost track of the plan. Could you describe what you want again?\n");
        return "wait";
      }
      case "summarize_result": {
        this.opts.io.write(intent.summary + "\n");
        if (intent.offer_save) {
          this.opts.io.write(
            "\nWant to save this conversation as a reusable brief? It would let you re-run the same workflow on another input with one command. (use /save [name])\n",
          );
        }
        return "wait";
      }
    }
  }

  // Run the runtime against the pending brief. Stream phase events back as
  // chat output via the PhaseEventRenderer. Block on destructive prompts.
  private async runExecution(): Promise<void> {
    if (!this.pendingBrief) return;
    this.executing = true;
    this.abortRequested = false;
    const briefId = this.pendingBrief.frontmatter.brief_id ?? "(none)";
    this.lastExecutedBriefId = briefId;
    this.opts.store.append({
      type: "execution_started",
      at: new Date().toISOString(),
      brief_id: briefId,
    });
    let outcome: ExecuteOutcome;
    try {
      outcome = await this.opts.executeRun(this.pendingBrief);
    } finally {
      this.executing = false;
    }
    this.opts.store.append({
      type: "execution_completed",
      at: new Date().toISOString(),
      outcome: outcome.completed ? "success" : outcome.halted ? "blocked" : "aborted",
    });
    if (outcome.halted && outcome.halt_reason) {
      this.opts.io.write(`stopped: ${outcome.halt_reason}\n`);
    }
  }

  private deriveBriefId(): string {
    // Brief_id format is YYYY-MM-DD-<alphanumeric>. The id segment must NOT
    // contain dashes (parser regex enforces). We derive it from chat_id tail
    // (the random hex) plus a sequence suffix joined without a dash so the
    // result stays valid: e.g., 2026-05-18-abcd1234s1.
    const proposedSoFar = this.buffer.turns.filter((t) => t.role === "agent").length;
    const today = new Date().toISOString().slice(0, 10);
    const tail = this.chatId.split("-").slice(-1)[0]!;
    return `${today}-${tail}s${proposedSoFar}`;
  }

  // Public hook for the render layer / tests. Streams a trace event into
  // the chat surface and resolves any destructive prompt that fires.
  async streamTraceEvent(event: import("../state/trace.js").TraceEvent): Promise<{ destructiveResponse?: "yes" | "no" } | null> {
    this.opts.store.append({ type: "execution_event", at: new Date().toISOString(), source_event: event });
    const renderer = new PhaseEventRenderer({ write: (s) => this.opts.io.write(s) });
    const r = renderer.render(event);
    if (r?.destructivePrompt) {
      const response = await this.opts.io.prompt(r.destructivePrompt.text + "\n> ");
      const isYes = looksLikeApproval(response);
      this.opts.store.append({
        type: "destructive_prompt",
        at: new Date().toISOString(),
        detector: r.destructivePrompt.subtype,
        prompt_text: r.destructivePrompt.text,
        user_response: isYes ? "yes" : "no",
        at_response: new Date().toISOString(),
      });
      return { destructiveResponse: isYes ? "yes" : "no" };
    }
    return null;
  }

  // Test / debug accessors. Not exposed to production callers.
  getBuffer(): ConversationBuffer { return this.buffer; }
  getDriftCount(): number { return this.driftCount; }
  getPendingBrief(): Brief | null { return this.pendingBrief; }
}

// Adapter the runner.RunnerIO contract expects, wrapping a ChatIO so the
// chat layer can feed the runtime's existing io contract while routing
// runtime banners/prompts back to the user via chat.
export function runnerIoFromChatIo(io: ChatIO): RunnerIO {
  return {
    write: (text) => io.write(text),
    banner: (text) => io.write(`\n--- ${text} ---\n`),
    warn: (text) => io.write(`warning: ${text}\n`),
    prompt: (question) => io.prompt(question + "\n> "),
    confirm: async (question) => looksLikeApproval((await io.prompt(question + " (yes/no)\n> ")).trim()),
  };
}

// Re-export ChatStore + newChatId for the CLI entry point so it doesn't
// need to import deep paths.
export { ChatStore, newChatId };
