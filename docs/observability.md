# Observability (v0.8)

OpenWar v0.8 adds a structured event stream alongside the existing transcript. Every session emits a `trace.ndjson` file that captures what the runtime did at the seams the operator cares about: phase transitions, tool calls, auth decisions, detector fires, MCP lifecycle, and settings-merge outcomes. The trace is the data layer v0.9 adaptive autonomy will read; v0.8 is the operator-visible interface to it.

Local-first. Zero remote telemetry. No third-party tracing format.

---

## What gets traced

Each session writes to `~/.openwar/sessions/<brief_id>.trace.ndjson` (override the directory with `OPENWAR_SESSIONS_DIR`). One JSON object per line. The first line is always a `trace_version` header so the format is forward-compatible.

Event types in v0.8.0:

| Event | Fires when |
|---|---|
| `trace_version` | First line of every trace. Carries schema version + openwar version + brief id. |
| `phase_enter` | The runtime transitions into a phase (intake, execute, blocker, destructive, completion, done). |
| `phase_exit` | The runtime transitions OUT of a phase. Carries `duration_ms`. |
| `detector_fired` | A detector returned a meaningful signal (blocker, destructive, completion, banned phrase, phase marker, confirmation). |
| `tool_call` | A tool was authorized and about to dispatch. Includes `auth_decision`. |
| `tool_result` | Tool finished. Carries `success`, `duration_ms`, `bytes`. |
| `auth_check_fired` | The authorization gate evaluated a tool. Includes layer (`openwar` / `bridged_cli` / `session_approval`), decision, reason. |
| `auth_prompt` | Operator hit a Phase 3 prompt. Records the y/Y/n response. |
| `role_invoke` | Multi-agent coordinator dispatched a role. Includes tokens + duration when reported (full token wiring lands in v0.8.x). |
| `budget_warn` / `budget_halt` | Coordinator budget threshold crossed or exceeded. |
| `subtask_status` | Sub-task moved into a new state (executing, passed, failed, retrying, escalated). |
| `coordinator_state` | Coordinator FSM entered a new state. |
| `mcp_server_started` | cli-bridge wired up an MCP server for the bridged CLI. |
| `mcp_server_shutdown` | Session ended. Cleanup signaled. |
| `mcp_call_dispatched` / `mcp_call_completed` | Synthesized at session end from the per-session tool log (the bridged CLI's MCP calls into OpenWar). |
| `mcp_call_pending` | Designed for v0.8.x. Requires subprocess-side tracing in `openwar mcp-serve`. v0.8.0 ships the type so consumers can code against it; real-time emission lands next minor. |
| `settings_merge_attempted` / `settings_merge_outcome` | The runtime touched a bridged CLI's settings file (Claude Code permission auto-setup). Outcome covers success / parse_error / read_error / write_error. |
| `learned_profile_applied` | v0.9.1+. Once at session start, when a brief's `learned_profile:` slug loads its `learned.json`. Carries counts of detector overrides, phase budgets, and dead-tool callouts. |
| `learned_sensitivity_consulted` | v0.9.1+. Per detector consultation with non-default sensitivity. Records the sensitivity value (`loose` / `strict` / `disabled`) and whether the detector fired or was suppressed. |
| `learned_budget_consulted` | v0.9.1+. At phase enter when a profile is active. Carries recommended budget, the actually-applied value, and the source (`learned` / `brief` / `default`). |
| `chat_session_compiled` | v0.10.0+. Once per chat-originated run, stamped into the brief's trace at session start so `openwar inspect` can show "this run came from chat session X". Includes `chat_id` and `brief_id`. |
| `chat_session_resumed` | v0.10.0+. Defined for forward-compat. Primarily lives in the chat-store NDJSON (`~/.openwar/chats/<chat_id>.ndjson`); included in the trace union so library consumers can ingest both streams against one type. |
| `chat_brief_saved` | v0.10.0+. Defined for forward-compat. Primarily lives in the chat-store NDJSON; emitted when a chat session writes a saved brief to `~/.openwar/briefs/<name>.md`. |
| `tool_cancelled` | v0.11.1+. An in-flight tool call was aborted (chat REPL Ctrl-C, programmatic `Session.cancelCurrentToolCall()`, or `RunOptions.signal`). Carries `call_id`, `tool_name`, `cancellation_source` (`operator_signal` / `timeout` / `runtime_shutdown`), and `partial_output` (whatever bytes the tool produced before the abort fired; empty for tools that buffer until completion). The companion `tool_result` event is NOT emitted for a cancelled call. |
| `permission_requested` | v0.12.0+. Agent called `request_permission`. Carries `grant_id`, `action`, `category`, `scope_requested`, `reasoning`, `fallback`. Logged before the operator answers. |
| `permission_granted` | v0.12.0+. Operator approved (possibly at a different scope than requested). Carries `grant_id`, `scope_granted`, `operator_note`. |
| `permission_denied` | v0.12.0+. Operator denied, or no operator available (headless non-TTY). Carries `grant_id`, `operator_note`. |
| `permission_grant_consumed` | v0.12.0+. Phase 3 found a matching grant for an unauthorized tool call. Carries `grant_id`, `consuming_tool_call_id`. The dispatcher proceeds without the operator prompt. |
| `permission_revoked` | v0.12.0+. Operator revoked a grant via `/revoke` or `Session.revokeGrant()`. Carries `grant_id`, `revoked_at`. Persistent grants get the revoke row appended to disk. |
| `error` | Catchall for runtime exceptions surfaced at known seams. |

The schema is versioned. v0.8.0 shipped `version: 1`. v0.11.1 bumped to `version: 2` for the additive `tool_cancelled` event. v0.12.0 bumped to `version: 3` for the five additive `permission_*` events. Each bump is forward-compatible; consumers should treat unknown event types as informational and ignore unknown optional fields.

`openwar inspect <brief_id> --permissions` renders a per-grant audit row across the permission events: grant id, status (requested / granted / denied / consumed / revoked), scope, category, action, and timestamp. See [`docs/permissions.md`](./permissions.md) for the full PermissionBridge surface.

---

## Inspecting a trace

```
openwar inspect <brief_id>                  # legacy session summary
openwar inspect <brief_id> --transcript     # full assistant transcript
openwar inspect <brief_id> --trace          # raw event dump, last 100
openwar inspect <brief_id> --trace --full   # all events
openwar inspect <brief_id> --trace --tail 50
openwar inspect <brief_id> --timing         # per-phase duration table
openwar inspect <brief_id> --cost           # per-role tokens + duration
openwar inspect <brief_id> --cost --dollar-per-1k 3.0
openwar inspect <brief_id> --detectors      # which detectors fired, counts
openwar inspect <brief_id> --tools          # tool call + result table
openwar inspect <brief_id> --mcp            # MCP lifecycle + settings merge
```

`--cost --dollar-per-1k <rate>` adds an `est_$` column. Rows whose token counts came from the chars/4 heuristic (rather than adapter-reported usage) are marked with `*`. Adapters without published pricing should be queried with `--dollar-per-1k` left unset; estimated dollar values hide a meaningful signal when the rate is unknown.

### Column shape stability

The columns of `--timing`, `--cost`, `--detectors`, and `--tools` are pinned by `tests/cli/inspect.test.ts`. v0.8.x can add columns to the right, but existing column positions must not move within v0.8.

---

## Replay

```
openwar replay <brief_id>
```

Replay re-runs the recorded assistant turns through the CURRENT detector code. The original trace is reference data, not the script. Every output line is prefixed `[replay]` so the operator can never mistake replay output for a live run.

Use cases:
- Debug detector regressions: replay an old session against newer detector code; non-zero `drift_count` flags disagreement and exits 1.
- Demonstrate a run without paying for compute.
- Validate that a runtime upgrade preserves a known-good session shape.

Replay is NOT bit-identical to the original. Timestamps are fresh. Detector fires reflect current code. A `Phase 2: Blocker` in the transcript halts replay in the same shape as the original run halted.

---

## Local dashboard

```
openwar dashboard            # binds 127.0.0.1:8780
openwar dashboard --port 9090
```

The dashboard is opt-in. Default bind is the IPv4 literal `127.0.0.1` (avoids Windows IPv6 resolution surprises). Zero outbound network calls. No third-party dependencies. Hand-rolled HTML over a single CSS block.

Views:
- `/` session list
- `/session/<brief_id>?view=summary` (default)
- `/session/<brief_id>?view=timing` / `cost` / `detectors` / `tools` / `mcp` / `trace`

The dashboard reuses the same formatters as `openwar inspect`. Adding a new view = adding a formatter, then a tab. Single source of truth.

---

## What is NOT in v0.8.0

- **Real-time `mcp_call_pending` emission.** Requires subprocess-side tracing in the `openwar mcp-serve` child process. The event type is in the union; emission lands in v0.8.x.
- **OpenTelemetry exporter.** Trace format is custom. If community demand surfaces, v0.8.x can add an OTel adapter.
- **Remote telemetry / multi-user dashboard auth.** Local, single-operator.
- **Real-time streaming dashboard.** Dashboard reads files on demand. WebSocket live updates wait until at least v0.8.x.
- **Auto-pruning of old trace files.** Operator manages disk usage manually.
- **Full per-adapter token-source reporting.** Coordinator emits `role_invoke` with `tokens_source: "estimated"` placeholder when actual usage isn't reported by the adapter; full wiring per adapter is planned for v0.8.x.

---

## Disk usage

Typical session trace files are a few hundred KB. Long auto-pilot coordinator runs can grow into the MB range. v0.8 does not auto-prune. Sessions are independent; deleting `~/.openwar/sessions/<brief_id>.*` removes one session's transcript + trace + state cleanly.

---

## File layout

```
~/.openwar/sessions/<brief_id>.json                  # session state (existing)
~/.openwar/sessions/<brief_id>.transcript.jsonl      # transcript (existing)
~/.openwar/sessions/<brief_id>.trace.ndjson          # v0.8 trace (new)
```

Override the directory wholesale with `OPENWAR_SESSIONS_DIR`. Override the OpenWar home with `OPENWAR_HOME`.

---

## Programmatic consumers

The library exports the writer + reader:

```ts
import { Tracer, readTrace } from "@pythonluvr/openwar";
```

The dashboard formatters are also exported from the library entry point for integrators (War Room, etc.) who want to render trace data inside their own UI.
