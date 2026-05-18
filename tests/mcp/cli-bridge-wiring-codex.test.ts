// v0.7.1: end-to-end test of the cli-bridge-wiring Codex path. Verifies
// that the runner writes a TOML config to ~/.codex/config.toml (overridden
// to a tmp HOME for tests), serializes via the TOML writer, and merges
// the [mcp_servers.openwar] section into pre-existing operator content
// without clobbering other sections.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = mkdtempSync(join(tmpdir(), "openwar-v071-home-"));
// homedir() respects HOME on POSIX and USERPROFILE on Windows. Set both so
// the test passes on every platform without per-OS branching.
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { setupCliBridgeMcpForwarding } = await import("../../src/mcp/cli-bridge-wiring.js");
const { parseBrief } = await import("../../src/brief.js");
const { CliBridgeAdapter } = await import("../../src/adapters/cli-bridge.js");

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function makeBrief(): ReturnType<typeof parseBrief> {
  return parseBrief(`---
project: codex-wiring-test
brief_id: 2026-05-18-CWT
scope_locked: true
authorized_costs:
  - filesystem_read
  - filesystem_write
  - shell_exec
cli:
  mcp_forward: true
---

# Objective
x

# Deliverables
- y
`);
}

function makeAdapter(): CliBridgeAdapter {
  return new CliBridgeAdapter({
    id: "cli-bridge",
    model: "codex",
    extra: { binary: "codex" },
  });
}

const NULL_IO = {
  banner: () => {},
  write: () => {},
  warn: () => {},
  error: () => {},
  prompt: async () => "",
  promptYesNo: async () => false,
};

test("wiring: Codex writes ~/.codex/config.toml in TOML format", async () => {
  const brief = makeBrief();
  const adapter = makeAdapter();
  const setup = await setupCliBridgeMcpForwarding({
    brief,
    adapter,
    io: NULL_IO,
    workdir: TMP_HOME,
    briefId: "2026-05-18-T1",
  });
  assert.ok(setup, "setup should return a CliBridgeMcpSetup when Codex is resolved");
  assert.match(setup!.configPath, /\.codex[\\/]config\.toml$/);
  assert.equal(setup!.cleanupConfigFile, false, "Codex config should persist across runs");
  assert.ok(existsSync(setup!.configPath));
  const written = readFileSync(setup!.configPath, "utf8");
  assert.match(written, /\[mcp_servers\.openwar\]/);
  assert.match(written, /command = "node"/);
  assert.match(written, /args = \[/);
});

test("wiring: Codex merge preserves an operator-edited [user] section", async () => {
  const brief = makeBrief();
  const adapter = makeAdapter();
  // Seed an existing config with operator content.
  const configPath = join(TMP_HOME, ".codex", "config.toml");
  // Ensure parent dir.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(TMP_HOME, ".codex"), { recursive: true });
  writeFileSync(configPath, `[user]
preferred_model = "gpt-5"

[history]
max_entries = 1000
`, "utf8");

  const setup = await setupCliBridgeMcpForwarding({
    brief,
    adapter,
    io: NULL_IO,
    workdir: TMP_HOME,
    briefId: "2026-05-18-T2",
  });
  assert.ok(setup);
  const written = readFileSync(setup!.configPath, "utf8");
  // Operator sections survive.
  assert.match(written, /\[user\]\npreferred_model = "gpt-5"/);
  assert.match(written, /\[history\]\nmax_entries = 1000/);
  // OpenWar section was appended.
  assert.match(written, /\[mcp_servers\.openwar\]/);
});

test("wiring: Codex merge replaces a stale [mcp_servers.openwar] block", async () => {
  const brief = makeBrief();
  const adapter = makeAdapter();
  const configPath = join(TMP_HOME, ".codex", "config.toml");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(TMP_HOME, ".codex"), { recursive: true });
  writeFileSync(configPath, `[user]
preferred_model = "gpt-5"

[mcp_servers.openwar]
command = "stale-command"
args = ["stale"]

[history]
max_entries = 500
`, "utf8");

  const setup = await setupCliBridgeMcpForwarding({
    brief,
    adapter,
    io: NULL_IO,
    workdir: TMP_HOME,
    briefId: "2026-05-18-T3",
  });
  assert.ok(setup);
  const written = readFileSync(setup!.configPath, "utf8");
  // Stale openwar block is gone, fresh one in place.
  assert.ok(!written.includes(`"stale-command"`), "stale command must be replaced");
  assert.ok(!written.includes(`"stale"`), "stale args must be replaced");
  assert.match(written, /\[mcp_servers\.openwar\]\ncommand = "node"/);
  // Surrounding operator sections survive.
  assert.match(written, /\[user\]\npreferred_model = "gpt-5"/);
  assert.match(written, /\[history\]\nmax_entries = 500/);
});

test("wiring: Codex setup respects cli.mcp_forward: false opt-out", async () => {
  const brief = parseBrief(`---
project: codex-optout
brief_id: 2026-05-18-COO
scope_locked: true
authorized_costs:
  - filesystem_read
  - shell_exec
cli:
  mcp_forward: false
---

# Objective
x

# Deliverables
- y
`);
  const adapter = makeAdapter();
  const setup = await setupCliBridgeMcpForwarding({
    brief,
    adapter,
    io: NULL_IO,
    workdir: TMP_HOME,
    briefId: "2026-05-18-T4",
  });
  assert.equal(setup, null, "opt-out should skip MCP forwarding entirely");
});
