import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { SessionState } from "../types.js";
import { sessionsDir, sessionFile } from "./paths.js";

const SCHEMA_VERSION = 1;

interface PersistedShape extends SessionState {
  schema_version: number;
}

export function ensureSessionsDir(): string {
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSession(state: SessionState): void {
  ensureSessionsDir();
  const path = sessionFile(state.meta.brief_id);
  const payload: PersistedShape = { schema_version: SCHEMA_VERSION, ...state };
  // Write atomically: write to .tmp then rename.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  // On Windows rename over an existing file is supported when the target is closed.
  // Fall back to a plain write on EPERM.
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  }
}

export function readSession(briefId: string): SessionState | null {
  const path = sessionFile(briefId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: PersistedShape;
  try {
    parsed = JSON.parse(raw) as PersistedShape;
  } catch (err) {
    throw new Error(`Session file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `Session schema version ${parsed.schema_version} not supported by runtime (expected ${SCHEMA_VERSION}).`,
    );
  }
  // Discard the schema_version field at the API boundary.
  const { schema_version: _v, ...rest } = parsed;
  void _v;
  return rest;
}

export interface SessionIndexEntry {
  brief_id: string;
  project: string;
  phase: string;
  updated_at: string;
  path: string;
}

export function listSessions(): SessionIndexEntry[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const entries: SessionIndexEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as PersistedShape;
      entries.push({
        brief_id: parsed.meta.brief_id,
        project: parsed.meta.project,
        phase: parsed.meta.phase,
        updated_at: parsed.meta.updated_at,
        path,
      });
    } catch {
      // Skip unreadable files; do not abort the listing.
    }
  }
  entries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return entries;
}

export function sessionExists(briefId: string): boolean {
  const path = sessionFile(briefId);
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
