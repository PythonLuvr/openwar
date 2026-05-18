// v0.9.1 learned-profile schema. Round-trip, schema_version check, atomic
// write, delete, sensitivity-map projection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OW_HOME = mkdtempSync(join(tmpdir(), "openwar-v091-prof-"));
process.env.OPENWAR_HOME = OW_HOME;

const {
  LEARNED_PROFILE_SCHEMA_VERSION,
  LearnedProfileSchemaError,
  learnedProfilePath,
  loadLearnedProfile,
  saveLearnedProfile,
  deleteLearnedProfile,
  buildLearnedProfile,
  sensitivityMapFromProfile,
  profileExists,
} = await import("../../src/state/learned-profile.js");

test.after(() => {
  rmSync(OW_HOME, { recursive: true, force: true });
  delete process.env.OPENWAR_HOME;
});

test("schema version constant is 1 for v0.9.1", () => {
  assert.equal(LEARNED_PROFILE_SCHEMA_VERSION, 1);
});

test("learnedProfilePath: sits under <OPENWAR_HOME>/projects/<slug>/learned.json", () => {
  const p = learnedProfilePath("demo-project");
  assert.match(p, /[\\/]projects[\\/]demo-project[\\/]learned\.json$/);
  assert.ok(p.startsWith(OW_HOME));
});

test("save then load round-trips and includes all required fields", () => {
  const profile = buildLearnedProfile({
    slug: "round-trip",
    source_runs: ["b", "a", "c"],
    detectors: [
      { detector: "blocker", sensitivity: "loose", reason: "high fire rate", fire_rate: 0.91, sample_size: 12 },
    ],
    phase_budgets: [
      { phase: "execute", tool_calls: 18, observed_p50: 8, observed_p90: 13, sample_size: 12 },
    ],
    tools: [{ tool: "read_file", calls: 50, last_used: "2026-05-18T00:00:00Z", dead: false }],
    notes: ["test profile"],
    generated_at: "2026-05-18T00:00:00Z",
  });
  // source_runs sorted by builder (determinism guarantee).
  assert.deepEqual(profile.source_runs, ["a", "b", "c"]);
  saveLearnedProfile(profile);
  const back = loadLearnedProfile("round-trip");
  assert.deepEqual(back, profile);
});

test("schema_version mismatch raises a typed error, not a silent default", () => {
  const path = learnedProfilePath("v999");
  const p = buildLearnedProfile({ slug: "v999", source_runs: [], detectors: [], phase_budgets: [], tools: [], notes: [] });
  saveLearnedProfile(p);
  writeFileSync(path, JSON.stringify({ ...p, schema_version: 999 }), "utf8");
  assert.throws(
    () => loadLearnedProfile("v999"),
    (err: unknown) => {
      assert.ok(err instanceof LearnedProfileSchemaError);
      assert.equal((err as InstanceType<typeof LearnedProfileSchemaError>).code, "VERSION_MISMATCH");
      return true;
    },
  );
});

test("missing schema_version field raises MISSING_VERSION", () => {
  const p = buildLearnedProfile({ slug: "noversion", source_runs: [], detectors: [], phase_budgets: [], tools: [], notes: [] });
  saveLearnedProfile(p);
  const path = learnedProfilePath("noversion");
  const obj = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  delete obj.schema_version;
  writeFileSync(path, JSON.stringify(obj), "utf8");
  assert.throws(
    () => loadLearnedProfile("noversion"),
    (err: unknown) => err instanceof LearnedProfileSchemaError && (err as InstanceType<typeof LearnedProfileSchemaError>).code === "MISSING_VERSION",
  );
});

test("malformed JSON raises PARSE error", () => {
  const p = buildLearnedProfile({ slug: "malformed", source_runs: [], detectors: [], phase_budgets: [], tools: [], notes: [] });
  saveLearnedProfile(p);
  writeFileSync(learnedProfilePath("malformed"), "{ not json", "utf8");
  assert.throws(
    () => loadLearnedProfile("malformed"),
    (err: unknown) => err instanceof LearnedProfileSchemaError && (err as InstanceType<typeof LearnedProfileSchemaError>).code === "PARSE",
  );
});

test("root-is-array raises SHAPE error rather than clobbering", () => {
  const p = buildLearnedProfile({ slug: "rootarray", source_runs: [], detectors: [], phase_budgets: [], tools: [], notes: [] });
  saveLearnedProfile(p);
  writeFileSync(learnedProfilePath("rootarray"), "[]", "utf8");
  assert.throws(
    () => loadLearnedProfile("rootarray"),
    (err: unknown) => err instanceof LearnedProfileSchemaError && (err as InstanceType<typeof LearnedProfileSchemaError>).code === "SHAPE",
  );
});

test("loadLearnedProfile returns null when file doesn't exist", () => {
  assert.equal(loadLearnedProfile("never-existed"), null);
  assert.equal(profileExists("never-existed"), false);
});

test("deleteLearnedProfile removes the file and returns true; second call returns false", () => {
  const p = buildLearnedProfile({ slug: "todelete", source_runs: [], detectors: [], phase_budgets: [], tools: [], notes: [] });
  saveLearnedProfile(p);
  assert.equal(existsSync(learnedProfilePath("todelete")), true);
  assert.equal(deleteLearnedProfile("todelete"), true);
  assert.equal(existsSync(learnedProfilePath("todelete")), false);
  assert.equal(deleteLearnedProfile("todelete"), false);
});

test("sensitivityMapFromProfile: projects detector_overrides into a flat map", () => {
  const p = buildLearnedProfile({
    slug: "map",
    source_runs: [],
    detectors: [
      { detector: "blocker", sensitivity: "loose", reason: "x", fire_rate: 0.9, sample_size: 10 },
      { detector: "completion", sensitivity: "default", reason: "y", fire_rate: 0.1, sample_size: 10 },
    ],
    phase_budgets: [],
    tools: [],
    notes: [],
  });
  const map = sensitivityMapFromProfile(p);
  assert.equal(map.blocker, "loose");
  assert.equal(map.completion, "default");
  assert.equal(Object.keys(map).length, 2);
});

test("save is deterministic: same profile produces byte-identical file output", () => {
  const p = buildLearnedProfile({
    slug: "determ",
    source_runs: ["c", "a", "b"],
    detectors: [
      { detector: "blocker", sensitivity: "loose", reason: "x", fire_rate: 0.9, sample_size: 10 },
    ],
    phase_budgets: [],
    tools: [],
    notes: ["one"],
    generated_at: "2026-05-18T00:00:00Z",
  });
  saveLearnedProfile(p);
  const a = readFileSync(learnedProfilePath("determ"), "utf8");
  saveLearnedProfile(p);
  const b = readFileSync(learnedProfilePath("determ"), "utf8");
  assert.equal(a, b);
});
