# Changelog

## 0.9.0

`openwar history`: descriptive analytics over accumulated v0.8 traces. Read-only by design.

Originally scoped as "adaptive autonomy" with detector sensitivity overrides, recommended phase budgets, and a runtime-applied `learned_profile`. The brief was split during Phase 0 review on 2026-05-18 because the data foundation did not yet exist: v0.8.0 had landed three hours earlier and zero real traces accumulated against any project. Adapting against synthetic or thin samples would have shipped wrong-shaped defaults baked into runtime behavior. The original brief's own anti-gaming clause warned against this exact failure mode.

v0.9.0 ships the inspection layer. v0.9.1 will ship the prescriptive layer once one to two release cycles of v0.9.0 have accumulated real traces and we can calibrate heuristics against actual distributions.

### Added

- **`openwar history <project_slug>` subcommand**. Reads every trace.ndjson whose session metadata carries the slug, computes:
  - Per-tool call counts + last-used timestamps + "dead" flag (zero calls when sample >= 3).
  - Per-phase tool-call P50 / P90 / max, summed across runs. Tool-call attribution uses a most-recent-`phase_enter` walker so calls fall into the right bucket.
  - Per-detector total fires + fires-per-run + runs-with-fire.
  - Per-phase total + average `duration_ms` from `phase_exit` events.
  - Operator-readable notes: thin-sample warnings, dead-tool callouts, corrupted-line totals, v0.9.0-is-descriptive-only banner.
  - `--since <ISO>` filter, `--min-samples N` threshold (>= 2), `--json` deterministic output.
- **`openwar inspect <brief_id> --history`**. Brief-scoped surface: looks up the session's project slug and renders the same history report.
- **`docs/learning.md`** (new). Locks per-detector false-positive semantics for v0.9.1 even though v0.9.0 does not use them. Half a day of design work now while the question is fresh is cheaper than rebuilding the analysis in v0.9.1 against muscle-memory assumptions. Also documents the v0.9.0 vs v0.9.1 scope split and the safety-critical flag plan.
- **24 new tests** (`tests/state/history.test.ts`, `tests/cli/history.test.ts`, `tests/cli/inspect-history.test.ts`). Total 514 (was 490 at v0.8.0). Math correctness, determinism guarantees, filter semantics, schema_version anchoring, traceless-session reporting, brief-to-project lookup.
- **Library exports** (`src/index.ts`): `summarizeRun`, `aggregateRuns`, `buildHistoryReport`, `runHistory`, `formatHistoryReport`, `quantile`, `stringifyDeterministic`, plus the `RunSummary` / `HistoryReport` / row types. Integrators (War Room, etc.) can build their own reporting layers on top.

### Design notes (Phase 0 deviations approved)

- **Renamed from "adaptive autonomy" to "history".** A capability whose first impression is "tells you what your runs look like" should not ship under a name that promises runtime behavior change. v0.9.1 reclaims "adaptive autonomy" when it actually adapts.
- **No `learned_profile` schema, no runner integration, no detector sensitivity refactor, no new trace events.** All deferred to v0.9.1. v0.9.0 carries no forward-compat stubs in the schema either; cleaner to add fields in v0.9.1 with real data informing their shape.
- **The only confident heuristic in v0.9.0 is dead-tool detection.** Everything else is descriptive math (counts, quantiles, sums) with no thresholds attached. P50 + 1.5 * IQR for phase budgets is deferred because the IQR shape on real long-tail distributions is unknown.
- **Phase-attribution walker built now, inherited by v0.9.1.** Tool calls credit to the most-recent `phase_enter`. v0.9.1's budget math reuses the same walker.
- **Determinism is load-bearing.** `source_runs` arrays sort lexicographically. JSON output goes through `stringifyDeterministic` with sorted object keys. Same trace inputs produce the same report bit-for-bit (modulo `generated_at` timestamp). Tested in `tests/state/history.test.ts`.

### Out of scope (deferred to v0.9.1 or later)

- `openwar learn` subcommand and the `learned.json` profile schema.
- `learned_profile:` brief frontmatter field.
- Detector sensitivity overrides (loose / strict / disabled).
- Recommended phase budgets.
- Runner-side application of any of the above.
- The three planned trace events (`learned_profile_applied`, `learned_sensitivity_consulted`, `learned_budget_consulted`).
- Recommendation expiry, A/B harness for sensitivity tuning, cross-project learning.

### Notes for forkers and War Room integrators

