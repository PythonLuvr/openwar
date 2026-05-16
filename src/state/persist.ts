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

const SCHEMA_VERSION = 3;

interface PersistedShape extends SessionState {
  schema_version: number;
}

// In-place migrations. Each `migrateVNtoVN+1` is idempotent on already-current
// data and pure: it mutates the parsed object in place but returns the same
// reference so callers can chain. v1 was pre-0.3 (no schema_version), v2 is
// v0.3 (tool calls + session approvals on SessionMeta), v3 is v0.4
// (coordinator state, plan, subtask states, role transcripts, cost, budgets).

function migrateV1toV2(parsed: PersistedShape & { schema_version?: number }): PersistedShape {
  if ((parsed.schema_version ?? 1) >= 2) return parsed;
  if (!parsed.meta.session_approved_categories) parsed.meta.session_approved_categories = [];
  if (!parsed.meta.tool_calls) parsed.meta.tool_calls = [];
  parsed.schema_version = 2;
  parsed.meta.schema_version = 2;
  return parsed;
}

function migrateV2toV3(parsed: PersistedShape & { schema_version?: number }): PersistedShape {
  if ((parsed.schema_version ?? 2) >= 3) return parsed;
  const meta = parsed.meta as SessionState["meta"] & {
    coordinator_state?: string;
    plan?: unknown;
    subtask_states?: Record<string, unknown>;
    role_transcripts?: Record<string, unknown>;
    cost?: unknown;
    active_roles?: string[];
    budgets?: unknown;
    coordinator_events?: unknown[];
  };
  if (meta.coordinator_state === undefined) meta.coordinator_state = "init";
  if (meta.plan === undefined) meta.plan = null;
  if (!meta.subtask_states) meta.subtask_states = {};
  if (!meta.role_transcripts) meta.role_transcripts = {};
  if (!meta.cost) {
    meta.cost = {
      tokens_used: 0,
      wall_clock_ms: 0,
      tool_calls: 0,
      tool_calls_by_subtask: {},
      started_at: meta.started_at ?? new Date().toISOString(),
    };
  }
  // v2 sessions are single-agent; v3 default for a migrated v2 session is
  // single-agent (active_roles: []). Multi-agent sessions started fresh on v3
  // have this field populated by the runner.
  if (!meta.active_roles) meta.active_roles = [];
  if (!meta.budgets) {
    meta.budgets = {
      max_tokens: 50_000,
      max_wall_clock_minutes: 20,
      max_tool_calls_per_subtask: 15,
      max_retries_per_subtask: 3,
    };
  }
  if (!meta.coordinator_events) meta.coordinator_events = [];
  parsed.schema_version = 3;
  meta.schema_version = 3;
  return parsed;
}

function migrate(parsed: PersistedShape & { schema_version?: number }): PersistedShape {
  if ((parsed.schema_version ?? 1) > SCHEMA_VERSION) {
    throw new Error(
      `Session schema version ${parsed.schema_version} is newer than this runtime (expects ${SCHEMA_VERSION}). Upgrade openwar.`,
    );
  }
  parsed = migrateV1toV2(parsed);
  parsed = migrateV2toV3(parsed);
  return parsed;
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
  parsed = migrate(parsed);
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
