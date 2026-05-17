# Changelog

## 0.6.1

Windows-only bug fix for cli-bridge. v0.5 and v0.6 hardcoded `shell: false` in the `child_process.spawn` call. Node's documentation calls out that `.cmd` and `.bat` files cannot be spawned without a shell on Windows, so every operator trying to bridge to an npm-installed CLI (Claude Code, Gemini CLI, aider, etc) hit `spawn <binary> ENOENT` even when the file existed on PATH. POSIX runs were unaffected because Unix binaries spawn fine without a shell.

### Fixed

- **`src/adapters/cli-bridge.ts`**: spawn now passes `shell: true` only when running on Windows AND the binary ends in `.cmd` or `.bat`. POSIX runs keep `shell: false` unchanged. Windows runs against a non-shim binary (e.g. `node.exe`) also keep `shell: false`, which matters because unconditionally enabling shell on Windows re-parses argv through `cmd.exe` and mangles any binary path containing a space (the `C:\Program Files\nodejs\node.exe` case). The narrower predicate fixes the original `.cmd` ENOENT bug without introducing a second class of quoting regressions.

### Added

- **`tests/adapters/cli-bridge-windows-cmd.test.ts`**: regression test that spawns a `.cmd` script via the adapter and asserts no spawn error. Skips cleanly on non-Windows so the test matrix on Ubuntu and macOS stays green.
- **`tests/fixtures/mock-cli/hello.cmd`**: minimal `.cmd` shim used by the regression test. Echoes a known string and exits 0.

### Known follow-ups (not in 0.6.1)

- **Native tool visibility through cli-bridge.** When the bridged CLI delegates execution, the CLI does not see OpenWar's native tools (`read_project_memory`, `write_project_memory`, the six filesystem/shell/http tools, MCP tools). This is by design per the v0.5 explicit non-goal ("No native tool-call translation"), but a brief that asks the bridged agent to use a native tool currently hits a Phase 2 blocker without context. Two paths under consideration:
  - Brief-validator warning when an adapter is cli-bridge AND the brief body references native tool names.
  - MCP-server-mode (already in the v0.5.2+ roadmap): OpenWar exposes its native tools via an MCP server and the bridged CLI calls them back through MCP. Real engineering, not a patch.
  
  Both deferred from 0.6.1; surfaced here so the architectural decision is on the record.

## 0.6.0

Persistent project memory. v0.5.x runs were stateless: every brief started from a cold slate and the operator had to manually paste prior context, decisions, and conventions into each new brief. v0.6 introduces a per-project memory store that agents can read and write across briefs, plus a `openwar memory` subcommand for the operator to inspect and prune outside a session.

This is intentionally minimum scaffolding. No retrieval scoring, no summarization decay, no automatic conflict resolution, no cross-project memory, no semantic search. The feature ships the persistence primitive and the read/write surface; v0.6.x can layer retrieval on top if real usage demands it. The framework's identity (discipline over intelligence) drives the scope: memory is for *the operator's project work product*, not a knowledge-base product wrapped in agent clothing.

### Added

- **`~/.openwar/projects/<project-slug>/` as a per-project persistence root** sibling to `sessions/`. Holds three JSONL category files (`decisions.jsonl`, `knowledge.jsonl`, `constraints.jsonl`), append-only, atomic writes through a tmp-stage. Corrupted-line recovery on read: bad rows are skipped, the 1-based line index is reported alongside the valid entries, the read keeps going.
- **Memory persistence module** at `src/state/memory.ts`. `appendMemoryEntry()`, `readMemory()`, `removeMemoryEntry()`, `renderMemoryForPrompt()`. Three typed entry shapes:
  - `decisions { summary, rationale, superseded_by? }` (why-we-chose-X records)
  - `knowledge { content }` (longer-form notes)
  - `constraints { rule, rationale? }` (persistent rules)
  - All entries also carry `id`, `at`, optional `brief_id`, and optional `metadata`.
- **Two native tools** under the existing `filesystem_read` / `filesystem_write` categories (no new top-level auth categories added):
  - `read_project_memory(category, query?, limit?)` returns matching entries. Default-allowed via `filesystem_read`. Query is a case-insensitive substring filter against the entry's primary text.
  - `write_project_memory(category, entry)` appends an entry. Phase 3 prompts unless `filesystem_write` is in the brief's `authorized_costs`.
