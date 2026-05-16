<p align="center">
  <img src="openwar-logo.png" alt="OpenWar" width="160" height="160" />
</p>

<h1 align="center">OpenWar</h1>

<p align="center"><strong>A framework and a runtime for agent behavior that doesn't go off the rails.</strong></p>

<p align="center">
  <a href="https://github.com/pythonluvr/openwar/releases"><img src="https://img.shields.io/github/v/release/pythonluvr/openwar?display_name=tag&sort=semver" alt="Latest release"></a>
  <a href="https://github.com/pythonluvr/openwar/actions"><img src="https://img.shields.io/github/actions/workflow/status/pythonluvr/openwar/test.yml?branch=main" alt="Tests"></a>
  <a href="https://www.npmjs.com/package/@pythonluvr/openwar"><img src="https://img.shields.io/npm/v/@pythonluvr/openwar.svg" alt="npm"></a>
  <a href="https://discord.gg/ku6GJS92V2"><img src="https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

OpenWar replaces eager-customer-service-rep defaults with the behavior of a senior peer. It confirms briefs before acting, breaks work into phases, asks before doing anything destructive, and writes like an adult who's busy.

This is WarBit. He runs OpenWar. He does not "happily help you with that."

<p align="center">
  <img src="branding/warbit-story/warbit-04-chaos.png" alt="WarBit buried in TODOs and merge conflicts" width="280" />
  <br />
  <em>Default agent behavior. Sycophantic, eager, drowning in half-finished context.</em>
</p>

You can use OpenWar two ways:

1. **As a runtime** (new in v0.2, expanded in v0.3 with tool calling). Install the package, point it at a brief, watch the phase machine enforce the framework against any BYOK LLM. The runtime is opinionated: no flag to disable Phase 3, no way to skip the Confirmation Summary.
2. **As a system prompt** (v0.1, still supported). Paste [`openwar.md`](./openwar.md) into Claude Code's CLAUDE.md, Cursor's rules, Hermes, OpenClaw, or anywhere else. The agent's behavior changes; nothing else does.

The framework doc and the runtime are the same source of truth. The doc tells the model what to do. The runtime makes sure it actually does it.

<p align="center">
  <img src="branding/warbit-story/warbit-02-daily-intel.png" alt="WarBit at a 'Daily Intel' bulletin board" width="280" />
  <br />
  <em>Phase 0 in one image. What are you shipping today, ops?</em>
</p>

## Try it with zero setup

Three ways to use OpenWar without an API key, a paid call, or even Node:

**1. As a system prompt.** Paste [`openwar.md`](./openwar.md) into Claude Code's CLAUDE.md, Cursor's rules, or any agent's system prompt. The framework activates immediately on whatever model that tool already uses.

```bash
curl -fsSL https://raw.githubusercontent.com/pythonluvr/openwar/main/openwar.md >> ~/.claude/CLAUDE.md
```

**2. Against a local model.** If you already run Ollama, llama.cpp, vLLM, or LM Studio:

```bash
npx @pythonluvr/openwar run examples/creative-brief.md \
  --adapter openai-compat \
  --base-url http://localhost:11434/v1 \
  --model llama3.1
```

**3. Just validate a brief.** No model call, just the framework's lint pass:

```bash
npx @pythonluvr/openwar validate examples/multi-agent-brief.md
```

## Quick start (runtime, BYO cloud key)

```bash
npx @pythonluvr/openwar run examples/creative-brief.md --adapter anthropic
```

Or install:

```bash
npm install -g @pythonluvr/openwar
export ANTHROPIC_API_KEY=...
openwar run examples/engineering-brief.md
```

Provide an API key for whichever adapter you pick:

| Adapter         | Env var                  | Default model         |
|-----------------|--------------------------|-----------------------|
| `anthropic`     | `ANTHROPIC_API_KEY`      | `claude-sonnet-4-6`   |
| `openai`        | `OPENAI_API_KEY`         | `gpt-4o`              |
| `gemini`        | `GEMINI_API_KEY`         | `gemini-2.0-flash`    |
| `grok`          | `XAI_API_KEY`            | `grok-2-latest`       |
| `openai-compat` | `OPENAI_COMPAT_API_KEY`  | (specify with `--base-url`) |

`openai-compat` covers OpenRouter, Groq, Together, Ollama, vLLM, llama.cpp, and anything else speaking OpenAI's chat-completions protocol.

## What the runtime enforces

<p align="center">
  <img src="branding/warbit-story/warbit-05-cockpit.png" alt="WarBit watching a wall of monitors" width="280" />
  <br />
  <em>Every turn passes through deterministic detectors. No second LLM, no judging.</em>
</p>

| Phase   | What happens                                                                                     | What blocks |
|---------|--------------------------------------------------------------------------------------------------|-------------|
| Phase 0 | Agent must produce a Confirmation Summary with Objective / Deliverables / Constraints / Tools / Unknowns. | No execution until the operator accepts. |
| Phase 1 | Agent executes step by step. Gated mode pauses between steps; auto-pilot runs through clean ones. | Banned phrases warn. |
| Phase 2 | If the agent declares it's blocked, the runtime halts the session and persists state. | Resume with `openwar resume <brief_id>`. |
| Phase 3 | If the agent announces intent to do something destructive or out-of-directive, the runtime stops and asks for explicit yes. | Authorization can be pre-approved per category in the brief's `authorized_costs`. |
| Phase 4 | Agent produces a concise completion report. | None. |

