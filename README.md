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

## CLI

```text
openwar run <brief.md> [--adapter <id>] [--model <name>] [--mode gated|auto]
                       [--resume] [--ephemeral]
openwar resume <brief_id>
openwar list
openwar inspect <brief_id> [--transcript]
openwar validate <brief.md>
openwar adapters
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
authorized_costs:                  # pre-approves these destructive categories
  - filesystem_write
  - generation_credits
  - git_push
---
```

Recognized `authorized_costs` categories include `filesystem_delete`, `git_history_rewrite`, `git_push`, `deploy`, `external_message`, `paid_api`, `package_change`, `ci_modify`, `process_kill`. Use `*` to authorize everything (rarely a good idea).

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
