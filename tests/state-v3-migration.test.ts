import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "../src/state/persist.js";

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openwar-mig-"));
  process.env.OPENWAR_HOME = join(home, ".openwar");
  mkdirSync(join(home, ".openwar", "sessions"), { recursive: true });
  return home;
}

function cleanup(home: string): void {
  rmSync(home, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
}

test("v1 session migrates to v3 with default cost/budgets/active_roles", () => {
  const home = setupHome();
  try {
    const briefId = "2026-01-01-v1";
    // v1 had no schema_version, no session_approved_categories, no tool_calls,
    // no coordinator_state, etc.
    const payload = {
      meta: {
        brief_id: briefId,
        project: "legacy",
        started_at: "2025-12-01T00:00:00Z",
        updated_at: "2025-12-01T00:01:00Z",
        phase: "done",
        mode: "auto",
        destructive_approvals: [],
        transitions: [],
      },
      brief: { frontmatter: { project: "legacy", scope_locked: false, authorized_costs: [] }, sections: { objective: "", deliverables: "", constraints: "", tools_required: "", notes: "", extra: {} }, raw: "" },
      messages: [],
    };
    writeFileSync(
      join(process.env.OPENWAR_HOME!, "sessions", `${briefId}.json`),
      JSON.stringify(payload),
    );
    const loaded = readSession(briefId);
    assert.ok(loaded);
    const meta = loaded!.meta as typeof loaded.meta & {
      coordinator_state?: string;
      plan?: unknown;
      subtask_states?: Record<string, unknown>;
      role_transcripts?: Record<string, unknown>;
      cost?: { tokens_used: number };
      active_roles?: string[];
      budgets?: { max_tokens: number };
    };
    assert.equal(meta.session_approved_categories?.length, 0);
    assert.equal(meta.tool_calls?.length, 0);
    assert.equal(meta.coordinator_state, "init");
    assert.equal(meta.plan, null);
    assert.deepEqual(meta.subtask_states, {});
    assert.deepEqual(meta.role_transcripts, {});
    assert.equal(meta.cost?.tokens_used, 0);
    // v1 sessions are pre-multi-agent; default to single-agent.
    assert.deepEqual(meta.active_roles, []);
    assert.ok(meta.budgets);
    assert.equal(typeof meta.budgets!.max_tokens, "number");
  } finally {
    cleanup(home);
  }
});

test("v2 session migrates to v3 in place", () => {
  const home = setupHome();
  try {
    const briefId = "2026-01-01-v2";
    const payload = {
      schema_version: 2,
      meta: {
        brief_id: briefId,
        project: "legacy",
        started_at: "2025-12-01T00:00:00Z",
        updated_at: "2025-12-01T00:01:00Z",
        phase: "done",
        mode: "auto",
        destructive_approvals: [],
        transitions: [],
        schema_version: 2,
        session_approved_categories: ["filesystem_write"],
        tool_calls: [],
      },
      brief: { frontmatter: { project: "legacy", scope_locked: false, authorized_costs: [] }, sections: { objective: "", deliverables: "", constraints: "", tools_required: "", notes: "", extra: {} }, raw: "" },
      messages: [],
    };
    writeFileSync(
      join(process.env.OPENWAR_HOME!, "sessions", `${briefId}.json`),
      JSON.stringify(payload),
    );
    const loaded = readSession(briefId);
    assert.ok(loaded);
    const meta = loaded!.meta as typeof loaded.meta & { coordinator_state?: string; active_roles?: string[] };
    assert.equal(meta.coordinator_state, "init");
    assert.deepEqual(meta.active_roles, []);
    // Existing v2 fields preserved.
    assert.deepEqual(meta.session_approved_categories, ["filesystem_write"]);
  } finally {
    cleanup(home);
  }
});

test("v3 session loads idempotently (no double-migration)", () => {
  const home = setupHome();
  try {
    const briefId = "2026-01-01-v3";
    const payload = {
      schema_version: 3,
      meta: {
        brief_id: briefId,
        project: "modern",
        started_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        phase: "execute",
        mode: "auto",
        destructive_approvals: [],
        transitions: [],
        schema_version: 3,
        session_approved_categories: [],
        tool_calls: [],
        coordinator_state: "review_step",
        plan: { subtasks: [{ id: "a", title: "A", instruction: "x", acceptance_criteria: ["c"], order: 0 }] },
        subtask_states: { a: { id: "a", status: "reviewing", attempts: 1 } },
        role_transcripts: { planner: [] },
        cost: { tokens_used: 100, wall_clock_ms: 5000, tool_calls: 2, tool_calls_by_subtask: { a: 2 }, started_at: "2026-01-01T00:00:00Z" },
        active_roles: ["planner", "executor", "reviewer"],
        budgets: { max_tokens: 80000, max_wall_clock_minutes: 25, max_tool_calls_per_subtask: 12, max_retries_per_subtask: 3 },
        coordinator_events: [],
      },
      brief: { frontmatter: { project: "modern", scope_locked: false, authorized_costs: [] }, sections: { objective: "", deliverables: "", constraints: "", tools_required: "", notes: "", extra: {} }, raw: "" },
      messages: [],
    };
    writeFileSync(
      join(process.env.OPENWAR_HOME!, "sessions", `${briefId}.json`),
      JSON.stringify(payload),
    );
    const loaded = readSession(briefId);
    assert.ok(loaded);
    const meta = loaded!.meta as typeof loaded.meta & { coordinator_state?: string; budgets?: { max_tokens: number } };
    assert.equal(meta.coordinator_state, "review_step");
    assert.equal(meta.budgets?.max_tokens, 80000);
  } finally {
    cleanup(home);
  }
});

test("session with schema_version newer than runtime throws", () => {
  const home = setupHome();
  try {
    const briefId = "2026-01-01-future";
    const payload = {
      schema_version: 99,
      meta: {
        brief_id: briefId, project: "x", started_at: "", updated_at: "", phase: "done",
        mode: null, destructive_approvals: [], transitions: [],
      },
      brief: { frontmatter: { project: "x", scope_locked: false, authorized_costs: [] }, sections: { objective: "", deliverables: "", constraints: "", tools_required: "", notes: "", extra: {} }, raw: "" },
      messages: [],
    };
    writeFileSync(
      join(process.env.OPENWAR_HOME!, "sessions", `${briefId}.json`),
      JSON.stringify(payload),
    );
    assert.throws(() => readSession(briefId), /newer than this runtime/);
  } finally {
    cleanup(home);
  }
});
