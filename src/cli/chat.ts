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

import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { makeAdapter, type AdapterId } from "../adapters/index.js";
import type { AdapterConfig, AgentAdapter, Brief, RunOptions } from "../types.js";
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

  // Wire readline to the ChatIO contract.
  const rl = createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  const io: ChatIO = {
    write: (s) => process.stdout.write(s),
    prompt: (q) => rl.question(q),
  };

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
      const r = await run(runOpts);
      return {
        completed: r.completed,
        halted: r.halted,
        ...(r.halt_reason ? { halt_reason: r.halt_reason } : {}),
      };
    },
  };
  if (resumeEvents) sessionOpts.resumeEvents = resumeEvents;
  const session = new ChatSession(sessionOpts);

  // Main loop.
  try {
    while (true) {
      const line = await rl.question("> ");
      const outcome = await session.handleUserInput(line);
      if (outcome === "ended") break;
    }
  } finally {
    rl.close();
  }
  return 0;
}

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
