<p align="center">
  <img src="openwar-logo.png" alt="OpenWar" width="160" height="160" />
</p>

<h1 align="center">OpenWar</h1>

<p align="center"><strong>Talk to your agent. The runtime keeps the phases honest, the destructives gated, and the trace intact.</strong></p>

<p align="center">
  <a href="https://github.com/pythonluvr/openwar/releases"><img src="https://img.shields.io/github/v/release/pythonluvr/openwar?display_name=tag&sort=semver" alt="Latest release"></a>
  <a href="https://github.com/pythonluvr/openwar/actions"><img src="https://img.shields.io/github/actions/workflow/status/pythonluvr/openwar/test.yml?branch=main" alt="Tests"></a>
  <a href="https://www.npmjs.com/package/@pythonluvr/openwar"><img src="https://img.shields.io/npm/v/@pythonluvr/openwar.svg" alt="npm"></a>
  <a href="https://discord.gg/ku6GJS92V2"><img src="https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
</p>

`openwar chat` is the front door. Describe what you want in plain English; OpenWar asks clarifying questions when it needs to, proposes a plan, gets your approval, and executes through the same phase-gated runtime that hand-authored briefs use. No YAML required to start.

Underneath the conversation is the discipline layer. Every assistant turn passes through deterministic detectors. Every destructive action stops at an operator gate. Every tool call writes to a replayable trace. The agent does not get smarter; it gets harder to derail.

## Start with a conversation

If you have a BYOK API key (Anthropic, OpenAI, Gemini, Grok, or any OpenAI-compatible endpoint):

```bash
export ANTHROPIC_API_KEY=...
openwar chat
```

A turn looks like this:

```text
> read src/auth.ts and tell me the three biggest holes you see
Reading src/auth.ts (412 lines)... three issues. Want me to draft a brief
that patches them, or just print the list?
```

OpenWar asks clarifying questions if the request is ambiguous, proposes a plan, gets your approval, executes through the phase machine, and asks again before any destructive action (a write, a shell command, an HTTP fetch). At the end, optionally save the conversation as a reusable brief. The trace at `~/.openwar/sessions/<id>.trace.ndjson` records the whole thing.

Hand-authored briefs (`openwar run brief.md`) keep working unchanged for power users. Full chat docs: [`docs/chat.md`](./docs/chat.md).

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

<p align="center">
  <img src="branding/warbit-story/warbit-02-daily-intel.png" alt="WarBit at a 'Daily Intel' bulletin board" width="280" />
  <br />
  <em>Phase 0 in one image. What are you shipping today, ops?</em>
</p>

## Quick start with a local CLI agent

If you already have Claude Code, Codex CLI, Gemini CLI, aider, or any other agent CLI on your machine, OpenWar can drive it. No cloud key, no extra subscription, the CLI uses whatever auth it already has.

```bash
npx @pythonluvr/openwar run examples/cli-bridge-brief.md \
  --adapter cli-bridge \
  --cli-binary claude
```

OpenWar spawns the binary, pipes the prompt in via stdin, applies the phase machine to its output. Same CLI agent you use today, now operating-disciplined. The brief needs `shell_exec` in `authorized_costs` because every cli-bridge invocation shells out a child process.

Swap `claude` for `gemini`, `codex`, or any other binary on PATH. See [docs/adapters.md](./docs/adapters.md) for the full cli-bridge config.

## Quick start with a cloud key

```bash
npx @pythonluvr/openwar run examples/creative-brief.md --adapter anthropic
```

Or install globally:

```bash
npm install -g @pythonluvr/openwar
export ANTHROPIC_API_KEY=...
openwar run examples/engineering-brief.md
```

Available adapters: `anthropic`, `openai`, `gemini`, `grok`, `openai-compat`. Full adapter details + env vars in [docs/adapters.md](./docs/adapters.md).

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

## Documentation