- **Brief frontmatter `inherit_memory: true|false`** (default false). When true, the runtime renders a structured per-category summary of the project's memory and injects it into the system prompt at session start. Cap is 20 entries per category in reverse-chronological order. v0.6.x can revisit the cap and add retrieval scoring.
- **Role-scoped memory visibility for multi-agent runs.** Planner, reviewer, and critic see all three categories (full project context for planning, evaluation, and re-review). Executor sees `knowledge` + `constraints` only and does not see `decisions`, so prior-decision bias doesn't seep into per-sub-task execution. Reviewer can still raise prior-decision concerns because reviewer has the full view. Custom roles default to the full view.
- **`openwar memory` subcommand** for out-of-session inspection and pruning:
  - `openwar memory list <project> [--category decisions|knowledge|constraints]`
  - `openwar memory show <project> <entry_id>`
  - `openwar memory remove <project> <entry_id>`
- **`SandboxContext` gains optional `project_slug` and `brief_id` fields** so the memory tools can resolve scope from the execution context without re-reading the brief. The runner populates both at session start.
- **Tests**: `tests/state/memory.test.ts` (11 cases covering append, read, query, corrupted-line skip, remove, render), `tests/tools/memory-tools.test.ts` (9 cases covering tool registration, auth categories, executor scope rejection, end-to-end read/write), `tests/roles/memory-visibility.test.ts` (7 cases covering per-role category lists and executor-view omission of decisions), `tests/brief-inherit-memory.test.ts` (3 cases covering frontmatter parsing).

### Explicit non-goals (still)

- No retrieval scoring or semantic search. Cap + reverse-chronological is the v0.6 read story.
- No automatic conflict resolution. Two contradictory entries are both visible; the agent surfaces the conflict in Phase 0 as an unknown for the operator to resolve.
- No cross-project memory. Project is the persistence boundary.
- No memory for the framework or runtime configuration. Those stay file-based and version-controlled.
- No new authorization top-level categories. Memory reuses `filesystem_read` / `filesystem_write`.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. Memory persistence is pure Node stdlib (`fs/promises`, JSONL on disk, tmp+rename for atomicity).
- No state schema bump. `SessionMeta` is unchanged. `~/.openwar/projects/` is a parallel persistence root, not an extension of the session schema.
- Backwards-compatible. Existing briefs without `inherit_memory` continue to behave identically. Existing sessions resume cleanly under v0.6.
- War Room can consume `appendMemoryEntry`, `readMemory`, `removeMemoryEntry`, and `renderMemoryForPrompt` directly from `@pythonluvr/openwar` once published. The memory surface is exported through the package root.
- `OPENWAR_HOME` env var still scopes both `sessions/` and `projects/`, useful for tests and integrators.

## 0.5.1

Per-role adapter mixing. v0.4 introduced the planner / executor / reviewer / critic coordinator, but every role had to share the same adapter. v0.5.1 lets a brief pin each role to its own adapter (and optional model + extras), so a single run can keep planning and review on a cheap API while delegating execution to a local CLI agent. The coordinator threads the right adapter per role; the phase machine and detectors run uniformly against every role's output.

### Added

