<p align="center">
  <img src="openwar-logo.png" alt="OpenWar" width="160" height="160" />
</p>

<h1 align="center">OpenWar</h1>

<p align="center"><strong>The framework that ships in <a href="https://github.com/pythonluvr/war-room">War Room</a>. Use it anywhere.</strong></p>

OpenWar is a system prompt that turns any LLM-based agent (Claude, GPT, Gemini, others) into something that behaves like a senior peer instead of a customer service rep. It confirms briefs before acting, breaks work into phases, asks before doing anything destructive, and writes like an adult who's busy.

It's a single markdown file. Drop it into your agent's system prompt, Claude Code's `CLAUDE.md`, Cursor's settings, Hermes config, OpenClaw skills, anywhere, and your agent's behavior changes.

## What's in it

- **Phase architecture**: every task moves through Brief Intake → Execution → (Blocker / Destructive Flag) → Completion. Operators can interrupt at any phase.
- **Confirmation Summary**: agent never starts work without acknowledging what it heard.
- **Per-step vs auto-pilot mode**: operators pick how much gating they want; agents respect it.
- **Hard rules against** invented next steps, hallucinated capabilities, unauthorized actions, blind retries past blockers.
- **Pre-mortem trigger** for strategic / problem-solving / creative / cost-spending work.
- **Voice rules**: banned filler phrases ("Certainly", "Absolutely", "leverage"...), peer-level tone.
- **"Best solution, not the fast one"**: agent leads with the gold-standard path by default, not stopgaps.

Read the full framework: [`openwar.md`](./openwar.md).

## Install

### Claude Code

Append OpenWar to your global CLAUDE.md so every Claude Code session loads it automatically:

```bash
mkdir -p ~/.claude
curl -fsSL https://raw.githubusercontent.com/pythonluvr/openwar/main/openwar.md >> ~/.claude/CLAUDE.md
```

Or for a single project:

```bash
curl -fsSL https://raw.githubusercontent.com/pythonluvr/openwar/main/openwar.md >> ./CLAUDE.md
```

### Cursor

Cursor → Settings → Rules for AI → paste the contents of [`openwar.md`](./openwar.md).

### War Room

War Room ships OpenWar as the bundled default framework. Toggle in `Settings → Agent → Framework`. Nothing to install, it's already there.

### Anything else (Hermes, OpenClaw, custom)

Whatever your runtime calls "system prompt" or "preamble", paste the contents of `openwar.md` in.

## Why does this exist

Default agent behavior (eager, sycophantic, prone to surprise actions) produces bad outcomes for serious work. You ship the wrong thing because the agent didn't confirm what you meant. You discover paid API spend you didn't authorize. You get "I'd be happy to help you with that!" instead of an actual answer.

OpenWar replaces those defaults with the behavior of a senior peer. The agent reads your brief, says "here's what I heard, confirm?", and waits. It writes like an adult. It stops when it hits something it can't resolve instead of guessing. It tells you when something is outside what you asked for.

It's not magic. It's a system prompt. But it's a system prompt that's been battle-tested across thousands of real freelance / dev / creative tasks and refined to remove the failure modes that kept showing up.

## Variants

The default is `openwar.md`, the full framework with all phases, hard rules, and triggers. Future variants will live in [`variants/`](./variants/):

- `openwar-strict.md`: adds aggressive confirmation gating; useful for high-stakes / production work
- `openwar-light.md`: drops the pre-mortem trigger and brief format requirement; useful for casual chat / quick questions

(Empty for now, ships when stable.)

## Templates

[`templates/brief.md`](./templates/brief.md) is a reference brief in OpenWar's format. Copy it when starting new tasks; the frontmatter fields drive how the agent gates execution.

## License

[MIT](./LICENSE). Use it, modify it, fork it, ship your own variants, paste it into commercial products. No obligations beyond keeping the copyright notice.

## Authorship

OpenWar is the framework that ships inside [War Room](https://github.com/pythonluvr/war-room), authored over many iterations of running real agent work. This standalone repo exists so people who don't use War Room can still adopt the framework.

Issues + PRs welcome.
