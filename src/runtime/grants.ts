// v0.12.0: PermissionBridge grant ledger.
//
// One per session. Holds in-memory grants for the duration of the session,
// and serializes `persistent` grants to a per-project JSONL file so the
// next session for the same project_slug starts with them already in the
// ledger. Loaded at session start; revocations are appended as
// status=revoked rows so the file stays append-only (same shape contract
// as the v0.6 memory store and v0.8 trace ndjson).
//
// Match semantics (per Phase 0 ruling):
//   - `this_call`     + category: matches the next Phase-3-firing tool call
//                                  whose required auth category overlaps.
//                                  Non-destructive calls between request
//                                  and match do NOT consume the grant.
//   - `this_call`     + no cat:   matches the next Phase-3-firing call
//                                  regardless of category.
//   - `this_session`  + category: matches every Phase-3-firing call with
//                                  a matching category until session end /
//                                  revocation. Does not get consumed
//                                  (consumed stays false on this_session).
//   - `this_session`  + no cat:   matches every Phase-3-firing call until
//                                  session end / revocation. Document this
//                                  clearly: it is broad on purpose.
//   - `persistent`               : same match rules as `this_session` but
//                                  survives the session in the per-project
//                                  store.
//
// Persistence boundary:
//   `persistent` grants land in `~/.openwar/projects/<slug>/permission_grants.jsonl`.
//   No project_slug means no persistence path; a `persistent` request in
//   that case falls back to `this_session` (documented in docs/permissions.md).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Grant, PermissionScope } from "../types.js";
import { permissionGrantsFile, projectDir } from "../state/paths.js";

export interface AddGrantInput {
  action: string;
  category: string | null;
  scope: PermissionScope;
  reasoning: string;
}

export interface PersistedGrantRow {
  // Discriminator. v0.12.0 ships one shape; revocations append a status=revoked
  // row keyed by the same grant_id rather than mutating the original line.
  op: "grant" | "revoke";
  grant_id: string;
  // Present on op="grant". Absent on op="revoke".
  action?: string;
  category?: string | null;
  scope?: PermissionScope;
  reasoning?: string;
  granted_at?: string;
  // Present on op="revoke".
  revoked_at?: string;
  // Schema marker; bump if the row shape ever changes.
  v: 1;
}

export interface GrantLedgerOptions {
  // Optional project slug. When set, `persistent` grants serialize to the
  // per-project JSONL file. When unset, `persistent` requests fall back to
  // `this_session` (documented).
  project_slug?: string;
  // Optional warn sink for non-fatal persistence errors (write failed, file
  // unreadable, etc.). The ledger never throws on persistence failures;
  // grants live in memory for the session and the operator gets a one-time
  // warning. Defaults to process.stderr.write.
  warn?: (msg: string) => void;
}

export class GrantLedger {
  private grants: Map<string, Grant> = new Map();
  private warned = false;
  private project_slug: string | undefined;
  private warn: (msg: string) => void;

  constructor(opts: GrantLedgerOptions = {}) {
    if (opts.project_slug) this.project_slug = opts.project_slug;
    this.warn = opts.warn ?? ((msg) => { try { process.stderr.write(msg); } catch { /* no-op */ } });
    if (this.project_slug) this.loadPersistent();
  }

  // ---- Loader (called once at construction when project_slug is set) ----

