// v1 -> v2 session migration test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "../src/state/persist.js";

async function freshDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "openwar-state-test-"));
}

test("readSession migrates a v1 file in place", async () => {
  const home = await freshDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const sessionsDir = join(home, ".openwar", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const v1 = {
    schema_version: 1,
    meta: {
      brief_id: "2026-05-15-v1test",
      project: "demo",
      started_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
      phase: "completion",
      mode: "auto",
      destructive_approvals: [],
      transitions: [],
    },
    brief: { frontmatter: { project: "demo", scope_locked: false, authorized_costs: [] }, sections: {}, raw: "" },
    messages: [],
  };
  await writeFile(join(sessionsDir, "2026-05-15-v1test.json"), JSON.stringify(v1));
  const loaded = readSession("2026-05-15-v1test");
  assert.ok(loaded);
  assert.equal(loaded!.meta.brief_id, "2026-05-15-v1test");
  assert.deepEqual(loaded!.meta.session_approved_categories, []);
  assert.deepEqual(loaded!.meta.tool_calls, []);
  // Bumped to 3 in v0.4 (additional coordinator-state fields appended on top
  // of the v2 shape). Migration is still idempotent for the v2 entries above.
  assert.equal(loaded!.meta.schema_version, 3);
  await rm(home, { recursive: true, force: true });
});

test("readSession rejects future schema versions", async () => {
  const home = await freshDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const sessionsDir = join(home, ".openwar", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const v99 = {
    schema_version: 99,
    meta: {
      brief_id: "2026-05-15-future",
      project: "demo",
      started_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
      phase: "intake",
      mode: null,
      destructive_approvals: [],
      transitions: [],
    },
    brief: { frontmatter: { project: "demo", scope_locked: false, authorized_costs: [] }, sections: {}, raw: "" },
    messages: [],
  };
  await writeFile(join(sessionsDir, "2026-05-15-future.json"), JSON.stringify(v99));
  assert.throws(() => readSession("2026-05-15-future"), /newer than this runtime/);
  await rm(home, { recursive: true, force: true });
});
