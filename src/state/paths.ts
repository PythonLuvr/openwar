import { homedir } from "node:os";
import { join } from "node:path";

export function openwarHome(): string {
  return process.env.OPENWAR_HOME ?? join(homedir(), ".openwar");
}

export function sessionsDir(): string {
  return join(openwarHome(), "sessions");
}

export function sessionFile(briefId: string): string {
  return join(sessionsDir(), `${sanitize(briefId)}.json`);
}

export function transcriptFile(briefId: string): string {
  return join(sessionsDir(), `${sanitize(briefId)}.transcript.jsonl`);
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

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
