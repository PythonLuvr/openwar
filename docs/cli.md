# CLI reference

The `openwar` binary is the entry point for everything the runtime does. Install globally with `npm install -g @pythonluvr/openwar`, or invoke ad-hoc via `npx @pythonluvr/openwar`.

## Subcommand summary

```text
openwar run <brief.md> [--adapter <id>] [--model <name>] [--mode gated|auto]
                       [--workdir <path>] [--no-shell]
                       [--mcp-server name=command] [--resume] [--ephemeral]
                       [--roles planner,executor,reviewer[,critic]]
                       [--max-tokens N] [--max-minutes N] [--single]
                       [--cli-binary <path>] [--cli-arg a,b,c]
                       [--cli-timeout-ms N] [--cli-no-framework]
                       [--cli-tier free|paid]
openwar plan <brief.md>                     # planner dry-run; no execution
openwar resume <brief_id>                   # auto-detects single-agent vs multi-agent
openwar list
openwar inspect <brief_id> [--transcript]
openwar inspect <brief_id> --trace [--tail N | --full]   # v0.8 structured trace
openwar inspect <brief_id> --timing                       # per-phase durations
openwar inspect <brief_id> --cost [--dollar-per-1k <rate>]
openwar inspect <brief_id> --detectors
openwar inspect <brief_id> --tools
openwar inspect <brief_id> --mcp
openwar replay <brief_id>                                 # v0.8 LLM-free replay
openwar dashboard [--port <n>]                            # v0.8 local web view
openwar history <project_slug>                            # v0.9 descriptive history
openwar history <project_slug> --since <ISO>
openwar history <project_slug> --min-samples N
openwar history <project_slug> --json
openwar inspect <brief_id> --history                      # v0.9 brief-scoped history
openwar validate <brief.md>
openwar roles                                # list registered roles
openwar adapters
openwar tools
openwar mcp list | add <name> <cmd...> | remove <name> | test <name>
openwar version
```

## Common flags

| Flag | Where | Notes |
|---|---|---|
| `--adapter <id>` | `run`, `plan` | Default `anthropic`. Available: `anthropic`, `openai`, `gemini`, `grok`, `openai-compat`, `cli-bridge`, `mock`. |
| `--model <name>` | `run`, `plan` | Adapter-specific override. |
| `--mode gated\|auto` | `run` | Overrides the brief's mode. |
| `--workdir <path>` | `run` | Sandbox root for filesystem tools. Defaults to cwd or brief frontmatter. |
| `--no-shell` | `run` | Disables `shell_exec` for this session even if authorized. |
| `--mcp-server name=command` | `run` | Adds an MCP server for this run only. Comma-separate for multiple. |
| `--resume` | `run` | Pick up an existing session at its next state. |
| `--ephemeral` | `run` | Skip persistence (used by tests and integrators). |
| `--roles planner,...` | `run` | Override the brief's roles list at runtime. |
| `--single` | `run` | Force single-agent mode even if the brief opted into multi-agent. |
| `--max-tokens N` | `run` | Override the brief's `budgets.max_tokens`. |
| `--max-minutes N` | `run` | Override the brief's `budgets.max_wall_clock_minutes`. |

## cli-bridge flags (v0.5+)

| Flag | Notes |
|---|---|
| `--cli-binary <path>` | Required when `--adapter cli-bridge`, unless the brief supplies `cli.binary`. |
| `--cli-arg a,b,c` | Comma-separated arg list passed to the binary before the prompt. For args containing literal commas, use the brief's `cli.args` array instead. |
| `--cli-timeout-ms N` | Hard timeout per invocation. Default 600000 (10 min). |
| `--cli-no-framework` | Skip prepending `openwar.md` to every prompt. Use when your CLI already has OpenWar in its own system prompt. |
| `--cli-tier free\|paid` | Cost-tier label surfaced in the pre-Phase-0 banner. cli-bridge defaults to `free`. |

## Session persistence

Sessions persist to `~/.openwar/sessions/` as JSON metadata plus a JSONL transcript. Resume any session with:

```bash
openwar resume <brief_id>
```

Inspect a finished or paused session:

```bash
openwar inspect <brief_id>            # metadata only
openwar inspect <brief_id> --transcript  # full back-and-forth
```

v0.8 adds focused inspect modes that read the structured trace stream alongside the transcript. See [observability.md](./observability.md) for the full event reference.

```bash
openwar inspect <brief_id> --trace            # raw events, last 100 by default
openwar inspect <brief_id> --trace --full     # all events
openwar inspect <brief_id> --trace --tail 50
openwar inspect <brief_id> --timing           # per-phase durations
openwar inspect <brief_id> --cost             # per-role tokens + duration
openwar inspect <brief_id> --cost --dollar-per-1k 3.0
openwar inspect <brief_id> --detectors        # detector fire counts
openwar inspect <brief_id> --tools            # tool call table
openwar inspect <brief_id> --mcp              # MCP + settings merge view
```

Replay a recorded run through current detector code (no LLM calls):

```bash
openwar replay <brief_id>
```

Optional local dashboard (opt-in; binds 127.0.0.1):

```bash
openwar dashboard            # default port 8780
openwar dashboard --port 9090
```

`OPENWAR_SESSIONS_DIR` overrides the default sessions directory wholesale; useful for integrators who relocate the session store.

`--ephemeral` on `openwar run` skips persistence entirely. Used by tests, CI runs, and integrators that manage their own state.

## MCP server management

Three ways to attach MCP servers to a run, in order of scope:

1. **Per-brief** via `mcp_servers:` in the brief frontmatter.
2. **Per-run** via `--mcp-server name=command` on `openwar run`.
3. **Global** via `openwar mcp add <name> <command...>` (writes to `~/.openwar/mcp.json`).

Smoke-test a configured server with:

```bash
openwar mcp test <name>
```

Remove with `openwar mcp remove <name>`. See [tools.md](./tools.md) for how MCP servers integrate with the authorization model.

## Quick reference for first runs

```bash
# Validate a brief without running it (no model call, free)
openwar validate examples/multi-agent-brief.md

# Dry-run the planner only (one cheap LLM call, no execution)
openwar plan examples/multi-agent-brief.md --adapter anthropic

# Full single-agent run
openwar run examples/creative-brief.md --adapter anthropic

# Multi-agent run with three default roles
openwar run examples/multi-agent-brief.md --adapter anthropic

# Run against a local CLI agent
openwar run examples/cli-bridge-brief.md --adapter cli-bridge --cli-binary claude
```

See [brief-format.md](./brief-format.md) for the YAML schema and [multi-agent.md](./multi-agent.md) for orchestration details.
