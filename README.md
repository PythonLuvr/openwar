<p align="center">
  <img src="openwar-logo.png" alt="OpenWar" width="160" height="160" />
</p>

<h1 align="center">OpenWar</h1>

<p align="center"><strong>A framework and a runtime for agent behavior that doesn't go off the rails.</strong></p>

OpenWar replaces eager-customer-service-rep defaults with the behavior of a senior peer. It confirms briefs before acting, breaks work into phases, asks before doing anything destructive, and writes like an adult who's busy.

You can use it two ways:

1. **As a runtime** (new in v0.2). Install the package, point it at a brief, watch the phase machine enforce the framework against any BYOK LLM. The runtime is opinionated: no flag to disable Phase 3, no way to skip the Confirmation Summary.
2. **As a system prompt** (v0.1, still supported). Paste [`openwar.md`](./openwar.md) into Claude Code's CLAUDE.md, Cursor's rules, Hermes, OpenClaw, or anywhere else. The agent's behavior changes; nothing else does.

The framework doc and the runtime are the same source of truth. The doc tells the model what to do. The runtime makes sure it actually does it.

## Quick start (runtime)

```bash
npx pythonluvr/openwar run examples/creative-brief.md --adapter anthropic
```

Or install:

```bash
npm install -g pythonluvr/openwar
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

| Phase   | What happens                                                                                     | What blocks |
|---------|--------------------------------------------------------------------------------------------------|-------------|
| Phase 0 | Agent must produce a Confirmation Summary with Objective / Deliverables / Constraints / Tools / Unknowns. | No execution until the operator accepts. |
| Phase 1 | Agent executes step by step. Gated mode pauses between steps; auto-pilot runs through clean ones. | Banned phrases warn. |
| Phase 2 | If the agent declares it's blocked, the runtime halts the session and persists state. | Resume with `openwar resume <brief_id>`. |
| Phase 3 | If the agent announces intent to do something destructive or out-of-directive, the runtime stops and asks for explicit yes. | Authorization can be pre-approved per category in the brief's `authorized_costs`. |
| Phase 4 | Agent produces a concise completion report. | None. |

The phase loop is enforced by deterministic pattern detectors. No second LLM, no judging. If the agent skips the Confirmation Summary, the runtime asks it to restate before letting execution start.

## Tools (new in v0.3)

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

## CLI

```text
openwar run <brief.md> [--adapter <id>] [--model <name>] [--mode gated|auto]
                       [--workdir <path>] [--no-shell]
                       [--mcp-server name=command] [--resume] [--ephemeral]
openwar resume <brief_id>
openwar list
openwar inspect <brief_id> [--transcript]
openwar validate <brief.md>
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
workdir: ./relative-or-absolute   # optional. All filesystem tools sandboxed here.
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

War Room ships OpenWar as its default framework. v0.5+ adopts the runtime; earlier versions used the system prompt only.

## Why both

Behavioral overlays are easy to ignore. A model that's been told "always produce a Confirmation Summary" will sometimes skip it under context pressure or specific phrasing. The runtime catches the skip and asks the model to restate.

System prompts cost nothing to install and work with any runtime. The runtime is heavier, but it actually enforces the rules.

## Versioning

Current: **v0.2.0** (runtime + framework doc).

- v0.2: runtime, CLI, BYOK adapters for Anthropic / OpenAI / Gemini / Grok / OpenAI-compat.
- v0.3: CLI-bridge adapters (claude-cli, codex-cli), MCP tool calling.
- v0.4: multi-agent / boardroom orchestration.

Framework doc is versioned with the package. Drop-in upgrades preserve compatibility within a major version; major bumps may rename phases or change the brief format.

## License

[MIT](./LICENSE).

## Authorship

OpenWar is the framework that ships inside [War Room](https://github.com/pythonluvr/war-room), authored across many iterations of running real agent work. This standalone repo exists so people who don't use War Room can still adopt the framework.

Issues and PRs welcome.
