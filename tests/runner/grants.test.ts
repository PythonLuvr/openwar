// v0.12.0: GrantLedger semantics + persistent JSONL round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrantLedger } from "../../src/runtime/grants.js";
import { permissionGrantsFile } from "../../src/state/paths.js";

async function withFreshHome<T>(fn: (slug: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "openwar-grants-test-"));
  const oldHome = process.env.OPENWAR_HOME;
  process.env.OPENWAR_HOME = dir;
  try {
    return await fn("grants-test-slug");
  } finally {
    if (oldHome === undefined) delete process.env.OPENWAR_HOME;
    else process.env.OPENWAR_HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- addGrant / consumeGrant / revokeGrant / listActive ----

test("addGrant: returns Grant with grant_id, consumed=false", () => {
  const l = new GrantLedger();
  const g = l.addGrant({ action: "x", category: null, scope: "this_call", reasoning: "y" });
  assert.equal(typeof g.grant_id, "string");
  assert.equal(g.consumed, false);
  assert.equal(g.scope, "this_call");
});

test("addGrant persistent + no project_slug -> degrades to this_session", () => {
  const l = new GrantLedger();
  const g = l.addGrant({ action: "x", category: null, scope: "persistent", reasoning: "y" });
  assert.equal(g.scope, "this_session");
});

test("consumeGrant flips this_call grants to consumed; this_session stays unconsumed", () => {
  const l = new GrantLedger();
  const tc = l.addGrant({ action: "a", category: null, scope: "this_call", reasoning: "r" });
  const ts = l.addGrant({ action: "b", category: null, scope: "this_session", reasoning: "r" });
  l.consumeGrant(tc.grant_id);
  l.consumeGrant(ts.grant_id);
  const active = l.listActive();
  const tcSeen = active.find((g) => g.grant_id === tc.grant_id);
  const tsSeen = active.find((g) => g.grant_id === ts.grant_id);
  assert.equal(tcSeen?.consumed, true);
  assert.equal(tsSeen?.consumed, false);
});

test("revokeGrant returns true once; false on second call; removes grant from listActive", () => {
  const l = new GrantLedger();
  const g = l.addGrant({ action: "x", category: null, scope: "this_session", reasoning: "y" });
  assert.equal(l.revokeGrant(g.grant_id), true);
  assert.equal(l.revokeGrant(g.grant_id), false);
  assert.equal(l.listActive().some((x) => x.grant_id === g.grant_id), false);
});

test("revokeGrant unknown id -> false", () => {
  const l = new GrantLedger();
  assert.equal(l.revokeGrant("does-not-exist"), false);
});

// ---- findMatchingGrant: category + scope rules ----

test("findMatchingGrant: this_call with matching category wins over this_session", () => {
  const l = new GrantLedger();
  const sess = l.addGrant({ action: "a", category: "filesystem_write", scope: "this_session", reasoning: "r" });
  const oneShot = l.addGrant({ action: "b", category: "filesystem_write", scope: "this_call", reasoning: "r" });
  const match = l.findMatchingGrant(["filesystem_write"]);
  assert.equal(match?.grant_id, oneShot.grant_id);
  void sess;
});

test("findMatchingGrant: skips revoked + consumed this_call grants", () => {
  const l = new GrantLedger();
  const a = l.addGrant({ action: "a", category: "x", scope: "this_call", reasoning: "r" });
  const b = l.addGrant({ action: "b", category: "x", scope: "this_call", reasoning: "r" });
  l.consumeGrant(a.grant_id);
  l.revokeGrant(b.grant_id);
  assert.equal(l.findMatchingGrant(["x"]), null);
});

test("findMatchingGrant: no category on grant -> matches any Phase 3 call", () => {
  const l = new GrantLedger();
  l.addGrant({ action: "broad approval", category: null, scope: "this_session", reasoning: "r" });
  const match = l.findMatchingGrant(["any_random_category"]);
  assert.ok(match);
  assert.equal(match!.category, null);
});

test("findMatchingGrant: category mismatch -> no match", () => {
  const l = new GrantLedger();
  l.addGrant({ action: "a", category: "filesystem_write", scope: "this_session", reasoning: "r" });
  assert.equal(l.findMatchingGrant(["shell_exec"]), null);
});

test("findMatchingGrant: this_call without category matches the next call regardless", () => {
  const l = new GrantLedger();
  l.addGrant({ action: "next", category: null, scope: "this_call", reasoning: "r" });
  const match = l.findMatchingGrant(["whatever"]);
  assert.ok(match);
  assert.equal(match!.scope, "this_call");
});

// ---- Persistent grant round-trip via project_slug ----

test("persistent grant: writes JSONL and is rehydrated by a fresh ledger for the same slug", async () => {
  await withFreshHome(async (slug) => {
    const l1 = new GrantLedger({ project_slug: slug });
    const g = l1.addGrant({
      action: "ship release notes",
      category: "filesystem_write",
      scope: "persistent",
      reasoning: "weekly release flow",
    });
    assert.equal(g.scope, "persistent");
    // New ledger for the same slug should see the grant.
    const l2 = new GrantLedger({ project_slug: slug });
    const active = l2.listActive();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.grant_id, g.grant_id);
    assert.equal(active[0]!.scope, "persistent");
  });
});

test("persistent grant revoke: append-only file plus second-session sees it gone", async () => {
  await withFreshHome(async (slug) => {
    const l1 = new GrantLedger({ project_slug: slug });
    const g = l1.addGrant({ action: "x", category: null, scope: "persistent", reasoning: "y" });
    l1.revokeGrant(g.grant_id);
    const l2 = new GrantLedger({ project_slug: slug });
    assert.equal(l2.listActive().length, 0);
  });
});

test("persistent ledger: corrupt line is skipped, rest of grants survive", async () => {
  await withFreshHome(async (slug) => {
    const l = new GrantLedger({ project_slug: slug });
    l.addGrant({ action: "a", category: null, scope: "persistent", reasoning: "r" });
    // Hand-append a corrupt line.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(permissionGrantsFile(slug), "this is not json\n", "utf8");
    const l2 = new GrantLedger({ project_slug: slug });
    assert.equal(l2.listActive().length, 1);
  });
});

test("persistent write failure: ledger warns once and keeps in-memory grant", async () => {
  await withFreshHome(async (slug) => {
    // Point the persistence path at an unwritable target by stubbing
    // OPENWAR_HOME at a child path we then take read-only. Easier: just
    // verify the warn callback fires exactly once when we force a write
    // path that can't be created. We do that by setting the slug to a
    // string with path separators which sanitizes weirdly but the dir
    // creation might still succeed; instead set OPENWAR_HOME to a file
    // path so dirname creation fails.
    const oldHome = process.env.OPENWAR_HOME;
    const dir = await mkdtemp(join(tmpdir(), "openwar-grants-bad-"));
    process.env.OPENWAR_HOME = join(dir, "not-a-dir");
    // Create a file at the OPENWAR_HOME path so mkdirSync recursive fails.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.OPENWAR_HOME!, "x", "utf8");
    let warns = 0;
    try {
      const l = new GrantLedger({ project_slug: slug, warn: () => { warns++; } });
      const g = l.addGrant({ action: "x", category: null, scope: "persistent", reasoning: "y" });
      assert.equal(g.scope, "persistent"); // in-memory survives
      l.addGrant({ action: "y", category: null, scope: "persistent", reasoning: "z" });
      assert.equal(warns, 1, "warn should fire exactly once across multiple failed writes");
    } finally {
      if (oldHome === undefined) delete process.env.OPENWAR_HOME;
      else process.env.OPENWAR_HOME = oldHome;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
