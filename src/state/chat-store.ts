// v0.10.0: chat session persistence.
//
// NDJSON append-only at ~/.openwar/chats/<chat_id>.ndjson. First line is a
// chat_session_started header carrying schema_version so v0.10.x can add
// fields without silently breaking resume. Same atomicity model as the v0.8
// trace writer: fs.appendFileSync per event, "any complete line is a
// complete event."
//
// Schema-version mismatch on load raises ChatStoreSchemaError with a clear
// remediation path rather than silently defaulting.

import { appendFileSync, existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { chatFile, chatsDir } from "./paths.js";
import type { Brief } from "../types.js";
import type { TraceEvent } from "./trace.js";
import type { Intent } from "../chat/intent.js";

export const CHAT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Event types persisted to <chat_id>.ndjson.

export interface ChatSessionStartedEvent {
  type: "chat_session_started";
  chat_id: string;
  schema_version: number;
  started_at: string;
  openwar_version: string;
  // The adapter the conversation agent runs on (tool-call-capable).
  agent_adapter: string;
  agent_model: string;
  // The adapter used for executing compiled briefs. May equal agent_adapter
  // or be different (per-role split; e.g., agent on anthropic, execution on
  // cli-bridge to local Claude Code).
  exec_adapter: string;
  exec_model: string;
  // Project slug if loaded via --project or inferred from cwd. Null otherwise.
  project_slug: string | null;
}

export interface UserTurnEvent {
  type: "user_turn";
  at: string;
  content: string;
}

export interface AgentTurnEvent {
  type: "agent_turn";
  at: string;
  // The raw free-text the agent produced alongside its tool call (may be empty).
  content: string;
  // Recognized intent name. "drift" when the agent failed to produce a valid
  // tool call this turn; the session manager handles fallback in that case.
  intent: Intent["intent"] | "drift";
}

export interface PlanProposedEvent {
  type: "plan_proposed";
  at: string;
  // The compiled brief draft the agent proposed. Stored as the parsed Brief
  // shape so resume can re-present it without rerunning the compiler.
  brief_draft: Brief;
  plan_text: string;
}

export interface PlanApprovedEvent {
  type: "plan_approved";
  at: string;
}

export interface PlanRejectedEvent {
  type: "plan_rejected";
  at: string;
  reason: string | null;
}

export interface ExecutionStartedEvent {
  type: "execution_started";
  at: string;
  // The brief_id of the compiled brief that's now running.
  brief_id: string;
}

export interface ExecutionEventEvent {
  type: "execution_event";
  at: string;
  // Mirror of a runtime trace event. The chat session keeps a copy so resume
  // can replay the rendered chat output without re-reading the trace file.
  source_event: TraceEvent;
}

export interface ExecutionCompletedEvent {
  type: "execution_completed";
  at: string;
  outcome: "success" | "blocked" | "aborted";
}

export interface DestructivePromptEvent {
  type: "destructive_prompt";
  at: string;
  detector: string;
  prompt_text: string;
  user_response: "yes" | "no";
  at_response: string;
}

export interface BriefSavedEvent {
  type: "brief_saved";
  at: string;
  path: string;
}

export interface ChatSessionEndedEvent {
  type: "chat_session_ended";
  at: string;
  reason: "user_quit" | "session_timeout" | "error" | "hard_fail_intent_drift";
}

export type ChatEvent =
  | ChatSessionStartedEvent
  | UserTurnEvent
  | AgentTurnEvent
  | PlanProposedEvent
  | PlanApprovedEvent
  | PlanRejectedEvent
  | ExecutionStartedEvent
  | ExecutionEventEvent
  | ExecutionCompletedEvent
  | DestructivePromptEvent
  | BriefSavedEvent
  | ChatSessionEndedEvent;

// ---------------------------------------------------------------------------
// ID generation. Matches v0.6 memory IDs in shape: chat-<base36-ts>-<hex>.

export function newChatId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `chat-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Errors.

export class ChatStoreSchemaError extends Error {
  readonly code: "PARSE" | "MISSING_HEADER" | "VERSION_MISMATCH";
  readonly path: string;
  constructor(code: "PARSE" | "MISSING_HEADER" | "VERSION_MISMATCH", path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.name = "ChatStoreSchemaError";
  }
}

// ---------------------------------------------------------------------------
// Writer. Mirrors the v0.8 Tracer pattern: header on first write, swallow
// errors in production (warn-once to stderr), strict-mode for tests.

export interface ChatStoreOptions {
  chatId: string;
  // When false, all appends are no-ops. Used by --no-save and ephemeral tests.
  enabled: boolean;
  // Carried into the header event.
  openwarVersion: string;
  agentAdapter: string;
  agentModel: string;
  execAdapter: string;
  execModel: string;
  projectSlug: string | null;
  // Override the file path. Production passes nothing.
  filePath?: string;
}

export class ChatStore {
  readonly chatId: string;
  readonly enabled: boolean;
  readonly filePath: string;
  private headerWritten = false;
  private warned = false;
  private readonly opts: ChatStoreOptions;

  constructor(opts: ChatStoreOptions) {
    this.chatId = opts.chatId;
    this.enabled = opts.enabled;
    this.filePath = opts.filePath ?? chatFile(opts.chatId);
    this.opts = opts;
    if (this.enabled) this.ensureHeader();
  }

  private ensureHeader(): void {
    if (this.headerWritten) return;
    try {
      if (existsSync(this.filePath)) {
        this.headerWritten = true;
        return;
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
    } catch (err) {
      if (process.env.OPENWAR_CHAT_STRICT === "1") throw err;
      this.headerWritten = true;
      this.warned = true;
      try {
        process.stderr.write(
          `openwar: chat store setup failed (${(err as Error).message}); session not persisted.\n`,
        );
      } catch {
        /* ignore */
      }
      return;
    }
    const header: ChatSessionStartedEvent = {
      type: "chat_session_started",
      chat_id: this.chatId,
      schema_version: CHAT_SCHEMA_VERSION,
      started_at: new Date().toISOString(),
      openwar_version: this.opts.openwarVersion,
      agent_adapter: this.opts.agentAdapter,
      agent_model: this.opts.agentModel,
      exec_adapter: this.opts.execAdapter,
      exec_model: this.opts.execModel,
      project_slug: this.opts.projectSlug,
    };
    this.writeLine(header);
    this.headerWritten = true;
  }

  append(event: ChatEvent): void {
    if (!this.enabled) return;
    this.writeLine(event);
  }

  private writeLine(event: ChatEvent): void {
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      if (process.env.OPENWAR_CHAT_STRICT === "1") throw err;
      if (!this.warned) {
        this.warned = true;
        try {
          process.stderr.write(
            `openwar: chat persist failed (${(err as Error).message}); further failures suppressed.\n`,
          );
        } catch { /* nothing left to do */ }
      }
    }
  }
}

export function nullChatStore(): ChatStore {
  return new ChatStore({
    chatId: "null",
    enabled: false,
    openwarVersion: "0.0.0",
    agentAdapter: "mock",
    agentModel: "mock",
    execAdapter: "mock",
    execModel: "mock",
    projectSlug: null,
  });
}

// ---------------------------------------------------------------------------
// Reader. Used by resume and inspect surfaces. Schema-version mismatch is a
// hard error; missing header is a hard error; corrupted lines accumulate but
// don't block the load.

export interface ReadChatResult {
  events: ChatEvent[];
  corrupted_lines: number[];
}

export function readChat(chatId: string): ReadChatResult {
  return readChatFromPath(chatFile(chatId));
}

export function readChatFromPath(path: string): ReadChatResult {
  if (!existsSync(path)) {
    throw new ChatStoreSchemaError("PARSE", path, `Chat file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) {
    throw new ChatStoreSchemaError("MISSING_HEADER", path, `Chat file is empty: ${path}`);
  }
  const events: ChatEvent[] = [];
  const corrupted_lines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {
      corrupted_lines.push(i + 1);
    }
  }
  if (events.length === 0) {
    throw new ChatStoreSchemaError("MISSING_HEADER", path, `No parseable events in chat file: ${path}`);
  }
  const header = events[0];
  if (header?.type !== "chat_session_started") {
    throw new ChatStoreSchemaError(
      "MISSING_HEADER",
      path,
      `First event must be chat_session_started, got ${String(header?.type)}.`,
    );
  }
  if (header.schema_version !== CHAT_SCHEMA_VERSION) {
    throw new ChatStoreSchemaError(
      "VERSION_MISMATCH",
      path,
      `Chat schema_version=${header.schema_version} does not match runtime ${CHAT_SCHEMA_VERSION}. ` +
        `Resume not supported across schema versions. Start a new chat or downgrade to a matching openwar release.`,
    );
  }
  return { events, corrupted_lines };
}

// ---------------------------------------------------------------------------
// Listing. Used by --resume last.

export interface ChatIndexEntry {
  chat_id: string;
  path: string;
  started_at: string;
  // Wall-clock from filesystem mtime. Cheaper than scanning the whole file
  // for the last event timestamp.
  updated_at: string;
}

export function listChats(): ChatIndexEntry[] {
  const dir = chatsDir();
  if (!existsSync(dir)) return [];
  const entries: ChatIndexEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ndjson")) continue;
    const path = `${dir}/${file}`;
    try {
      const stat = statSync(path);
      const raw = readFileSync(path, "utf8");
      const firstLine = raw.split(/\r?\n/, 1)[0];
      if (!firstLine) continue;
      const header = JSON.parse(firstLine) as ChatSessionStartedEvent;
      if (header.type !== "chat_session_started") continue;
      entries.push({
        chat_id: header.chat_id,
        path,
        started_at: header.started_at,
        updated_at: stat.mtime.toISOString(),
      });
    } catch {
      /* skip unreadable */
    }
  }
  entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return entries;
}

export function mostRecentChatId(): string | null {
  const list = listChats();
  return list.length > 0 ? list[0]!.chat_id : null;
}
