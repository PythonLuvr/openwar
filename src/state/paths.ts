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

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}