- **Brief frontmatter**: `roles:` now accepts a nested map in addition to the v0.4 flat list. Map keys become the roles list (in declaration order); values are `RoleAdapterConfig` objects with `adapter`, optional `model`, and any extra fields the adapter understands (e.g. `binary` and `tier` for cli-bridge). A sibling `role_adapters:` block is also accepted for callers that prefer to keep the flat list shape and layer adapter overrides separately. Briefs that ship the v0.4 flat list keep working unchanged; the runner falls back to the runtime's default adapter for every role.
- **`RoleAdapterConfig` type** in `src/types.ts`. `BriefFrontmatter` gains an optional `role_adapters?: Record<string, RoleAdapterConfig>` field populated by the parser.
- **YAML parser**: `parseFrontmatter` in `src/brief.ts` now handles two-level nested maps (previously capped at one level). Triple nesting stays out of scope; the parser is still hand-rolled and dependency-free.
- **Validator** (`validateBrief`): every `role_adapters` entry is checked against the declared roles and the known adapter id set. Roles pinned to cli-bridge surface a clear error when the brief is missing `shell_exec` in `authorized_costs`, lifting the v0.5 runtime gate up to the validator so the failure shows in `openwar validate` instead of mid-run.
- **Coordinator** (`runCoordinator`): the `RunCoordinatorOptions` surface gains `getAdapter: (roleId: RoleId) => AgentAdapter`. The driver resolves the executor's adapter, the planner's adapter, the reviewer's adapter, and (when enabled) the critic's adapter independently. Lazy resolution: cli-bridge instances don't spawn until the role that uses them fires, so roles the run never reaches stay un-spawned. The legacy single-`adapter` field is still accepted for back-compat and the tests that use it pass unchanged.
- **Runner** (`src/runner.ts`): `buildRoleAdapterMap` constructs adapters from the brief's `role_adapters` map at run start; the cost-tier preview now lists each role's adapter and tier separately when overrides are present. Persists `role_adapter_ids` into `SessionMeta` so `inspect` and resume can rebuild the per-role adapter shape without re-reading the brief.
- **Example**: `examples/per-role-adapters-brief.md` demonstrates the canonical mix (planner + reviewer on a cheap API, executor on cli-bridge).
- **Tests**: new cases in `tests/brief.test.ts` covering the nested-map parser, the back-compat flat-list parser, and the validator's role-adapter checks. New cases in `tests/coordinator/per-role-adapters.test.ts` exercising the coordinator with two distinct mock adapters and asserting that each role's calls hit the right adapter.

### Changed

- `openwar.md` framework doc gains a "Per-role adapter mixing (v0.5.1+)" section under the multi-agent block. The v0.5 cli-bridge section's "Per-role adapter mixing" forward note is updated to describe the shipped syntax.
- README adapter table notes the per-role override surface in the cli-bridge row.
- The pre-Phase-0 cli-bridge `shell_exec` gate fires when any role uses cli-bridge, not just the top-level adapter. The halt reason is unchanged (`cli_bridge_requires_shell_exec`).

### Fixed

- **cli-bridge: clean exits no longer hang the adapter or the test runner.** v0.5.0's adapter awaited a `spawnErrorPromise` after the child closed; that promise was only resolved by the child's `error` event, which never fires on a successful run. The await blocked forever and took down the test runner with it (cancelling every cli-bridge test in CI on both Ubuntu and Windows on the v0.5.0 release). The promise now also resolves on the child's `close` event; errors that fire still win, so the surfaced behavior is unchanged.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. The brief parser extension is a pure addition to the existing hand-written YAML walker.
- Back-compat is complete in both directions. v0.4-era flat `roles:` briefs run with the v0.5.1 runtime; v0.5.1 briefs with `role_adapters:` are rejected by the v0.4 validator (unknown field), which is the right failure mode.
- No state-schema bump. `SessionMeta` gains an optional `role_adapter_ids` field; v3 sessions without it remain readable. v0.6 (persistent project memory) is the next schema-bump target.
- The `--adapter` CLI flag remains the run-wide default and the fallback for roles without overrides. Per-role overrides live in the brief only; no `--role-adapter` flag in v0.5.1 (deferred to v0.5.2 if operator demand surfaces).

## 0.5.0

cli-bridge adapter. OpenWar treats a CLI binary (Claude Code, Codex CLI, Gemini CLI, aider, your own custom tool) as an agent. The runtime delegates a brief by shelling out, captures stdout, and feeds it through the existing phase machine + detectors. Most multi-agent frameworks assume every agent is an API call; OpenWar is the first to coordinate across API agents and CLI agents in the same brief.

### Added