- v0.9.0 is fully backwards compatible with v0.8.x. No new brief frontmatter fields. No runtime behavior changes. Existing sessions inspect identically; the new `--history` surface is purely additive.
- Operators on v0.8.x can upgrade to v0.9.0 with no migration cost. Accumulated v0.8 traces are immediately usable as history input.
- v0.9.1 (when it ships) will use the same trace format and the same phase-attribution walker; profiles will read this v0.9.0 history data plus locked FP semantics from `docs/learning.md`.

## 0.8.0

Observability and tracing. The first version that gives operators (and integrators like War Room) the structured data they need to actually understand what their agents are doing. Everything before v0.8 was about getting the runtime to behave correctly. v0.8 makes its behavior visible.

This release was scoped against two real Windows live tests on 2026-05-17 and 2026-05-18 that surfaced five observability gaps: invisible MCP call lifecycle, ambiguous permission-layer source on failure, invisible MCP server liveness, invisible phase timing, silent settings-merge failure modes. Each is closed by a specific event type in the new trace stream.

### Added

- **Structured trace event stream** at `~/.openwar/sessions/<brief_id>.trace.ndjson`. One JSONL event per line, append-only, schema-versioned via a `trace_version` header event on the first line. 19 event types covering phase transitions, tool calls, auth decisions, detector fires, role invocations, budget thresholds, sub-task state, coordinator state, MCP server lifecycle (started, shutdown, dispatched, completed; `mcp_call_pending` type defined, real-time emission lands in v0.8.x), settings-merge attempts and outcomes, and errors.
- **`openwar inspect` extensions**: `--trace`, `--trace --tail N`, `--trace --full`, `--timing`, `--cost`, `--cost --dollar-per-1k <rate>`, `--detectors`, `--tools`, `--mcp`. Each prints a focused table. The dashboard reuses the same formatters so column shape stays in sync between CLI and web view.
- **`openwar replay <brief_id>` subcommand**. Re-runs recorded assistant turns through CURRENT detector code, emits `[replay]`-prefixed output, halts at Phase 2 markers in the transcript (same shape as the original run), exits 1 when current detectors disagree with the recorded trace (drift). Useful for detector-regression CI gates and for demonstrating runs without paying for compute.
- **`openwar dashboard` subcommand**. Opt-in local HTTP dashboard, default port 8780, bound to the IPv4 literal `127.0.0.1` (avoids Windows IPv6 resolution surprises). Zero outbound network calls. Zero third-party dependencies. Vanilla HTML over a single CSS block. Per-session views for summary, timing, cost, detectors, tools, mcp, and the raw trace.
- **`OPENWAR_SESSIONS_DIR` environment variable**. Overrides the default `<OPENWAR_HOME>/sessions` location wholesale. Lets integrators relocate the session store and gives tests a clean way to point at a tmpdir.
- **`docs/observability.md`**. Operator guide. Event reference, inspect modes, replay semantics, dashboard, file layout.
- **40 new tests** (`tests/state/trace.test.ts`, `tests/state/trace-seams.test.ts`, `tests/cli/inspect.test.ts`, `tests/cli/replay.test.ts`, `tests/dashboard/server.test.ts`). Total now 490 (was 450 at v0.7.3). Every event type has a round-trip case. Inspect formatters pin column shape. Dashboard verified to bind 127.0.0.1 only and make zero outbound network calls.

### Design notes (Phase 0 deviations approved)

- **NDJSON appends use `fs.appendFileSync` per event, not tmp+rename.** The original brief specced "same atomicity as the transcript (tmp+rename per append)." That conflated transcript atomicity (low-frequency message persistence) with trace atomicity (high-frequency event log). Right invariant is "any complete line is a complete event"; appendFileSync gives that and scales O(1) per event.
- **`trace_version` header event** is the first line of every trace file. v0.9 will add fields; without a schema version marker, replay would silently misinterpret old traces.
- **`call_id` threaded through `mcp_call_*` events.** Concurrent MCP calls would otherwise be uncorrelatable in the trace.
- **Replay re-runs detectors against the recorded transcript.** Not playback of recorded detector results. Recorded trace is reference data for drift comparison, not the script. This is what makes replay useful for detector regression testing.
- **Dashboard = inspect-as-HTML.** Single source of truth across the on-disk text view and the web view. Four renderers collapse to one; bug fixes land once.

### Out of scope (per the brief)

