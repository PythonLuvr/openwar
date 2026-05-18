// v0.7.2: bridged-CLI settings module tests. Covers path resolution,
// the merge logic (preserve other keys, create when missing, halt on
// malformed JSON, atomic write), and idempotency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v072-claude-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const {
  claudeSettingsPath,
  mergeClaudeSettings,
  ClaudeSettingsMergeError,
  OPENWAR_MCP_TOOL_PATTERNS,
} = await import("../../src/mcp/bridged-cli-settings.js");

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test("OPENWAR_MCP_TOOL_PATTERNS lists all eight native tools as mcp__openwar__openwar_*", () => {
  assert.equal(OPENWAR_MCP_TOOL_PATTERNS.length, 8);
  for (const p of OPENWAR_MCP_TOOL_PATTERNS) {
    assert.match(p, /^mcp__openwar__openwar_/);
  }
});

test("claudeSettingsPath: resolves to ~/.claude/settings.json", () => {
  const p = claudeSettingsPath();
  assert.match(p, /\.claude[\\/]settings\.json$/);
  assert.ok(p.startsWith(TMP_HOME), `expected path under TMP_HOME, got ${p}`);
});

test("merge: creates the file when absent with the eight grants", async () => {
  const path = join(TMP_HOME, "case-create.json");
  const result = await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  assert.equal(result.createdNew, true);
  assert.equal(result.added.length, 8);
  assert.equal(result.alreadyPresent.length, 0);
  const written = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[] } };
  assert.deepEqual(written.permissions.allow.sort(), [...OPENWAR_MCP_TOOL_PATTERNS].sort());
});

test("merge: preserves unrelated top-level keys", async () => {
  const path = join(TMP_HOME, "case-toplevel.json");
  writeFileSync(path, JSON.stringify({
    apiKey: "totally-fake-key-do-not-touch",
    theme: "dark",
    permissions: { allow: ["Bash(npm run:*)"] },
  }), "utf8");
  await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(after.apiKey, "totally-fake-key-do-not-touch");
  assert.equal(after.theme, "dark");
});

test("merge: preserves unrelated permissions.allow entries (other servers' grants)", async () => {
  const path = join(TMP_HOME, "case-other-grants.json");
  writeFileSync(path, JSON.stringify({
    permissions: {
      allow: [
        "Bash(npm run:*)",
        "mcp__some-other-server__some_tool",
        "WebFetch(domain:github.com)",
      ],
    },
  }), "utf8");
  await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  const after = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[] } };
  assert.ok(after.permissions.allow.includes("Bash(npm run:*)"));
  assert.ok(after.permissions.allow.includes("mcp__some-other-server__some_tool"));
  assert.ok(after.permissions.allow.includes("WebFetch(domain:github.com)"));
  // And the openwar entries are present too.
  for (const p of OPENWAR_MCP_TOOL_PATTERNS) {
    assert.ok(after.permissions.allow.includes(p), `expected ${p} in allow list`);
  }
});

test("merge: idempotent on second call (no duplicates)", async () => {
  const path = join(TMP_HOME, "case-idempotent.json");
  await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  const second = await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  assert.equal(second.added.length, 0);
  assert.equal(second.alreadyPresent.length, 8);
  const after = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[] } };
  // No duplicates: count equals unique count.
  assert.equal(after.permissions.allow.length, new Set(after.permissions.allow).size);
});

test("merge: appends partial-overlap correctly", async () => {
  const path = join(TMP_HOME, "case-partial.json");
  // Pre-seed with three of the eight openwar patterns plus an unrelated.
  writeFileSync(path, JSON.stringify({
    permissions: {
      allow: [
        "Bash(echo:*)",
        "mcp__openwar__openwar_read_file",
        "mcp__openwar__openwar_write_file",
        "mcp__openwar__openwar_list_dir",
      ],
    },
  }), "utf8");
  const result = await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  assert.equal(result.added.length, 5);
  assert.equal(result.alreadyPresent.length, 3);
  const after = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[] } };
  // All eight openwar patterns + the unrelated entry = 9 distinct.
  assert.equal(after.permissions.allow.length, 9);
  assert.ok(after.permissions.allow.includes("Bash(echo:*)"));
});

test("merge: malformed JSON throws ClaudeSettingsMergeError with PARSE code", async () => {
  const path = join(TMP_HOME, "case-malformed.json");
  writeFileSync(path, `{ this is not json`, "utf8");
  await assert.rejects(
    () => mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeSettingsMergeError);
      assert.equal((err as InstanceType<typeof ClaudeSettingsMergeError>).code, "PARSE");
      assert.match((err as Error).message, /malformed JSON/);
      return true;
    },
  );
  // File untouched.
  assert.equal(readFileSync(path, "utf8"), `{ this is not json`);
});

test("merge: root-is-array throws PARSE rather than clobbering", async () => {
  const path = join(TMP_HOME, "case-array-root.json");
  writeFileSync(path, JSON.stringify(["not", "an", "object"]), "utf8");
  await assert.rejects(
    () => mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS),
    (err: unknown) => err instanceof ClaudeSettingsMergeError && (err as InstanceType<typeof ClaudeSettingsMergeError>).code === "PARSE",
  );
});

test("merge: existing permissions.allow as non-array gets replaced cleanly (treat as missing)", async () => {
  const path = join(TMP_HOME, "case-perm-non-array.json");
  // Operator (somehow) has `allow: null` or a malformed type. We treat it as
  // missing and write a fresh array. The other keys still survive.
  writeFileSync(path, JSON.stringify({
    theme: "dark",
    permissions: { allow: null, deny: ["something"] },
  }), "utf8");
  await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  const after = JSON.parse(readFileSync(path, "utf8")) as { theme: string; permissions: { allow: string[]; deny: string[] } };
  assert.equal(after.theme, "dark");
  assert.deepEqual(after.permissions.deny, ["something"]);
  assert.equal(after.permissions.allow.length, 8);
});

test("merge: empty patternsToAdd is a no-op (returns sane result)", async () => {
  const path = join(TMP_HOME, "case-empty-input.json");
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(x)"] } }), "utf8");
  const result = await mergeClaudeSettings(path, []);
  assert.equal(result.added.length, 0);
  assert.equal(result.alreadyPresent.length, 0);
  const after = JSON.parse(readFileSync(path, "utf8")) as { permissions: { allow: string[] } };
  assert.deepEqual(after.permissions.allow, ["Bash(x)"]);
});

test("merge: creates parent directory if absent", async () => {
  const path = join(TMP_HOME, "nested", "dir", "settings.json");
  assert.ok(!existsSync(path));
  const result = await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  assert.equal(result.createdNew, true);
  assert.ok(existsSync(path));
});

test("merge: writes valid JSON with trailing newline", async () => {
  const path = join(TMP_HOME, "case-format.json");
  await mergeClaudeSettings(path, OPENWAR_MCP_TOOL_PATTERNS);
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  // Round-trips through JSON.parse without error.
  assert.doesNotThrow(() => JSON.parse(raw));
});

// Smoke for the wiring banner/halt is in cli-bridge-wiring-permission-setup.test.ts
// (separate file) to keep this module focused on settings I/O.
void mkdirSync; // silence unused-import warning across test runs