- **`src/adapters/cli-bridge.ts`**: new adapter implementing the existing `AgentAdapter` interface. Spawns the configured binary via `child_process.spawn`, pipes the prompt in via stdin, streams stdout as `text_delta` events, emits a `done` event on clean exit and an `error` event on timeout, non-zero exit, or spawn failure. Hand-rolled signal handling (SIGTERM with 5s SIGKILL escalation). Cross-platform via Node stdlib only; zero new dependencies.
- **Adapter config**: `extra.binary` (required), `extra.args`, `extra.timeout_ms` (default 10 min), `extra.working_dir`, `extra.env`, `extra.framework_prefix` (default true; prepends `openwar.md` to the prompt so non-OpenWar-aware CLIs still pick up the behavioral overlay), `extra.tier` (`"free"` default; set `"paid"` if your bridged CLI bills per call).
- **Tier-aware cost preview**. Every adapter now declares a tier (`free` or `paid`) via `DEFAULT_TIERS` in `src/adapters/index.ts`. API adapters default to `paid`; cli-bridge and mock default to `free`. The runner emits a tier banner before Phase 0 confirmation so the operator sees the cost shape of a run before any LLM call fires. `resolveTier()` and `DEFAULT_TIERS` are public exports for integrators.
- **Authorization gate**: cli-bridge requires `shell_exec` in `authorized_costs`. The runner halts cleanly with `halt_reason: "cli_bridge_requires_shell_exec"` if missing, surfacing a copy-pasteable frontmatter snippet instead of failing at first spawn.
- **CLI flags**: `--cli-binary <path>`, `--cli-arg a,b,c` (comma-separated; use brief `cli.args` array for arguments containing literal commas), `--cli-timeout-ms N`, `--cli-no-framework` (skip prepending `openwar.md`), `--cli-tier free|paid`.
- **Mock CLI fixture** at `tests/fixtures/mock-cli/cli.mjs`: synthetic CLI controlled by env vars (`MOCK_CLI_OUTPUT`, `MOCK_CLI_SLEEP_MS`, `MOCK_CLI_EXIT_CODE`, `MOCK_CLI_ECHO_STDIN`, etc). Tests never depend on Claude Code, Gemini CLI, or any real binary being installed.
- **Tests** at `tests/adapters/cli-bridge.test.ts`: 13 cases covering success, chunked streaming, non-zero exit with stderr capture, timeout enforcement (SIGTERM), spawn failure on missing binary, framework_prefix on/off, tier defaults, tier overrides, missing-binary throws at construction, and factory wiring through `makeAdapter`.
- **Examples**: `examples/cli-bridge-brief.md` (single-agent demo against `claude` by default) and `examples/cli-bridge-multi-agent-brief.md` (full coordinator run with cli-bridge driving every role).

### Changed

- `openwar.md` framework doc gains a "Bridging to CLI agents (v0.5+)" section that defines the pattern, lists when-to-use and when-NOT-to-use, explains how the phase machine applies across the bridge, documents the authorization model, and enumerates explicit non-goals for v0.5 (no native tool-call translation, no MCP brokering, no session-state forwarding, no per-role adapter mixing).
- README quickstart now lists `cli-bridge` in the adapter table and points to the example briefs.
- `AdapterId` union extended with `"cli-bridge"`. `listAdapters()` now reports each adapter's tier.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. The adapter uses `child_process.spawn`, `node:timers`, and existing OpenWar internals. No `execa`, no `cross-spawn`.
- The mock CLI fixture is a useful starting point if you ship your own bridge tests. Copy `tests/fixtures/mock-cli/cli.mjs` into your suite and parameterize via env vars.
- War Room consumes OpenWar via `presets/frameworks/openwar.md` and `scripts/update-frameworks.mjs`. After v0.5 ships, bump the pinned tag in War Room's `SOURCES` list to vendor the new framework doc.
- Per-role adapter mixing (planner on a cheap API, executor on a CLI, reviewer on yet another model) is the obvious next step but requires a brief-schema change to the `roles:` field. Designing that for v0.5.1.

## 0.4.0

Multi-agent orchestration. OpenWar graduates from one-agent-per-brief to a coordinated planner / executor / reviewer loop with optional critic disagreement, per-role tool scoping, recursive framework enforcement, cost budgets, and resumable mid-state sessions.

### Added