- Remote telemetry / cloud aggregation. Local-first.
- OpenTelemetry adapter. v0.8.x stretch if real demand.
- Real-time streaming dashboard. Files-on-demand. WebSocket live updates wait until at least v0.8.x.
- Real-time `mcp_call_pending` emission. Requires subprocess-side tracing wired into `openwar mcp-serve`; the event type is defined so consumers can code against it now. Emission lands in v0.8.x.
- Multi-user dashboard authentication. Single operator, localhost-bound.
- Auto-pruning of old trace files. Operator manages disk usage manually.

### Notes for forkers and War Room integrators

- The trace file lives sibling to the transcript and session-state files. Existing v0.7.x sessions (no trace) inspect gracefully: `openwar inspect <id> --trace` prints a "no trace events; sessions written before v0.8 are transcript-only" notice and exits 0.
- War Room integrators consuming the OpenWar library can `import { Tracer, readTrace } from "@pythonluvr/openwar"` and pump trace data into their own observability stack. OpenWar itself stays silent on the wire.

## 0.7.3

Symmetric memory access tools. Last night's live test surfaced an asymmetry: `openwar:write_project_memory` worked through MCP forwarding, but in-namespace verification was not possible because the general-purpose `read_file` and `list_dir` tools are workdir-sandboxed, while the memory store lives at `~/.openwar/projects/<slug>/` (sibling to any workdir, by v0.6 design). The bridged agent that hit the wall did the right thing (declared Phase 2 instead of escaping the sandbox), but a brief that asks the agent to verify what was written had no clean path. v0.7.3 closes that with two memory-specific tools that have the same scoping as `write_project_memory`.

### Added

- **`openwar:list_project_memory`** (new native tool). Summarizes a project's memory store. Required `project: string`; optional `category: "decisions" | "knowledge" | "constraints"` (default: all three with per-category counts including empty ones); optional `since: <ISO>` timestamp filter and `limit` (default 100, capped at 500). Returns `summary_or_excerpt` per entry truncated to 200 chars: `summary` for decisions, `content` for knowledge, `rule` for constraints (per the brief's Phase 0 Q3). Does NOT return full bodies; the agent uses this to find ids and follows up with `read_project_memory` for the full content.
- **`openwar:read_project_memory` extension.** Adds optional `project: string` argument (falls back to `ctx.project_slug` for v0.6 back-compat) and optional `id: string` argument (returns exactly that entry when matched). Bumps default `limit` from 20 to 50 per the brief; cap raised to 500.
- **Claude Code permission allowlist updated** in `OPENWAR_MCP_TOOL_PATTERNS`: `mcp__openwar__openwar_list_project_memory` is now pre-authorized by v0.7.2's auto-setup alongside the eight existing entries (total 9).
- **Tests**: `tests/tools/read_project_memory.test.ts` (10 cases covering explicit-project routing, ctx-fallback back-compat, NO_PROJECT failure when neither is available, id-hit and id-miss behavior, missing-project graceful empty, limit cap at 500, limit=0 means cap-bounded, default-limit silence in response). `tests/tools/list_project_memory.test.ts` (10 cases covering registry exposure, schema requireds, per-category counts on all-categories mode, single-category mode, per-category accessor for `summary_or_excerpt`, 200-char truncation with ellipsis, `since` filter, missing-`project` rejection, response entry shape, missing-project returns three empty sections). `tests/mcp/openwar-server-runtime.test.ts` extended with the new tool name in tools/list. `tests/mcp/bridged-cli-settings.test.ts` count assertions migrated to anchor on `OPENWAR_MCP_TOOL_PATTERNS.length` rather than hardcoded numbers so future tool additions don't break the test.

### Out of scope (per the brief)

- Memory pruning operations for agents. `openwar memory remove` exists as a CLI subcommand from v0.6; agents don't get a destructive memory operation in v0.7.3. v0.8.x discussion if a brief needs it.
- Semantic search across memory. Reverse-chronological + id-based lookup only. Retrieval scoring stays deferred from v0.6.
- Cross-project memory access. Each call is scoped to one project slug. No "list every project's memory" operation.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies; both tools share v0.6's `src/state/memory.ts` infrastructure.
- No state schema bump. No brief format change. Drop-in compatible with v0.7.2.
- Total native tool count grows from 8 to 9. The MCP server runtime iterates `NATIVE_TOOLS` and exposes everything under the `openwar:*` namespace; no separate registration step.

## 0.7.2