If the agent skips the Confirmation Summary, the runtime asks it to restate before letting execution start.

## Tools (new in v0.3)

<p align="center">
  <img src="branding/warbit-story/warbit-06-new-tools.png" alt="WarBit opening a glowing 'New Tools' chest" width="280" />
  <br />
  <em>v0.3 turned OpenWar from "constrained chat wrapper" into "real agent." The runtime now calls tools.</em>
</p>

The runtime ships six native tools plus a hand-rolled MCP client. Every tool call goes through:

1. Schema translation in the adapter to the provider's native function-calling format.
2. Authorization check against the brief's `authorized_costs` and any session-approved categories.
3. Sandbox execution: workdir-bounded paths, timeout enforcement, output caps, HTTP host allowlist.
4. Result fed back to the LLM for the next round.

If a tool requires an unauthorized category, the runtime halts into Phase 3 and prompts for `y` / `Y` / `n` (one-shot, session-wide, deny).

### Native tools

| Name          | Categories required | Notes |
|---------------|---------------------|-------|
| `read_file`   | `filesystem_read`   | Default-allowed. Caps at `max_bytes` (1 MB default). |
| `write_file`  | `filesystem_write`  | Atomic via tmp+rename. Creates parent dirs. |
| `list_dir`    | `filesystem_read`   | Skips `.git`, `node_modules`, etc. Honors `.openwarignore`. |
| `shell_exec`  | `shell_exec`        | SIGTERM then SIGKILL on timeout. `--no-shell` disables entirely. |
| `http_fetch`  | `http_fetch`        | HTTPS only by default. Optional `~/.openwar/http-allow.json` host allowlist. |
| `apply_patch` | `filesystem_write`  | Unified-diff applier. Rolls back on hunk failure. |

List them with `openwar tools`.

### MCP servers

Configure once with `openwar mcp add <name> <command...>` (writes to `~/.openwar/mcp.json`) or per-brief:

```yaml
mcp_servers:
  - filesystem=npx -y @modelcontextprotocol/server-filesystem /allowed/dir
```

Each MCP server's tools auto-register under `<name>:<tool>` and require `mcp_tool:<name>:<tool>` to call. Use `mcp_tool:<name>:*` in `authorized_costs` to pre-approve everything a server exposes.

Test a server before relying on it:

```bash
openwar mcp test filesystem
```

## Multi-agent orchestration (new in v0.4)

When a brief opts into multi-agent by setting `roles:` in its frontmatter, the runtime stops running one agent against the whole brief and instead drives a small team:

- **planner** decomposes the brief into linear sub-tasks with acceptance criteria.
- **executor** runs each sub-task with the full v0.3 tool layer, gated by the brief's `authorized_costs`.
- **reviewer** evaluates the executor's output against the sub-task's acceptance criteria. Read-only file access for verification.
- **critic** (optional fourth role) gives an independent second-opinion review. Disagreement with the reviewer halts the run for an operator decision.

The framework applies recursively. Every role's output passes through the same detectors as a single-agent run. Every sub-task gets its own Phase 0. Phase 2 / Phase 3 fire inside the role that triggered them.

Try it without spending execution tokens first:

```bash
openwar plan examples/multi-agent-brief.md --adapter anthropic
```

Full run:

```bash
openwar run examples/multi-agent-brief.md --adapter anthropic
```

Single-agent mode (omitting `roles:` or passing `--single`) keeps the v0.3 behavior. Sessions from v0.3 resume cleanly under v0.4; the schema migration is automatic.

### Budgets

Briefs may declare cost ceilings in `budgets:`. Hitting any ceiling halts the coordinator cleanly with state persisted; the operator can extend and resume.

```yaml
budgets:
  max_tokens: 80000
  max_wall_clock_minutes: 25
  max_tool_calls_per_subtask: 12
  max_retries_per_subtask: 3
```

Defaults if omitted: 50k tokens, 20 minutes, 15 tool calls per sub-task, 3 retries per sub-task.

## CLI

```text
openwar run <brief.md> [--adapter <id>] [--model <name>] [--mode gated|auto]
                       [--workdir <path>] [--no-shell]
                       [--mcp-server name=command] [--resume] [--ephemeral]
                       [--roles planner,executor,reviewer[,critic]]
                       [--max-tokens N] [--max-minutes N] [--single]
openwar plan <brief.md>                     # planner dry-run; no execution
openwar resume <brief_id>                   # auto-detects single-agent vs multi-agent
openwar list
openwar inspect <brief_id> [--transcript]
openwar validate <brief.md>
openwar roles                                # list registered roles
openwar adapters
openwar tools
openwar mcp list | add <name> <cmd...> | remove <name> | test <name>
openwar version
```