| Topic | Doc |
|---|---|
| The framework itself (paste this anywhere) | [`openwar.md`](./openwar.md) |
| Full CLI reference + flags | [`docs/cli.md`](./docs/cli.md) |
| Brief format (YAML schema + categories) | [`docs/brief-format.md`](./docs/brief-format.md) |
| Adapters (Anthropic, OpenAI, Gemini, Grok, openai-compat, cli-bridge) | [`docs/adapters.md`](./docs/adapters.md) |
| Native tools and MCP | [`docs/tools.md`](./docs/tools.md) |
| PermissionBridge (v0.12+) | [`docs/permissions.md`](./docs/permissions.md) |
| OpenAI-compatible proxy (v0.13+) | [`docs/openai-proxy.md`](./docs/openai-proxy.md) |
| Observability and tracing (v0.8+) | [`docs/observability.md`](./docs/observability.md) |
| Learning from run history (v0.9+) | [`docs/learning.md`](./docs/learning.md) |
| Chat (v0.10+) | [`docs/chat.md`](./docs/chat.md) |
| Multi-agent orchestration (roles, budgets, per-role adapter mixing) | [`docs/multi-agent.md`](./docs/multi-agent.md) |
| Use OpenWar as a library (TypeScript) | [`docs/library.md`](./docs/library.md) |
| System-prompt-only path (no install) | [`docs/system-prompt.md`](./docs/system-prompt.md) |
| Reference briefs you can run end-to-end | [`examples/`](./examples) |
| Full release notes per version | [`CHANGELOG.md`](./CHANGELOG.md) |

## Why both a framework AND a runtime

Behavioral overlays are easy to ignore. A model that's been told "always produce a Confirmation Summary" will sometimes skip it under context pressure or specific phrasing. The runtime catches the skip and asks the model to restate.

System prompts cost nothing to install and work with any agent. The runtime is heavier, but it actually enforces the rules.

<p align="center">
  <img src="branding/warbit-story/warbit-04-chaos.png" alt="WarBit buried in TODOs and merge conflicts" width="280" />
  <br />
  <em>Default agent behavior. Sycophantic, eager, drowning in half-finished context. The runtime is what stops this.</em>
</p>

<p align="center">
  <img src="branding/warbit-story/warbit-03-success.png" alt="WarBit celebrating in front of a 'SUCCESS' screen" width="280" />
  <br />
  <em>Phase 4 completion. WarBit ships.</em>
</p>

## What OpenWar is not

Not a smarter model. OpenWar runs on top of whatever agent you already use: a local CLI agent (Claude Code, Codex CLI, Gemini CLI, aider) via the cli-bridge adapter, or any BYOK API (Anthropic, OpenAI, Gemini, Grok, or openai-compat for local Ollama and vLLM). The model's reasoning quality is the model's problem.

Not a self-modifying agent. The framework can propose adjustments to its own behavior (`openwar learn`), but the operator commits the change. The agent never edits the rules that constrain the agent.

Not an autonomous-agent platform. OpenWar's whole design assumes the operator is in the loop. Auto-pilot mode just makes the loop quieter; it never removes the operator's right to stop the run.

## Versioning

Current: **v0.11.0**. Full version history and release notes in [CHANGELOG.md](./CHANGELOG.md).

Drop-in upgrades preserve compatibility within a major version. Major bumps may rename phases or change the brief format.

## Community

Questions, bug reports, framework discussion: [Discord](https://discord.gg/ku6GJS92V2). Issues and PRs welcome on this repo too.

## Powered by

As of v0.11, OpenWar's `cli-bridge` adapter runs on top of **[@pythonluvr/squire](https://github.com/PythonLuvr/squire)**, a standalone npm package extracted from this codebase. Squire owns the cross-platform subprocess spawn, MCP tool forwarding, and Claude Code permission auto-setup; OpenWar layers phase gates, traces, and replayable execution on top. If you only need the CLI-agent runtime layer, you can use Squire directly.

## License

[MIT](./LICENSE). Use it, modify it, fork it, ship your own variants, paste it into commercial products. No obligations beyond keeping the copyright notice.

## Authorship

OpenWar is the framework that ships inside [War Room](https://github.com/pythonluvr/war-room), authored across many iterations of running real agent work. This standalone repo exists so people who don't use War Room can still adopt the framework.

<p align="center">
  <img src="branding/warbit-story/warbit-01-sunset.png" alt="WarBit sitting in front of a sunset over the city" width="280" />
  <br />
  <em>Issues and PRs welcome. WarBit will read them in the morning.</em>
</p>