Bridged-CLI permission auto-setup. v0.7.1's MCP forwarding wired the protocol correctly, but real-world live testing surfaced the next gap: the bridged Claude Code halts at its own permission gate on the first MCP tool call (`Claude requested permissions to use mcp__openwar__openwar_<tool>, but you haven't granted it yet.`). Claude Code treats external MCP tools as separate-trust by design; neither `--permission-mode bypassPermissions` nor `--allowedTools` bypasses them. v0.7.2 ships the automation that pre-authorizes the openwar MCP tools at the bridged CLI's settings file before spawn.

A Windows / macOS / Linux operator who runs `cli-bridge` against Claude Code with the default `cli.mcp_forward: true` now gets a clean Phase 0 → Phase 4 run without ever touching Claude Code's settings file themselves.

### Added

- **`src/mcp/bridged-cli-settings.ts`**: new module owning Claude Code permission auto-setup. Exports `claudeSettingsPath()` (verified against a real Claude Code install: `~/.claude/settings.json` on all three platforms; the brief's per-platform path guesses turned out to be wrong, the real layout is uniform), `mergeClaudeSettings(path, patterns)` (read-modify-write into the `permissions.allow` array; preserves all unrelated keys including other MCP servers' grants; idempotent; atomic via tmp+rename), `OPENWAR_MCP_TOOL_PATTERNS` (the eight `mcp__openwar__openwar_<tool>` patterns matching v0.7's native tools after Claude Code's namespace mangling), and `ClaudeSettingsMergeError` with stable `PARSE` / `READ` / `WRITE` codes.
- **Runner wiring**: before spawning Claude Code via cli-bridge, the runner calls `mergeClaudeSettings` with the eight openwar patterns and emits `Pre-authorized openwar MCP tools in Claude Code settings at <path> (added N new grants / all already authorized). Existing operator settings preserved.` as a banner. If the merge fails (malformed JSON, write permission denied), the runner halts cleanly into Phase 2 with `halt_reason: cli_bridge_permission_setup_failed_<code>` and a remediation message rather than spawning the bridged CLI with broken permissions.
- **Brief frontmatter `cli.skip_permission_setup: true|false`** (default `false`, auto-setup ON). Opt-out for operators who manage their Claude Code settings via dotfiles / Ansible / company policy and don't want OpenWar touching the file.
- **`CliBridgePermissionSetupError`**: typed error the runner catches to translate into the Phase 2 halt with the right `halt_reason`.
- **Tests**: `tests/mcp/bridged-cli-settings.test.ts` (13 cases covering path resolution, file creation when absent, preservation of unrelated top-level keys, preservation of unrelated `permissions.allow` entries including other servers' grants, idempotency on repeat calls, partial-overlap append, malformed JSON / array-root JSON both halting with PARSE rather than clobbering, non-array `allow` gracefully replaced, empty-input no-op, parent-directory creation, valid-JSON-with-trailing-newline output). `tests/mcp/cli-bridge-wiring-permission-setup.test.ts` (4 cases covering the success banner, the opt-out short-circuit, the malformed-settings refusal path surfacing as `CliBridgePermissionSetupError(PARSE)`, and the non-Claude-Code bridged CLI bypass).

### Changed

- The v0.6.2 brief-validator warning text and the v0.6.2 runtime banner mirror text both updated. Old text: "Pre-authorize the brief's paths in the bridged CLI's permission settings to avoid this." New text: "v0.7.2+ auto-authorizes the openwar MCP tools in Claude Code's settings before spawn. Other permission categories (filesystem paths the bridged CLI's own tools touch, shell commands it runs internally) remain the operator's responsibility; set `cli.skip_permission_setup: true` to opt out of auto-authorization."
- `docs/adapters.md` cli-bridge section explains the auto-setup, the preservation guarantee, and the opt-out path.

### Phase 0 design picks (locked)

1. **Settings file location.** `~/.claude/settings.json` on all platforms, verified against a real Claude Code install. Brief's per-OS path guesses (`%APPDATA%\Claude\claude.json`, `~/Library/Application Support/Claude/claude.json`) did not match the real layout.
2. **Schema.** `{ permissions: { allow: string[] } }`. OpenWar appends the eight `mcp__openwar__openwar_<tool>` patterns explicitly, no wildcards (safer and dedup-friendly; operators who prefer wildcards can edit manually).
3. **Other MCP servers' grants.** Untouched. Merge only adds to `permissions.allow`; everything else (other servers' MCP grants, Bash/Read/WebFetch entries, top-level keys, the `deny` array) is preserved verbatim.
4. **Idempotency and reversibility.** Idempotent (dedupe on add). Not reversible (operator removes manually if they want to undo).

### Out of scope (deferred)

- **Gemini CLI permission auto-setup.** Gemini's MCP permission UX is unknown; defer to v0.7.3 if real testing surfaces the same friction.
- **Codex CLI permission auto-setup.** Same. v0.7.4 or later.
- **General "bridged CLI settings" framework.** Resist abstracting too early; Claude Code is the first and most-felt case. Abstract when there's a second.

### Known smoke target

The live cli-bridge → Claude Code → openwar MCP tool end-to-end run is the brief's smoke target. It exercises the v0.7.0 MCP server + v0.7.1 wiring + v0.7.2 permission auto-setup as one path. Operator validates on first attempt after install; if the smoke surfaces additional gaps, v0.7.3 covers them.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies.
- No state schema bump. No brief format change beyond the optional `cli.skip_permission_setup` field. Drop-in compatible with v0.7.1.
- Default-on behavior is intentional: operators who don't read the changelog get the better experience automatically. The opt-out exists for power users.

## 0.7.1

Codex CLI joins Claude Code and Gemini CLI in the v0.7.0 MCP-server-mode infrastructure. Brought up as v0.7.1 because Codex's TOML config format required a small hand-rolled serializer; deferred from v0.7.0 to keep that release focused on the architectural foundation.

A Windows / macOS / Linux operator with Codex CLI installed can now run:

```bash
npx @pythonluvr/openwar run examples/cli-bridge-mcp-memory-brief.md \
  --adapter cli-bridge \
  --cli-binary codex
