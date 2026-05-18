// v0.10.0: `openwar chat` CLI entry point.
//
// Default adapter resolution (the conversation agent, NOT execution):
//   1. ANTHROPIC_API_KEY -> anthropic
//   2. OPENAI_API_KEY    -> openai
//   3. GEMINI_API_KEY / GOOGLE_API_KEY -> gemini
//   4. XAI_API_KEY       -> grok
//   5. OPENAI_COMPAT_API_KEY -> openai-compat
//   Nothing set: hard error with the install/setup hint.
//
// cli-bridge is NOT compatible with the conversation agent because it does
// not surface tool-call events to OpenWar. The hand-authored brief path
// stays the no-BYOK escape hatch.
//
// Execution adapter (separate from conversation agent) defaults to the same
// adapter as the conversation agent, but can be overridden via
// --exec-adapter cli-bridge --exec-binary claude for free local execution
// on a user's existing Claude Code subscription.

import { createInterface, Interface as ReadlineInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { makeAdapter, type AdapterId } from "../adapters/index.js";
import type { AdapterConfig, AgentAdapter, Brief, RunOptions, Session } from "../types.js";
import { runtimeVersion } from "../version.js";
import { ChatSession, runnerIoFromChatIo, type ChatIO } from "../chat/session.js";
import { loadContextForChat } from "../chat/context.js";
import {
  ChatStore,
  newChatId,
  readChat,
  mostRecentChatId,
  ChatStoreSchemaError,
} from "../state/chat-store.js";
import { run } from "../runner.js";

const ADAPTER_PRECEDENCE: Array<{ envVar: string; adapter: AdapterId; label: string }> = [
  { envVar: "ANTHROPIC_API_KEY", adapter: "anthropic", label: "Anthropic Claude" },
  { envVar: "OPENAI_API_KEY", adapter: "openai", label: "OpenAI" },
  { envVar: "GEMINI_API_KEY", adapter: "gemini", label: "Google Gemini" },
  { envVar: "GOOGLE_API_KEY", adapter: "gemini", label: "Google Gemini" },
  { envVar: "XAI_API_KEY", adapter: "grok", label: "xAI Grok" },
  { envVar: "OPENAI_COMPAT_API_KEY", adapter: "openai-compat", label: "OpenAI-compatible" },
];

export interface ChatCommandOptions {
  resume?: string; // chat_id or "last"
  adapter?: string;
  model?: string;
  execAdapter?: string;
  execBinary?: string;
  project?: string;
  noSave?: boolean;
  // v0.10.0: programmatic I/O override. Production passes nothing (defaults
  // to process.stdin / process.stdout). Tests inject Readable / Writable
  // streams so the chat loop is exercisable without a real terminal. Also
  // used by the Windows readline smoke tests.
  stdin?: Readable;
  stdout?: Writable;
  // When true, the chat loop returns after the first /quit-induced ended
  // outcome instead of looping until stream closure. Defaults true; tests
  // that want to drive multiple iterations explicitly set false.
  exitOnQuit?: boolean;
}

export interface ResolvedAdapterChoice {
  adapter: AgentAdapter;
  config: AdapterConfig;
  source: "explicit" | "env";
}

export class ChatStartupError extends Error {
  readonly code: "NO_ADAPTER" | "INCOMPATIBLE_ADAPTER" | "RESUME_NOT_FOUND" | "RESUME_INVALID";
  constructor(code: "NO_ADAPTER" | "INCOMPATIBLE_ADAPTER" | "RESUME_NOT_FOUND" | "RESUME_INVALID", message: string) {
    super(message);
    this.code = code;
    this.name = "ChatStartupError";
  }
}

// Adapter ids that DON'T support OpenWar-side tool-call output (the
// conversation agent contract requires tool calls; see src/chat/intent.ts).
const NON_TOOL_CALL_ADAPTERS: readonly string[] = ["cli-bridge"];

export function resolveConversationAdapter(opts: ChatCommandOptions): ResolvedAdapterChoice {
  const env = process.env;
  // Explicit adapter wins.
  if (opts.adapter) {
    if (NON_TOOL_CALL_ADAPTERS.includes(opts.adapter)) {
      throw new ChatStartupError(
        "INCOMPATIBLE_ADAPTER",
        `Adapter "${opts.adapter}" is not compatible with 'openwar chat' (intent extraction needs structured tool calls, which ${opts.adapter} cannot provide).\n\n` +
          `For free local execution via your existing Claude Code subscription, use:\n` +
          `  openwar chat --exec-adapter cli-bridge --exec-binary claude\n\n` +
          `That uses cli-bridge for the work but keeps the conversation agent on a tool-call-capable adapter (set ANTHROPIC_API_KEY etc.).\n\n` +
          `cli-bridge stays fully supported for hand-authored briefs:\n` +
          `  openwar run brief.md --adapter cli-bridge --binary claude`,
      );
    }
    const config: AdapterConfig = { id: opts.adapter };
    if (opts.model) config.model = opts.model;
    const adapter = makeAdapter(config);
    if (!adapter.isConfigured()) {
      throw new ChatStartupError(
        "NO_ADAPTER",
        `Adapter "${opts.adapter}" is not configured (missing API key env var).`,
      );
    }
    return { adapter, config, source: "explicit" };
  }
  // BYOK env-var precedence.
  for (const { envVar, adapter: id } of ADAPTER_PRECEDENCE) {
    if (env[envVar] && env[envVar]!.length > 0) {
      const config: AdapterConfig = { id };
      if (opts.model) config.model = opts.model;
      try {
        const adapter = makeAdapter(config);
        if (adapter.isConfigured()) return { adapter, config, source: "env" };
      } catch {
        // Try next.
      }
    }
  }
  throw new ChatStartupError(
    "NO_ADAPTER",
    `openwar chat requires an adapter with tool-call support for intent extraction.\n` +
      `Set one of: ${ADAPTER_PRECEDENCE.map((p) => p.envVar).join(", ")}.\n\n` +
      `cli-bridge is not compatible with openwar chat (intent extraction needs structured\n` +
      `tool calls, which cli-bridge cannot provide). cli-bridge stays fully supported for\n` +
      `hand-authored briefs:\n\n` +
      `  openwar run brief.md --adapter cli-bridge --binary claude`,
  );
}

export function resolveExecAdapter(
  opts: ChatCommandOptions,
  conversationChoice: ResolvedAdapterChoice,
): AgentAdapter {
  if (!opts.execAdapter) {
    // Default: same as conversation agent.
    return conversationChoice.adapter;
  }
  const config: AdapterConfig = { id: opts.execAdapter };
  if (opts.execAdapter === "cli-bridge") {
    const extra: Record<string, unknown> = {};
    if (opts.execBinary) extra.binary = opts.execBinary;
    config.extra = extra;
  }
  return makeAdapter(config);
}

// Main entry. Wires stdin/stdout to a ChatSession and drives the loop until
// the user types /quit or hits the hard-fail intent-drift wall.
export async function runChatCommand(opts: ChatCommandOptions): Promise<number> {
  const conversationChoice = resolveConversationAdapter(opts);
  const execAdapter = resolveExecAdapter(opts, conversationChoice);

  // Resolve resume target if requested.
  let chatId: string;
  let resumeEvents: ReturnType<typeof readChat>["events"] | undefined;
  if (opts.resume) {
    const targetId = opts.resume === "last" ? mostRecentChatId() : opts.resume;
    if (!targetId) {
      throw new ChatStartupError("RESUME_NOT_FOUND", `No chat sessions found to resume.`);
    }
    try {
      resumeEvents = readChat(targetId).events;
      chatId = targetId;
    } catch (err) {
      if (err instanceof ChatStoreSchemaError) {
        throw new ChatStartupError("RESUME_INVALID", err.message);
      }
      throw err;
    }
  } else {
    chatId = newChatId();
  }

  const projectSlug = opts.project ?? inferProjectSlug(process.cwd());
  const workdir = process.cwd();

  const store = new ChatStore({
    chatId,
    enabled: !opts.noSave,
    openwarVersion: runtimeVersion(),
    agentAdapter: conversationChoice.adapter.id,
    agentModel: conversationChoice.adapter.model,
    execAdapter: execAdapter.id,
    execModel: execAdapter.model,
    projectSlug,
  });

  // Wire readline to the ChatIO contract. stdin / stdout are overridable so
  // tests can drive the loop without a real terminal.
  const stdinStream = opts.stdin ?? process.stdin;
  const stdoutStream = opts.stdout ?? process.stdout;
  const rl: ReadlineInterface = createInterface({
    input: stdinStream,
    output: stdoutStream,
    historySize: 200,
    // terminal:false disables raw mode + ANSI escape interpretation when
    // we're driving from a pipe / non-TTY (Windows specifically gets weird
    // with the default heuristic). Production stdin IS a TTY so we let it
    // auto-detect; tests pass a Readable and inherit terminal:false.
    ...(opts.stdin ? { terminal: false } : {}),
  });
  const io: ChatIO = {
    write: (s) => { stdoutStream.write(s); },
    prompt: (q) => rl.question(q),
  };

  // v0.10.0 + v0.11.1: Ctrl-C handling.
  //
  // v0.10.0 baseline: SIGINT closes readline cleanly so the main loop's
  // exit path runs with banner + saved-session message. Critical on Windows
  // where Ctrl-C interrupts mid-line more aggressively than on POSIX.
  //
  // v0.11.1 addition: when a tool call is in flight inside the active run,
  // the first SIGINT cancels that tool (via Session.cancelCurrentToolCall)
  // instead of closing readline; a second SIGINT within
  // CTRL_C_ESCALATE_MS escalates to the v0.10.0 close path. SIGINT with
  // no in-flight tool call always closes (unchanged from v0.10.0).
  let liveSession: Session | null = null;
  let firstCancelAt = 0;
  const sigintHandler = (): void => {
    const now = Date.now();
    if (liveSession && now - firstCancelAt < CTRL_C_ESCALATE_MS) {
      // Second ctrl-c inside the escalate window. Fall through to close.
      firstCancelAt = 0;
      try { rl.close(); } catch { /* already closed */ }
      return;
    }
    if (liveSession) {
      // First ctrl-c with an active run. Try to cancel the in-flight tool
      // call; if no call is active, treat it as the regular close path.
      void liveSession.cancelCurrentToolCall().then((fired) => {
        if (fired) {
          firstCancelAt = now;
          stdoutStream.write("\nCancelling tool call... (press Ctrl-C again within 2s to exit)\n");
        } else {
          try { rl.close(); } catch { /* already closed */ }
        }
      });
      return;
    }
    // No active run: existing v0.10.0 behavior.
    try { rl.close(); } catch { /* already closed */ }
  };
  // Only install for the real process.stdin path; tests with injected stdin
  // never receive SIGINT in this process.
  if (!opts.stdin) process.on("SIGINT", sigintHandler);

  // Banner.
  io.write(`openwar v${runtimeVersion()} chat session ${opts.resume ? `(resumed: ${chatId})` : `started (id: ${chatId})`}\n`);
  io.write(`agent: ${conversationChoice.adapter.id}  exec: ${execAdapter.id}  project: ${projectSlug}\n`);

  // Load project memory + learned profile context, if any.
  const context = await loadContextForChat({ slug: projectSlug });
  if (context.memorySummary) io.write(context.memorySummary + "\n");
  if (context.learnedSummary) io.write(context.learnedSummary + "\n");
  io.write(`Type your request, or /help for commands.\n\n`);

  const sessionOpts: ConstructorParameters<typeof ChatSession>[0] = {
    io,
    agentAdapter: conversationChoice.adapter,
    execAdapter,
    projectSlug,
    workdir,
    store,
    contextNotes: context.notes,
    executeRun: async (brief: Brief) => {
      // v0.10.0: when a learned profile exists for this project, stamp it
      // into the compiled brief's frontmatter so the runtime applies it at
      // execution time (per v0.9.1 contract).
      if (context.learnedProfile) {
        brief.frontmatter.learned_profile = projectSlug;
      }
      // Execute the compiled brief through the runtime, wiring the chat io
      // through as the RunnerIO. Pass chatId so the trace gets the
      // chat_session_compiled marker.
      const runnerIo = runnerIoFromChatIo(io);
      const runOpts: RunOptions = {
        briefSource: brief.raw,
        adapter: execAdapter,
        io: runnerIo,
      };
      runOpts.chatId = chatId;
      // v0.11.1: capture the live Session so the SIGINT handler can
      // cancel in-flight tool calls. Clear it after the run returns.
      runOpts.onSession = (s) => { liveSession = s; };
      try {
        const r = await run(runOpts);
        return {
          completed: r.completed,
          halted: r.halted,
          ...(r.halt_reason ? { halt_reason: r.halt_reason } : {}),
        };
      } finally {
        liveSession = null;
        firstCancelAt = 0;
      }
    },
  };
  if (resumeEvents) sessionOpts.resumeEvents = resumeEvents;
  const session = new ChatSession(sessionOpts);

  // Main loop. Catches readline closure (Ctrl-C, EOF on piped stdin, /quit
  // -> rl.close path) and exits cleanly. exitOnQuit defaults true; the only
  // caller that sets it false is the integration test that wants the loop
  // to terminate immediately after the input stream ends.
  const exitOnQuit = opts.exitOnQuit ?? true;
  // Track close state so we can short-circuit the question() race below.
  let rlClosed = false;
  rl.once("close", () => { rlClosed = true; });
  // Run-once flag so an EOF-induced /quit doesn't loop the chat-end banner.
  let endedByEof = false;
  try {
    while (true) {
      if (rlClosed) {
        if (!endedByEof) {
          endedByEof = true;
          await session.handleUserInput("/quit");
        }
        break;
      }
      // Race rl.question against the close event. node:readline/promises'
      // question() does NOT reject on close (it just hangs), so we wrap it
      // in a Promise.race so EOF / SIGINT unblocks the loop reliably on
      // both POSIX and Windows.
      const closeSignal = new Promise<typeof EOF_SENTINEL>((resolve) => {
        rl.once("close", () => resolve(EOF_SENTINEL));
      });
      const line = await Promise.race([rl.question("> "), closeSignal]);
      if (line === EOF_SENTINEL) {
        if (!endedByEof) {
          endedByEof = true;
          await session.handleUserInput("/quit");
        }
        break;
      }
      const outcome = await session.handleUserInput(line);
      if (outcome === "ended" && exitOnQuit) break;
    }
  } finally {
    if (!opts.stdin) process.off("SIGINT", sigintHandler);
    try { rl.close(); } catch { /* already closed */ }
  }
  return 0;
}

// Sentinel used by the main-loop Promise.race so we can distinguish EOF
// from a normal user line without coupling to a magic string the user
// might actually type.
const EOF_SENTINEL = Symbol("openwar.chat.eof") as unknown as string;

// v0.11.1: how long after a first Ctrl-C-during-tool-call before a second
// Ctrl-C escalates to a regular readline close (and the chat-end banner +
// saved-session path). Hardcoded per the brief's Q1 lean; if a user
// requests configurability later, ship it then.
const CTRL_C_ESCALATE_MS = 2000;

// Infer project slug from working directory basename. Operator can override
// with --project. Conservative: sanitizes to alphanumeric + dash so the
// inferred slug is always a legal project id.
export function inferProjectSlug(cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? "default";
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

// Default home for saved briefs / chats; useful for tests overriding env.
export function chatDefaultPaths(): { home: string; chatsDir: string; briefsDir: string } {
  const home = process.env.OPENWAR_HOME ?? join(homedir(), ".openwar");
  return {
    home,
    chatsDir: join(home, "chats"),
    briefsDir: join(home, "briefs"),
  };
}

// Re-export for the dispatcher in cli.ts.
export { ChatSession };
void existsSync;
void resolve;
