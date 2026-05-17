---
project: cli-bridge-multi-demo
brief_id: 2026-05-17-CLIM
scope_locked: true
mode: gated
authorized_costs:
  - filesystem_read
  - shell_exec
roles:
  - planner
  - executor
  - reviewer
budgets:
  max_tokens: 30000
  max_wall_clock_minutes: 10
---

# Multi-agent run with a bridged CLI

## Objective

Run the multi-agent coordinator (v0.4) where every role uses the same
cli-bridge adapter. The whole run delegates to a single local CLI agent
(Claude Code by default). The phase machine + deterministic detectors run
against the CLI's stdout for each role.

This is the single-adapter shape of the bridge in v0.5. Per-role adapter
mixing (planner on a cheap API, executor on a CLI) lands in v0.5.1; until
then, pick one adapter for the whole brief.

## Deliverables

A two-sub-task plan:
1. List the files in `examples/`.
2. Describe what each example brief covers in one short paragraph.

Both sub-tasks pass review. Phase 4 wraps with a one-paragraph summary.

## Constraints

- Read-only filesystem. No writes.
- Reviewer verifies executor claims against the files, not just the
  executor's word.
- The bridged CLI handles tool calls in its own way (its own approval
  prompts, its own MCP servers); OpenWar does not relitigate them.

## Tools required

- A CLI agent installed and on PATH (default: `claude`).

## Notes / unknowns

Run from this repo's root:

```bash
npx @pythonluvr/openwar run examples/cli-bridge-multi-agent-brief.md \
  --adapter cli-bridge \
  --cli-binary claude
```

The cost-tier preview before Phase 0 will show the run as `tier=free`
because cli-bridge defaults to free (local subscription). The framework
doc gets prepended to every role invocation so the CLI is OpenWar-aware
even without changes to its own config.

When per-role adapter mixing ships in v0.5.1 the brief format extends to
let planner / reviewer use a cheap API while executor stays on the CLI.
The shape is still being designed; do not depend on the syntax landing
exactly as drafted in the framework doc.