```

The runner writes `~/.codex/config.toml` with the OpenWar MCP server config, Codex discovers and consumes it, the bridged Codex session can call OpenWar's eight native tools through MCP. Same operator experience as Claude Code and Gemini CLI in v0.7.0.

### Added

- **`src/mcp/toml-writer.ts`**: hand-rolled TOML serializer scoped to MCP config shape only. Supports dotted section headers, string values, string array values. Escape rules cover every TOML 1.0 basic-string escape (`\b`, `\t`, `\n`, `\f`, `\r`, `\"`, `\\`, `\uXXXX` for non-printable Unicode). Public API is `writeTomlConfig(config: TomlConfig): string` plus `TomlConfig` type plus `upsertTomlSection(existing, header, body): string` for the read-modify-write merge path. Deliberately not a general-purpose TOML library: no integers, floats, booleans, dates, inline tables, multi-line strings, parsing.
- **Codex CLI registry entry**: `binary: "codex"` resolves to the Codex strategy. `configPath` returns `~/.codex/config.toml` via `os.homedir()`. Serializes the standard `McpConfigFileContent` to TOML via the new writer. No CLI flag injection (Codex auto-discovers `~/.codex/config.toml`). `cleanupConfigFile: false` consistent with Gemini (operators who wire Codex MCP typically want the wiring sticky). `mergeIntoExisting: true` so existing operator-edited sections survive.
- **`BridgedCliStrategy` interface gains three optional fields** (back-compat additive): `serializeConfig?(content): string` (default `JSON.stringify(content, null, 2)`), `mergeIntoExisting?: boolean` (default `false`), `mergeSectionHeader?: string` (default `"mcp_servers.<serverName>"`). Claude Code and Gemini CLI entries unchanged; the JSON default + overwrite behavior matches v0.7.0 exactly.
- **Runner-side read-modify-write** in `src/mcp/cli-bridge-wiring.ts`. When a strategy sets `mergeIntoExisting: true` and the config file exists, the runner reads the existing content, calls `upsertTomlSection` to replace or append just the OpenWar section, writes the merged result. When the file doesn't exist, behavior is unchanged (write the serialized output verbatim).
- **Tests**: `tests/mcp/toml-writer.test.ts` (25 cases covering basic strings, every TOML 1.0 escape individually, Windows backslash paths, paths with spaces, dotted section headers, string arrays, empty arrays, the canonical MCP config shape, and 6 cases on `upsertTomlSection` for append / replace / final-section / prefix-collision / CRLF normalization). `tests/mcp/cli-bridge-wiring-codex.test.ts` (4 end-to-end cases against a tmp HOME: writes TOML to `~/.codex/config.toml`, merge preserves operator `[user]` + `[history]` sections, merge replaces stale `[mcp_servers.openwar]` block, `cli.mcp_forward: false` opt-out short-circuits the whole setup). `tests/mcp/bridged-cli-registry.test.ts` extended with 7 Codex resolution + behavior cases.
- **`docs/adapters.md`**: cli-bridge section gains a "MCP-server-mode and the bridged-CLI registry" subsection with a table of all three registered CLIs (Claude Code, Gemini CLI, Codex CLI) and their config strategy.

