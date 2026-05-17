---
project: per-role-adapters-demo
brief_id: 2026-05-17-PRA
scope_locked: true
mode: gated
authorized_costs:
  - filesystem_read
  - shell_exec
roles:
  planner:
    adapter: anthropic
    model: claude-haiku-4-5
  executor:
    adapter: cli-bridge
    binary: claude
    tier: free
  reviewer:
    adapter: anthropic
    model: claude-haiku-4-5
budgets:
  max_tokens: 40000
  max_wall_clock_minutes: 12
---

# Per-role adapter mixing demo (v0.5.1)

## Objective

Show the v0.5.1 shape: planner and reviewer run on a cheap API model
(Claude Haiku) while the executor delegates to Claude Code via the cli-bridge
adapter. The coordinator threads the right adapter to each role; the phase
machine and detectors run uniformly against every role's output.

The point of mixing: planning and review are cheap reasoning tasks that don't
need a local CLI's session memory, while the executor benefits from a long-lived
CLI session for filesystem and shell work.

## Deliverables

A two-sub-task plan executed end to end:
1. List the files in `examples/` (executor uses cli-bridge).
2. Write a one-paragraph summary of what each example covers (executor reuses
   the CLI session; reviewer back on the API).

Both sub-tasks must pass review. Phase 4 wraps with a brief summary.

## Constraints

- Read-only filesystem; no writes from any role.
- Reviewer is on a different adapter than the executor by design, so reviewer
  cannot accidentally reuse the executor's CLI session memory.
- Per-role adapter overrides require `shell_exec` in authorized_costs whenever
  any role uses cli-bridge. The validator enforces this.

## Tools required

- `ANTHROPIC_API_KEY` set in the environment.
- `claude` CLI installed and on PATH for the executor role.

## Notes / unknowns

Run from this repo's root:

```bash
export ANTHROPIC_API_KEY=...
npx @pythonluvr/openwar run examples/per-role-adapters-brief.md
```

The cost-tier preview before Phase 0 lists each role's adapter and tier
separately so the operator sees the cost shape before any agent call goes out.
A run typically looks like:

```
Adapter: anthropic  model: claude-sonnet-4-6  tier: paid  (this run may incur API charges)
Per-role adapters:
  planner    anthropic  model: claude-haiku-4-5  tier: paid
  executor   cli-bridge  model: claude  tier: free
  reviewer   anthropic  model: claude-haiku-4-5  tier: paid
```

The top-level adapter is still required (it's the fallback for any role without
an override, even when none exist). Pass `--adapter anthropic` if you want the
runner to surface charges instead of silently defaulting.

Resuming a run rebuilds the per-role adapters from the persisted
`role_adapter_ids` map in the session file; you don't need to re-pass
flags.
