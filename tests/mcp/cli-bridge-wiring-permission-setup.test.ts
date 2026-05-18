// v0.7.2: end-to-end wiring tests for the Claude Code permission auto-setup.
// Verifies the banner fires, the opt-out short-circuits, and the merge
// failure surfaces as CliBridgePermissionSetupError (which the runner
// translates into a Phase 2 halt).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v072-wiring-"));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { setupCliBridgeMcpForwarding, CliBridgePermissionSetupError } =
  await import("../../src/mcp/cli-bridge-wiring.js");
const { parseBrief } = await import("../../src/brief.js");
const { CliBridgeAdapter } = await import("../../src/adapters/cli-bridge.js");
const { claudeSettingsPath } = await import("../../src/mcp/bridged-cli-settings.js");

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function brief(skip?: boolean): ReturnType<typeof parseBrief> {
  const skipLine = skip === undefined ? "" : `  skip_permission_setup: ${skip}`;
  return parseBrief(`---
project: claude-perm-test
brief_id: 2026-05-18-CPT
scope_locked: true
authorized_costs:
  - filesystem_read
  - filesystem_write
  - shell_exec
cli:
  mcp_forward: true
${skipLine}
---

# Objective
x

# Deliverables
- y
`);
}

function claudeAdapter(): InstanceType<typeof CliBridgeAdapter> {
  return new CliBridgeAdapter({
    id: "cli-bridge",
    model: "claude",
    extra: { binary: "claude" },
  });
}

interface CapturingIO {
  banner: (s: string) => void;
  write: (s: string) => void;
  warn: (s: string) => void;
  error: (s: string) => void;
  prompt: () => Promise<string>;
  promptYesNo: () => Promise<boolean>;
  banners: string[];
}

function makeIo(): CapturingIO {
  const banners: string[] = [];
  return {
    banners,
    banner: (s: string) => banners.push(s),
    write: () => {},
    warn: () => {},
    error: () => {},
    prompt: async () => "",
    promptYesNo: async () => false,
  };
}

test("permission setup: banner fires with the expected text when merge succeeds", async () => {
  const io = makeIo();
  const setup = await setupCliBridgeMcpForwarding({
    brief: brief(),
    adapter: claudeAdapter(),
    io,
    workdir: TMP_HOME,
    briefId: "2026-05-18-W1",
  });
  assert.ok(setup, "expected MCP setup to return successfully");
  const banner = io.banners.find((b) => b.includes("Pre-authorized openwar MCP tools"));
  assert.ok(banner, `expected pre-auth banner, got: ${JSON.stringify(io.banners)}`);
  assert.match(banner!, /Claude Code settings at/);
  assert.match(banner!, /Existing operator settings preserved/);
});

test("permission setup: cli.skip_permission_setup: true short-circuits the merge", async () => {
  const io = makeIo();
  // Pre-create with a known content; verify it's not touched.
  const settingsPath = claudeSettingsPath();
  mkdirSync(join(TMP_HOME, ".claude"), { recursive: true });
  const knownContent = `{"theme":"dark","permissions":{"allow":["Bash(echo x)"]}}\n`;
  writeFileSync(settingsPath, knownContent, "utf8");
  await setupCliBridgeMcpForwarding({
    brief: brief(true),
    adapter: claudeAdapter(),
    io,
    workdir: TMP_HOME,
    briefId: "2026-05-18-W2",
  });
  // Settings untouched.
  assert.equal(readFileSync(settingsPath, "utf8"), knownContent);
  // No pre-auth banner fired.
  const banner = io.banners.find((b) => b.includes("Pre-authorized openwar MCP tools"));
  assert.equal(banner, undefined);
});

test("permission setup: malformed settings throws CliBridgePermissionSetupError (PARSE)", async () => {
  const io = makeIo();
  const settingsPath = claudeSettingsPath();
  mkdirSync(join(TMP_HOME, ".claude"), { recursive: true });
  writeFileSync(settingsPath, `{ not json`, "utf8");
  await assert.rejects(
    () => setupCliBridgeMcpForwarding({
      brief: brief(),
      adapter: claudeAdapter(),
      io,
      workdir: TMP_HOME,
      briefId: "2026-05-18-W3",
    }),
    (err: unknown) => {
      assert.ok(err instanceof CliBridgePermissionSetupError);
      assert.equal((err as InstanceType<typeof CliBridgePermissionSetupError>).code, "PARSE");
      return true;
    },
  );
  // File untouched after refusal.
  assert.equal(readFileSync(settingsPath, "utf8"), `{ not json`);
});

test("permission setup: non-Claude-Code bridged CLI skips the merge entirely (Gemini)", async () => {
  const io = makeIo();
  // Clean up the settings file from a previous test so we can prove this
  // test's adapter (gemini) does not touch it.
  rmSync(join(TMP_HOME, ".claude"), { recursive: true, force: true });
  const gemini = new CliBridgeAdapter({
    id: "cli-bridge",
    model: "gemini",
    extra: { binary: "gemini" },
  });
  await setupCliBridgeMcpForwarding({
    brief: brief(),
    adapter: gemini,
    io,
    workdir: TMP_HOME,
    briefId: "2026-05-18-W4",
  });
  const banner = io.banners.find((b) => b.includes("Pre-authorized openwar MCP tools"));
  assert.equal(banner, undefined, "Gemini should not trigger Claude Code permission setup");
});