### Changed

- The cli-bridge MCP forwarding now serializes the config file through the strategy's `serializeConfig` hook (default JSON, Codex TOML). Behavior for Claude Code and Gemini CLI is byte-identical to v0.7.0.

### Phase 0 design pick

**Append vs overwrite for `~/.codex/config.toml`: read-modify-write.** Builder picked option (a) from the v0.7.1 brief for safety. Operators with hand-edited Codex configs (model preferences, history settings) keep those sections intact across OpenWar runs. The merge is text-boundary based: find `[mcp_servers.openwar]` at column 0, replace its body up to the next column-0 section header or EOF, append if absent. No TOML parser required.

### Known smoke-gap

The brief allowed deferring the operator smoke test if Codex CLI isn't available locally. This release ships on the strength of 35 new unit tests (TOML writer + Codex registry + end-to-end wiring against a tmp HOME), validated cross-platform via the existing CI matrix. A real bridged-Codex session against an OpenWar brief is the v0.7.2 smoke-verification target once the operator has Codex installed.

### Out of scope (deferred or skipped)

- **aider registry entry.** Aider has no native MCP server support today. Defer to v0.7.2 or whenever aider ships first-class MCP support.
- **TOML parsing.** OpenWar only writes TOML. No parser is added.
- **General-purpose TOML support.** The serializer covers only what MCP config requires. Scope creep is the failure mode for v0.7.1; integers, floats, booleans, dates, inline tables, multi-line strings, tables of tables are all deliberately unsupported.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. The TOML writer is ~150 lines of hand-rolled Node stdlib.
- No state schema bump. No brief format change. Drop-in compatible with v0.7.0.
- The `BridgedCliStrategy` interface additions are optional fields; forker-defined custom registry entries that don't set them get the v0.7.0 JSON + overwrite behavior unchanged.

## 0.7.0

MCP-server-mode for cli-bridge. v0.5.0's cli-bridge adapter let OpenWar coordinate a CLI agent (Claude Code, etc), but the bridged CLI could not call OpenWar's native tools because its tool registry was its own. v0.7 closes the gap: OpenWar exposes its native tools as an MCP server, the bridged CLI consumes them through standard MCP, and the runtime threads OpenWar's authorization gates across the bridge. Operators can now run a brief that asks the bridged Claude Code to call `write_project_memory` (or any of the eight native tools) and have it actually work.

This reorders the v0.7 roadmap slot. Observability / tracing was originally scheduled for v0.7; per the cli-bridge follow-up brief's Option A, observability slides to v0.8 because the cli-bridge native-tool gap is the more-felt operator pain right now.

### Added

- **`src/mcp/server.ts`**: hand-rolled MCP server. Mirror of `MCPClient`: listens for JSON-RPC requests on a `Readable`, dispatches to a handler map, writes responses to a `Writable`. Handles `initialize`, `tools/list`, `tools/call`, and arbitrary custom methods. Newline-delimited UTF-8 JSON framing; same 5MB inbound buffer cap the client uses. JSON-RPC error codes: `RPC_ERR_OPENWAR_AUTH` and `RPC_ERR_OPENWAR_INTERNAL` (application-defined `-32000` / `-32001`) for OpenWar-originated errors, plus the standard parse / invalid-request / method-not-found / invalid-params / internal codes.
- **`src/mcp/openwar-server-runtime.ts`**: wires every native tool (`read_file`, `write_file`, `list_dir`, `shell_exec`, `http_fetch`, `apply_patch`, `read_project_memory`, `write_project_memory`) into the MCP server with the `openwar:` namespace prefix. Every `tools/call` passes through the existing `checkAuthorization` gate against the brief's `authorized_costs`. Rejected calls return `isError: true` with the message **`OpenWar denied: <category> not in authorized_costs ...`** so the operator can see which layer rejected vs the bridged CLI's own permission errors. Every call (allowed and denied) is appended to a per-session JSONL log at `--tool-log-path` for transcript capture.
- **`src/mcp/bridged-cli-registry.ts`**: per-bridged-CLI MCP config-injection strategy. v0.7.0 ships two known-supported CLIs:
  - **Claude Code**: temp JSON config file, `--mcp-config <path>` flag injection, cleaned up at session end.
  - **Gemini CLI**: writes the MCP config to a workdir-local `.gemini/settings.json` where Gemini auto-discovers it. No CLI args injected. File persists across runs (operators who wire Gemini MCP forwarding typically want the wiring sticky).
  
  Resolution is by basename, case-insensitive, `.cmd` / `.bat` / `.exe` stripped, so `--cli-binary claude`, `--cli-binary claude.cmd`, and absolute paths all match. Unknown binaries (Codex, aider, custom binaries) hit the fallback: the temp MCP config file is still written but no CLI args are injected, and the runtime emits a startup warning so the operator can wire MCP manually or set `cli.mcp_forward: false`. Strategy interface gains an optional `configPath()` resolver (CLI-known location override) and `cleanupConfigFile` flag (default true; false for sticky overrides).
