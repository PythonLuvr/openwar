# OpenWar example briefs

Two reference briefs you can run end-to-end against any configured adapter.

## creative-brief.md

A copywriting task with gated execution. Demonstrates:

- Frontmatter with `scope_locked: false` and `mode: gated`.
- An `authorized_costs: [generation_credits]` pre-approval so the agent does not flag every word it produces as destructive.
- Soft constraints expressed in plain language (no em dashes, no filler openers).

Run it:

```bash
npx openwar run examples/creative-brief.md --adapter anthropic
```

In gated mode the runner pauses after each step. Press Enter or type `ok` to continue. Type `done` to stop early.

## engineering-brief.md

A code task with auto-pilot execution and a locked scope. Demonstrates:

- `scope_locked: true` so out-of-scope additions get refused without renegotiation.
- `mode: auto` so the agent moves through clean steps without waiting on the operator.
- `authorized_costs: [filesystem_write]` so writes do not trip the destructive flag, but git pushes, deploys, and process kills still do.

Run it:

```bash
export OPENAI_API_KEY=sk-...
npx openwar run examples/engineering-brief.md --adapter openai --model gpt-4o
```

## Inspecting after the run

```bash
openwar list                          # show recent sessions
openwar inspect <brief_id>            # show session metadata
openwar inspect <brief_id> --transcript   # full back-and-forth
```

Sessions persist to `~/.openwar/sessions/`. Resume with `openwar resume <brief_id>`.