- **Role system** (`src/roles/`): four built-in roles (`planner`, `executor`, `reviewer`, `critic`) and an open registry (`registerRole()`) for forker extensions. Each role is a prompt-overlay + tool-scope on top of the framework + brief.
- **Coordinator** (`src/coordinator/`): hand-written FSM (`init` → `plan` → `dispatch` → `execute` → `review_step` → `next_subtask` | `retry` | `block` | `escalate` | `complete`) and a driver that walks it, dispatching role calls and tool execution. Pure state-machine isolated from IO and tested independently.
- **Handoff layer** (`src/orchestration/handoff.ts`): typed JSON handoffs (`plan`, `execution`, `review`, `escalation`) with hand-written schema validators. Adversarial-resistant: unknown fields stripped, strings length-capped, control characters scrubbed, linear-plan-only enforcement.
- **Per-role authorization scoping** (`src/auth/role-scope.ts`, `src/auth/check.ts`): every tool call now passes two checks. Role-scope failure is a programming error and halts the run; brief-authorization failure triggers the v0.3 Phase 3 operator prompt.
- **Budgets**: `max_tokens`, `max_wall_clock_minutes`, `max_tool_calls_per_subtask`, `max_retries_per_subtask`. Hitting any limit halts the coordinator cleanly with state persisted; the operator can extend and resume.
- **State schema v3** with idempotent migration from v2. New `SessionMeta` fields: `coordinator_state`, `plan`, `subtask_states`, `role_transcripts`, `cost`, `active_roles`, `budgets`, `coordinator_events`. v2 sessions load as v3 single-agent (`active_roles: []`).
- **Brief frontmatter**: `roles:` (list of role ids) and `budgets:` (nested map). Both optional and back-compat. Omitting `roles:` keeps the v0.3 single-agent behavior.
- **CLI**: `openwar plan <brief.md>` (planner dry-run, no execution), `openwar roles` (list registered roles), and `openwar run` flags `--roles`, `--max-tokens`, `--max-minutes`, `--single`.
- **Examples**: `examples/multi-agent-brief.md` (three-role static-site generator), `examples/critic-disagreement-brief.md` (four-role with critic enabled).
- **Coverage gate**: `scripts/check-coverage.mjs` runs the test suite under Node's native `--experimental-test-coverage` (no external dep) and enforces ≥85% line coverage on `src/orchestration/`, `src/roles/`, and `src/coordinator/`.
- **Tests**: new files under `tests/orchestration/`, `tests/roles/`, `tests/coordinator/` plus state-migration v2→v3 fixtures.

### Changed

- `openwar.md` framework doc bumped to v0.4 with a new "Multi-agent orchestration" section explaining how Phase 0/1/2/3/4 map to coordinator states and how the framework applies recursively to every role.
- README leads with the runtime + multi-agent flow; the system-prompt-only path remains documented.
- `MessageRole` is now the canonical name for the chat-turn role; `Role` remains as a deprecated alias for one minor cycle so existing integrators don't break.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. v0.4 is built on `EventEmitter` from Node stdlib, a hand-written queue, a hand-written FSM, and hand-written retry backoff. No `eventemitter3`, no `p-queue`, no `async-mutex`, no state-machine library.
- Cross-platform from day one. The CI matrix (Ubuntu, macOS, Windows × Node 20, 22) covers every new module.
- The library surface is stable for v0.4. War Room can import `runCoordinator`, `parsePlanFromText`, `validatePlanHandoff`, etc. from the package root.
- Token counting uses the chars/4 heuristic when adapters don't report usage. Not a real tokenizer. Brief explicitly accepts this approximation; v0.5 may revisit.

## 0.3.0

Tool calling. The runtime stops being a constrained chat wrapper and starts being a real agent.

### Added

- **Native tools** (`src/tools/native/`): `read_file`, `write_file`, `list_dir`, `shell_exec`, `http_fetch`, `apply_patch`. Each is sandboxed against the session workdir and gated by the authorization model.
- **Sandbox layer** (`src/sandbox/`): path-escape protection (including symlink-aware), generic timeout wrapper, output stream cap, HTTP host allowlist. Sandbox context is opaque to tools; they receive it and cannot construct one.
- **Authorization model** (`src/auth/`): 10 static categories plus dynamic `mcp_tool:<server>[:<tool>]`. Wildcards supported (`*`, `mcp_tool:*`, `mcp_tool:server:*`). `filesystem_read` is default-allowed; everything else needs explicit `authorized_costs` or a Phase 3 prompt.
- **Phase 3 for tool calls**: when the LLM emits a tool call requiring an unauthorized category, the runner halts into Phase 3 with a structured prompt. Operator chooses `y` (this call only), `Y` (promote categories session-wide), or `n` (deny). Denial injects a synthetic tool result so the LLM can recover.
- **MCP client** (`src/mcp/`): hand-rolled JSON-RPC over stdio. No `@modelcontextprotocol/sdk` dependency. Handles handshake, tools listing, tool calls, server crash, timeout, and malformed messages. Brief frontmatter `mcp_servers:` and global `~/.openwar/mcp.json` both supported.
- **Per-adapter tool-call translation**: Anthropic, OpenAI, Gemini, Grok, and openai-compat each translate `ToolDefinition[]` into the provider's native function-calling schema, parse streamed tool-use blocks (including incremental JSON args), and round-trip tool results.
- **Mock adapter** now supports scripted tool calls for deterministic testing.
- **CLI subcommands**: `openwar tools` lists registered native tools. `openwar mcp list|add|remove|test` manages global MCP server configs.
- **New `run` flags**: `--workdir`, `--no-shell`, `--mcp-server name=command`.
- **Brief frontmatter additions** (optional, all back-compat): `workdir:` (overrides session workdir) and `mcp_servers:` (list of `name=command` entries).
- **State schema v2** with automatic in-place migration from v1. New `SessionMeta` fields: `schema_version`, `session_approved_categories`, `tool_calls`.
- **Examples**: `file-editing-brief.md`, `research-brief.md`, `mcp-brief.md`.