- **Codex CLI deferred to v0.7.1+.** Codex's MCP config lives in `~/.codex/config.toml` (TOML, not JSON). Adding a Codex registry entry would require shipping a TOML serializer, which crosses the operator-approved "straightforward" bar for v0.7.0 inclusion. Codex falls back to the unknown-binary path in v0.7.0; the registry entry lands when TOML support is in scope.
- **`src/mcp/cli-bridge-wiring.ts`**: runner-side orchestration. When the active adapter is cli-bridge AND the brief did not opt out via `cli.mcp_forward: false`, the runner: writes a temp MCP config file pointing at `node bin/openwar mcp-serve --workdir <wd> --authorized-costs <list> ...`; resolves the bridged binary in the registry; injects the CLI-specific args (e.g. `--mcp-config <path>` for Claude Code) into the adapter via the new `addExtraArgs` method. At session end, the per-session tool log is read back and folded into the OpenWar transcript as `ToolCallRecord` entries with `meta.via = "mcp_bridge"` (and `meta.denied_by` when the rejection came from OpenWar's auth).
- **`openwar mcp-serve` CLI subcommand**: the entry point a bridged CLI spawns as its MCP server. Reads workdir, authorized costs, project slug, brief id, and tool log path from CLI flags. Runs the OpenWar MCP server on stdin/stdout until the parent closes the pipe.
- **`CliBridgeAdapter.addExtraArgs(args)`**: runner-side hook to append args before the prompt. Used by the MCP-server-mode wiring without widening `AdapterConfig`.
- **Brief frontmatter `cli.mcp_forward: true|false`** (default `true`). Nested under a `cli` block so future cli-bridge knobs can live alongside. Opt-out path for operators who deliberately want the bridged CLI in its own tool sandbox.
- **Tests**: `tests/mcp/server.test.ts` (9 cases covering initialize / tools/list / tools/call dispatch / unknown method / invalid params / malformed JSON / notifications / generic throw / custom rpcError code), `tests/mcp/openwar-server-runtime.test.ts` (5 cases covering tools/list namespace, OpenWar-denied prefix, namespace enforcement, successful execution + JSONL log entry, denial log entry with `denied_by: "openwar"`), `tests/mcp/bridged-cli-registry.test.ts` (6 cases covering Claude Code resolution variants, fallback shape, args injection, listing, config file shape, custom server name).

### Changed

- The cli-bridge cost-tier preview banner is unchanged; the MCP-server-mode startup notice piggybacks on the existing `io.warn` path for fallback cases.
- `openwar --help` lists `mcp-serve` under the CLI usage block.

### Authorization split

Per the v0.7 picks, OpenWar's MCP server rejects calls with `OpenWar denied: ...` messages. The bridged CLI's own permission layer rejects calls inside its own process and surfaces those rejections in its own way (Claude Code shows them in its UI). Operators reading either rejection message can tell which layer to fix without inspecting code.

### Explicit non-goals (v0.7.0)

- Custom MCP transport. Reuses the existing stdin/stdout framing primitives. No socket, no named pipe.
- Auto-translation of tool names beyond the standard `openwar:<tool>` namespace prefix.
- Cross-CLI tool incompatibility absorption. Aider, Codex, and other non-Claude-Code CLIs fall back to the registry's "unknown" path with a startup warning.
- Per-role MCP config injection. The MCP config is per-session; every role on a cli-bridge run shares the same OpenWar tool surface.
- Live transcript update of MCP-mediated calls. v0.7.0 captures via per-session JSONL log replayed at session end; live update is a v0.8 observability deliverable.

### Notes for forkers and War Room integrators

- Zero new runtime dependencies. The MCP server reuses the JSON-RPC framing from the existing client, the stdin/stdout streams are Node stdlib, and the bridged-cli registry is hand-rolled.
- No state schema bump. MCP-mediated tool calls fold into the existing `SessionMeta.tool_calls` list with `meta.via = "mcp_bridge"` so older `openwar inspect` works unchanged; integrators that want to filter by origin can read the new meta field.
- Backwards-compatible. Briefs without `cli.mcp_forward` default to enabling MCP forwarding, but only when the active adapter is cli-bridge. Non-cli-bridge runs are unaffected.
- Operator-contributed registry entries are the v0.7.1 expansion path. The registry is a `Map<string, BridgedCliStrategy>` and accepts new entries with no schema bump.

## 0.6.2

Two follow-ups against real Windows testing of v0.6 memory through cli-bridge. Together they complete the Windows operator experience and surface the cli-bridge / bridged-CLI permission interaction at lint time so operators see it before a mid-run halt.

### Fixed

- **cli-bridge: spawn extensionless binaries on Windows.** The v0.6.1 fix enabled shell mode only for explicit `.cmd` / `.bat` paths. Operators typing the natural `--cli-binary claude` form (matching the binary's name on PATH) still hit `spawn claude ENOENT` because Windows `CreateProcess` does not walk `PATHEXT`. The `needsShell` predicate now also fires when the binary has no extension on Windows; shell mode then lets `cmd.exe` do the `PATHEXT` walk. Direct executables with `.exe` / `.com` extensions keep `shell: false` (no quoting regressions). POSIX behavior unchanged.

### Added

- **Brief-validator warning when cli-bridge meets side-effecting authorization.** When a brief pins any role to `cli-bridge` AND authorizes any side-effecting category (`filesystem_write`, `filesystem_delete`, `shell_exec`, `http_fetch`, `git_write`, `git_push`, `deploy`, `external_message`, `paid_api_call`, or wildcard `*`), `openwar validate` now emits an informational warning. The warning explains that OpenWar's `authorized_costs` apply to OpenWar's own tool calls; the bridged CLI runs as its own subprocess with its own permission layer (Claude Code's permissions, etc) which sits on top. Operators who don't pre-authorize the brief's paths in the bridged CLI may see the bridged agent declare Phase 2 mid-run when the CLI's own permissions reject a write the OpenWar brief authorized. Warning, not an error; the operator may still want to run the brief.
- **Runtime banner mirror at run start** for the same warning, scoped to the top-level `--adapter cli-bridge` case where the brief itself doesn't declare cli-bridge per-role. Fires through `io.warn` before Phase 0 so the operator sees it alongside the existing tier preview.
- **`tests/adapters/cli-bridge-windows-cmd.test.ts`** gains a `PATHEXT` regression case. Prepends a temp directory containing `hello.cmd` to PATH, spawns `hello` (no extension) via the adapter, asserts a clean `done` event. Skips cleanly on non-Windows so CI on Ubuntu and macOS stays green.
- **`tests/brief-cli-bridge-warning.test.ts`** covers five cases: warning fires on `filesystem_write` + cli-bridge, warning fires on `shell_exec` + cli-bridge, no warning when the only auth is `filesystem_read` and no cli-bridge is in play, no warning when adapter is not cli-bridge even with write auth, warning fires on wildcard `authorized_costs` + cli-bridge.

### Known follow-up (not in 0.6.2)

- **MCP-server-mode for native tool forwarding through cli-bridge.** Today the bridged CLI cannot call OpenWar's native tools (`read_project_memory`, `write_project_memory`, the six filesystem/shell/http tools, MCP tools) because its tool registry is its own. This is the v0.5 explicit non-goal; the canonical fix is for OpenWar to expose its native tools as an MCP server and the bridged CLI to consume them via MCP. OpenWar already implements the MCP client side in `src/mcp/`; adding the server side reuses the same JSON-RPC primitives. Estimated 1-2 weeks of builder work. Likely lands as v0.7 (potentially reordering the observability roadmap slot to v0.8) once Phase 0 design lands. Decision deferred to the operator.

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
