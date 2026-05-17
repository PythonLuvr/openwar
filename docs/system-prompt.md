# Use OpenWar as a system prompt

The framework is a single markdown file. You can use OpenWar without installing the runtime, without an npm package, and without any LLM API integration. Paste `openwar.md` into your agent's system prompt and the behavior changes.

You lose the runtime's enforcement (the model is on the honor system about phase markers and detectors), but you keep the behavioral overlay: confirmation summaries, phase structure, destructive-action discipline, voice rules.

This is how OpenWar v0.1 shipped, and it's still the cheapest way to try it.

## Claude Code

Append the framework doc to your CLAUDE.md:

```bash
mkdir -p ~/.claude
curl -fsSL https://raw.githubusercontent.com/pythonluvr/openwar/main/openwar.md >> ~/.claude/CLAUDE.md
```

The next time you start Claude Code, the agent picks up the framework as part of its system prompt. No restart needed for fresh sessions.

To roll back: edit `~/.claude/CLAUDE.md` and remove the appended section.

## Cursor

1. Open Settings -> Rules for AI
2. Paste the contents of [`openwar.md`](https://raw.githubusercontent.com/pythonluvr/openwar/main/openwar.md)
3. Save

The framework applies to every Cursor chat thereafter. Disable by clearing the rules field.

## Codex CLI

Same shape as Claude Code: append to the system prompt config. Codex's exact config path varies by version. See its docs.

## aider

Add `openwar.md` to your prompt sources via aider's chat-history mechanism, or paste the contents into a system message at the start of each session.

## Generic CLI agent

Most CLI agents accept either a system-prompt file path or a string at startup. Point them at `openwar.md` or its raw URL.

## War Room

War Room ships OpenWar as its default framework, no setup needed. Per-channel framework selection in the channel header chip.

## When to graduate to the runtime

The system-prompt path is great for trying OpenWar. Move to the runtime (`@pythonluvr/openwar` npm package) when:

- You want the runtime to actually catch missed phase markers and ask the model to restate.
- You want native tool calling, MCP support, or the sandbox.
- You want multi-agent orchestration with a coordinator FSM.
- You want session persistence and resume.
- You want budgets, tier-aware cost preview, or cli-bridge.

See [cli.md](./cli.md) and the main [README](../README.md) for runtime setup.

## Why both paths exist

Behavioral overlays are easy for a model to ignore. A model that's been told "always produce a Confirmation Summary" will sometimes skip it under context pressure or specific phrasing. The runtime catches the skip and asks the model to restate.

System prompts cost nothing to install and work with any LLM. The runtime is heavier (Node, npm, brief files), but it actually enforces the rules. Pick whichever fits the moment.