### Changed

- `openwar.md` framework doc gains a "Tool calls and authorization" section. The old "the runtime never lets it touch the filesystem" line in the README is removed; it is no longer true.
- Test discovery moved to a Node script (`scripts/run-tests.mjs`) so tests under `tests/auth/`, `tests/sandbox/`, `tests/tools/`, `tests/mcp/`, and `tests/adapters/` all run on every platform without shell-glob issues.
- `StreamEvent` union extended with `tool_call_arg_delta` and `tool_call_complete`.
- `SendMessageOptions` gains `tools`, `prior_tool_calls`, `prior_tool_results`.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. The package still ships with `discord.js`-free, `@modelcontextprotocol/sdk`-free, and no `execa` / `node-fetch` / `chalk` / `yargs` / `zod`.
- Cross-platform from day one: the CI matrix (Ubuntu, macOS, Windows × Node 20, 22) covers every new module.
- Sessions from v0.2 resume cleanly. The `schema_version` field gets upgraded the first time a v1 session is read.

## 0.2.0

Runtime release. The framework gets a real engine.

### Added

- Node / TypeScript package with a `openwar` CLI.
- Brief parser and validator (markdown + frontmatter), with kebab-case project slugs, optional `brief_id` autogen, scope-lock and mode overrides, and an `authorized_costs` list that pre-approves categories of destructive actions.
- Phase-aware runner enforcing Phase 0 (Confirmation Summary required), Phase 1 (gated or auto-pilot execution), Phase 2 (blocker halt + persist + resume), Phase 3 (destructive flag, explicit per-session approval), and Phase 4 (canonical completion report).
- Deterministic detectors for confirmation, blocker, destructive intent, banned phrases, phase markers, and completion. Regex / pattern based; no second LLM.
- BYOK adapters: Anthropic Claude, OpenAI, Google Gemini, xAI Grok, and an OpenAI-compatible adapter that handles OpenRouter / Groq / Together / Ollama / vLLM / llama.cpp.
- MockAdapter for deterministic offline tests.
- Session persistence at `~/.openwar/sessions/` (one JSON per session + JSONL append-only transcript). `openwar resume <brief_id>` reopens.
- CLI commands: `run`, `resume`, `list`, `inspect`, `validate`, `adapters`, `version`.
- Library surface: `run`, `parseBrief`, `validateBrief`, all adapters, all detectors, and state helpers exported from the package root so integrators (e.g. War Room) can embed the runtime.
- Examples: a gated creative brief and an auto-pilot engineering brief.
- Cross-platform CI (Ubuntu, macOS, Windows on Node 20 and 22) with em-dash and personal-data sanity lints in front of the build / test pipeline.

### Changed

- `openwar.md` clarified: OpenWar is now both a framework (the markdown doc) and a runtime (this package). The "not a runtime" sentence in v0.1 has been removed.

### Notes for War Room integrators

The library surface is stable for v0.2. Re-exporting from `openwar` (root) gives you everything War Room needs to swap its raw adapter path for the OpenWar phase loop in channels where the operator selects the framework.

## 0.1.0

Initial release. System-prompt-only framework. Single markdown file (`openwar.md`), reference brief template, MIT license.
