import { homedir } from "node:os";
import { join } from "node:path";

export function openwarHome(): string {
  return process.env.OPENWAR_HOME ?? join(homedir(), ".openwar");
}

// v0.8: OPENWAR_SESSIONS_DIR overrides the default `<OPENWAR_HOME>/sessions`
// location wholesale. Useful for integrators (War Room) who relocate the
// session store, and for tests pointing at a tmpdir.
export function sessionsDir(): string {
  if (process.env.OPENWAR_SESSIONS_DIR) return process.env.OPENWAR_SESSIONS_DIR;
  return join(openwarHome(), "sessions");
}

export function sessionFile(briefId: string): string {
  return join(sessionsDir(), `${sanitize(briefId)}.json`);
}

export function transcriptFile(briefId: string): string {
  return join(sessionsDir(), `${sanitize(briefId)}.transcript.jsonl`);
}

// v0.8: structured trace event stream. Sibling to the transcript, flat layout
// (kept consistent with sessionFile / transcriptFile rather than introducing a
// per-session subfolder).
export function traceFile(briefId: string): string {
  return join(sessionsDir(), `${sanitize(briefId)}.trace.ndjson`);
}

// v0.10: chat session persistence. NDJSON append-only, same shape contract as
// trace files so inspect tooling can read both. Lives under <OPENWAR_HOME>/
// chats/ to keep the sessions/ directory focused on brief runs.
export function chatsDir(): string {
  if (process.env.OPENWAR_CHATS_DIR) return process.env.OPENWAR_CHATS_DIR;
  return join(openwarHome(), "chats");
}

export function chatFile(chatId: string): string {
  return join(chatsDir(), `${sanitize(chatId)}.ndjson`);
}

// v0.10: directory where saved-from-chat briefs land. Operator can run these
// via `openwar run ~/.openwar/briefs/<name>.md` for replay.
export function briefsDir(): string {
  return join(openwarHome(), "briefs");
}

export function savedBriefPath(name: string): string {
  return join(briefsDir(), `${sanitize(name)}.md`);
}

// v0.6: per-project persistence root. Sibling to sessions/. Holds the three
// memory category JSONL files (decisions, knowledge, constraints). The slug
// is the brief's `project` field after path sanitization.
export function projectsDir(): string {
  return join(openwarHome(), "projects");
}

export function projectDir(projectSlug: string): string {
  return join(projectsDir(), sanitize(projectSlug));
}

export type MemoryCategory = "decisions" | "knowledge" | "constraints";
export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "decisions",
  "knowledge",
  "constraints",
] as const;

export function memoryFile(projectSlug: string, category: MemoryCategory): string {
  return join(projectDir(projectSlug), `${category}.jsonl`);
}

// v0.12.0: persistent PermissionBridge grants. JSONL append-only sibling to
// the memory category files. Owned directly by the GrantLedger (not by the
// memory tools), so the read/write/list_project_memory surface stays
// unchanged. Loaded at session start when project_slug is set.
export function permissionGrantsFile(projectSlug: string): string {
  return join(projectDir(projectSlug), "permission_grants.jsonl");
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