  private loadPersistent(): void {
    const path = permissionGrantsFile(this.project_slug!);
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      this.warnOnce(`openwar: permission_grants read failed (${(err as Error).message}); proceeding with empty persistent ledger.\n`);
      return;
    }
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    // Apply grants first, then revocations; iteration order in the file is
    // append order which preserves causality, but mid-line corruption
    // shouldn't drop subsequent valid entries.
    for (const line of lines) {
      let row: PersistedGrantRow;
      try {
        row = JSON.parse(line) as PersistedGrantRow;
      } catch {
        continue; // skip corrupt line
      }
      if (row.v !== 1) continue;
      if (row.op === "grant" && row.action && row.scope && row.granted_at && row.reasoning !== undefined) {
        this.grants.set(row.grant_id, {
          grant_id: row.grant_id,
          action: row.action,
          category: row.category ?? null,
          scope: row.scope,
          reasoning: row.reasoning,
          granted_at: row.granted_at,
          consumed: false,
        });
      } else if (row.op === "revoke") {
        const g = this.grants.get(row.grant_id);
        if (g) g.revoked = true;
      }
    }
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    this.warn(msg);
  }

  // ---- Public ledger ops ----

  // Register a granted permission and return the canonical Grant record.
  // For `persistent`, also append a row to the per-project JSONL file.
  // If `persistent` was requested but no project_slug is set, the scope
  // silently degrades to `this_session`; callers should check the returned
  // grant's scope to detect the fallback.
  addGrant(input: AddGrantInput): Grant {
    let scope = input.scope;
    if (scope === "persistent" && !this.project_slug) {
      scope = "this_session";
    }
    const grant: Grant = {
      grant_id: randomUUID(),
      action: input.action,
      category: input.category,
      scope,
      reasoning: input.reasoning,
      granted_at: new Date().toISOString(),
      consumed: false,
    };
    this.grants.set(grant.grant_id, grant);
    if (scope === "persistent") this.persistGrant(grant);
    return grant;
  }

  // Find the next matching grant for a destructive tool call. Returns null
  // when no grant matches. Match rules per Phase 0 ruling:
  //   1. Skip revoked grants and consumed `this_call` grants.
  //   2. `this_call` with a category matches if categories overlap.
  //   3. `this_call` with no category matches the next call regardless.
  //   4. `this_session` / `persistent` match by category overlap, or any
  //      call if category is null.
  // Prefer the most-recently-granted matching `this_call` (intent: "I'm
  // about to do X; let me do it"). If no `this_call` matches, fall back to
  // session / persistent.
  findMatchingGrant(toolCallCategories: readonly string[]): Grant | null {
    // First pass: most-recent unconsumed this_call grant that matches.
    let candidate: Grant | null = null;
    for (const g of this.grants.values()) {
      if (g.revoked) continue;
      if (g.scope !== "this_call") continue;
      if (g.consumed) continue;
      if (g.category === null || toolCallCategories.includes(g.category)) {
        // Pick the most recent (later granted_at wins).
        if (!candidate || g.granted_at > candidate.granted_at) candidate = g;
      }
    }
    if (candidate) return candidate;
    // Second pass: any matching session / persistent grant.
    for (const g of this.grants.values()) {
      if (g.revoked) continue;
      if (g.scope === "this_call") continue;
      if (g.category === null || toolCallCategories.includes(g.category)) {
        return g;
      }
    }
    return null;
  }

  // Mark a grant as consumed. Only `this_call` grants actually flip
  // `consumed`; session / persistent grants stay un-consumed (they cover
  // many calls). No-op for unknown ids.
  consumeGrant(grant_id: string): void {
    const g = this.grants.get(grant_id);
    if (!g) return;
    if (g.scope === "this_call") g.consumed = true;
  }

  // Revoke a grant. Returns true if the grant existed and was active
  // (not previously revoked); false otherwise. Persistent grants get a
  // revoke row appended to the JSONL store.
  revokeGrant(grant_id: string): boolean {
    const g = this.grants.get(grant_id);
    if (!g || g.revoked) return false;
    g.revoked = true;
    if (g.scope === "persistent") this.persistRevoke(grant_id);
    return true;
  }

  // Snapshot the current active grants. Includes consumed `this_call`
  // grants until session end (the inspect surface wants to show them).
  // Excludes revoked grants by default; callers wanting the full audit
  // trail should read the trace instead.
  listActive(): readonly Grant[] {
    return [...this.grants.values()].filter((g) => !g.revoked);
  }

  // Full snapshot including revoked. Used by `openwar inspect --permissions`.
  listAll(): readonly Grant[] {
    return [...this.grants.values()];
  }

  // ---- Persistence helpers (private) ----

  private persistGrant(g: Grant): void {
    if (!this.project_slug) return;
    const row: PersistedGrantRow = {
      v: 1,
      op: "grant",
      grant_id: g.grant_id,
      action: g.action,
      category: g.category,
      scope: g.scope,
      reasoning: g.reasoning,
      granted_at: g.granted_at,
    };
    this.appendRow(row);
  }

  private persistRevoke(grant_id: string): void {
    if (!this.project_slug) return;
    const row: PersistedGrantRow = {
      v: 1,
      op: "revoke",
      grant_id,
      revoked_at: new Date().toISOString(),
    };
    this.appendRow(row);
  }

  private appendRow(row: PersistedGrantRow): void {
    const path = permissionGrantsFile(this.project_slug!);
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
    } catch (err) {
      this.warnOnce(`openwar: permission_grants write failed (${(err as Error).message}); grant lives in memory only for this session.\n`);
    }
  }
}

// Re-export the project-dir helper for tests that want to clean up
// generated files without re-importing from state/paths.
export { projectDir };