Sessions persist to `~/.openwar/sessions/` as JSON + JSONL transcript. Resume with `openwar resume <brief_id>`. `--ephemeral` skips persistence (used by tests and integrators).

## Use as a library

```ts
import { run, MockAdapter, AnthropicAdapter } from "openwar";

const adapter = new AnthropicAdapter({ id: "anthropic", model: "claude-sonnet-4-6" });
const result = await run({ briefPath: "./brief.md", adapter });

if (!result.completed) {
  console.error(`Halted at ${result.final_phase}: ${result.halt_reason}`);
}
```

War Room and other integrators consume OpenWar this way; the runtime is the framework's enforcement surface.

## Brief format

Briefs are markdown with required frontmatter. A reference template ships at [`templates/brief.md`](./templates/brief.md).

```yaml
---
project: <slug>                    # required, kebab-case
brief_id: YYYY-MM-DD-NNN           # optional; auto-generated if absent
deadline: YYYY-MM-DD               # optional
scope_locked: true|false           # if true, refuse out-of-scope additions
mode: gated|auto                   # optional override of per-step-vs-auto
workdir: ./relative-or-absolute    # optional. All filesystem tools sandboxed here.
authorized_costs:                  # pre-approves these destructive categories
  - filesystem_write
  - shell_exec
  - http_fetch
  - mcp_tool:filesystem
mcp_servers:                       # optional. name=command, one per entry.
  - filesystem=npx -y @modelcontextprotocol/server-filesystem /allowed/dir
---
```

Recognized `authorized_costs` categories: `filesystem_read` (default-allowed), `filesystem_write`, `filesystem_delete`, `shell_exec`, `http_fetch`, `paid_api_call`, `git_write`, `git_push`, `deploy`, `external_message`, plus `mcp_tool:<server>` and `mcp_tool:<server>:<tool>`. Wildcards: `*` matches every category, `mcp_tool:*` matches any MCP tool, `mcp_tool:server:*` matches any tool from a server. `*` triggers a brief-lint warning; almost always you want specific entries.

Body sections: **Objective**, **Deliverables**, **Constraints**, **Tools required**, **Notes / unknowns**.

Validate a brief without running it:

```bash
openwar validate brief.md
```

## Still want just the system prompt?

Paste [`openwar.md`](./openwar.md) into your agent's system prompt. The framework remains a single markdown file. You lose enforcement (the model is on the honor system), but you keep the behavior overlay.

### Claude Code

```bash
mkdir -p ~/.claude
curl -fsSL https://raw.githubusercontent.com/pythonluvr/openwar/main/openwar.md >> ~/.claude/CLAUDE.md
```

### Cursor

Settings → Rules for AI → paste the contents of `openwar.md`.

### War Room

War Room ships OpenWar as its default framework. v0.7+ adopts the runtime; earlier versions used the system prompt only.

## Why both

Behavioral overlays are easy to ignore. A model that's been told "always produce a Confirmation Summary" will sometimes skip it under context pressure or specific phrasing. The runtime catches the skip and asks the model to restate.

System prompts cost nothing to install and work with any runtime. The runtime is heavier, but it actually enforces the rules.

<p align="center">
  <img src="branding/warbit-story/warbit-03-success.png" alt="WarBit celebrating in front of a 'SUCCESS' screen" width="280" />
  <br />
  <em>Phase 4 completion. WarBit ships.</em>
</p>

## Versioning

Current: **v0.4.0**. See [CHANGELOG.md](./CHANGELOG.md) for full release notes.

- v0.1: framework doc only (single markdown file).
- v0.2: runtime, CLI, BYOK adapters for Anthropic, OpenAI, Gemini, Grok, OpenAI-compat.
- v0.3: six native tools (read_file, write_file, list_dir, shell_exec, http_fetch, apply_patch), hand-rolled MCP client, per-adapter tool-call translation, Phase 3 destructive flag for unauthorized tool calls.
- v0.4: multi-agent orchestration. Coordinator FSM, planner / executor / reviewer / critic roles, typed handoffs, per-role tool scoping, budgets, schema v3 with v2 migration, `openwar plan` and `openwar roles` subcommands.
- v0.5: persistent project memory across briefs.
- v0.6: observability dashboards / tracing UI.

Framework doc is versioned with the package. Drop-in upgrades preserve compatibility within a major version; major bumps may rename phases or change the brief format.

## Community

Questions, bug reports, framework discussion: [Discord](https://discord.gg/ku6GJS92V2). Issues and PRs welcome on this repo too.

## License

[MIT](./LICENSE). Use it, modify it, fork it, ship your own variants, paste it into commercial products. No obligations beyond keeping the copyright notice.

## Authorship

OpenWar is the framework that ships inside [War Room](https://github.com/pythonluvr/war-room), authored across many iterations of running real agent work. This standalone repo exists so people who don't use War Room can still adopt the framework.

<p align="center">
  <img src="branding/warbit-story/warbit-01-sunset.png" alt="WarBit sitting in front of a sunset over the city" width="280" />
  <br />
  <em>Issues and PRs welcome. WarBit will read them in the morning.</em>
</p>
