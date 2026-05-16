# Changelog

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
