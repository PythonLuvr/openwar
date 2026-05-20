// v0.12.0: openwar inspect --permissions formatter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPermissions } from "../../src/cli/inspect.js";
import type { TraceEvent } from "../../src/state/trace.js";

function reqEvent(grant_id: string, action: string, category: string | null = null, scope: "this_call" | "this_session" | "persistent" = "this_call"): TraceEvent {
  return {
    type: "permission_requested",
    grant_id,
    action,
    category,
    scope_requested: scope,
    reasoning: "r",
    fallback: null,
    at: "2026-05-19T00:00:00Z",
  };
}

test("formatPermissions: empty trace returns helpful placeholder", () => {
  const out = formatPermissions([]);
  assert.match(out, /no permission events in this trace/);
});

test("formatPermissions: request -> grant flows through to status=granted", () => {
  const events: TraceEvent[] = [
    reqEvent("g1", "Delete a thing"),
    { type: "permission_granted", grant_id: "g1", scope_granted: "this_call", operator_note: "", at: "2026-05-19T00:00:01Z" },
  ];
  const out = formatPermissions(events);
  assert.match(out, /g1/);
  assert.match(out, /granted/);
  assert.match(out, /Delete a thing/);
});

test("formatPermissions: request -> deny -> status=denied with action preserved", () => {
  const events: TraceEvent[] = [
    reqEvent("g2", "Run rm -rf /"),
    { type: "permission_denied", grant_id: "g2", operator_note: "nope", at: "2026-05-19T00:00:02Z" },
  ];
  const out = formatPermissions(events);
  assert.match(out, /denied/);
  assert.match(out, /Run rm -rf/);
});

test("formatPermissions: request -> grant -> consume -> status=consumed", () => {
  const events: TraceEvent[] = [
    reqEvent("g3", "Patch one file"),
    { type: "permission_granted", grant_id: "g3", scope_granted: "this_call", operator_note: "", at: "t1" },
    { type: "permission_grant_consumed", grant_id: "g3", consuming_tool_call_id: "call-1", at: "t2" },
  ];
  const out = formatPermissions(events);
  assert.match(out, /consumed/);
});

test("formatPermissions: request -> grant -> revoke -> status=revoked", () => {
  const events: TraceEvent[] = [
    reqEvent("g4", "Persistent file writes"),
    { type: "permission_granted", grant_id: "g4", scope_granted: "persistent", operator_note: "", at: "t1" },
    { type: "permission_revoked", grant_id: "g4", revoked_at: "t2" },
  ];
  const out = formatPermissions(events);
  assert.match(out, /revoked/);
});

test("formatPermissions: orphan grant (granted with no preceding request) still shown", () => {
  const events: TraceEvent[] = [
    { type: "permission_granted", grant_id: "g5", scope_granted: "this_session", operator_note: "", at: "t1" },
  ];
  const out = formatPermissions(events);
  assert.match(out, /granted/);
  assert.match(out, /no preceding request event/);
});

test("formatPermissions: includes column headers for grant_id / status / scope / category / action / at", () => {
  const events: TraceEvent[] = [reqEvent("g6", "x"), { type: "permission_granted", grant_id: "g6", scope_granted: "this_call", operator_note: "", at: "t1" }];
  const out = formatPermissions(events);
  assert.match(out, /grant_id/);
  assert.match(out, /status/);
  assert.match(out, /scope/);
  assert.match(out, /category/);
  assert.match(out, /action/);
  assert.match(out, /\bat\b/);
});
