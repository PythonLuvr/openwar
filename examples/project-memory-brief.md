---
project: project-memory-demo
brief_id: 2026-05-17-PMD
scope_locked: true
mode: gated
authorized_costs:
  - filesystem_read
  - filesystem_write
inherit_memory: true
budgets:
  max_tokens: 30000
  max_wall_clock_minutes: 10
---

# Project memory demo (v0.6)

## Objective

Demonstrate the v0.6 persistent project memory loop end to end:

1. The agent reads any existing memory at session start via `inherit_memory: true`.
2. The agent makes a decision during execution and writes it to `decisions` via `write_project_memory`.
3. The agent adds a constraint that future briefs should respect.
4. The next brief against the same `project:` slug sees the entry without operator intervention.

Run this twice. The second run starts with non-empty memory; the agent should notice and reference it.

## Deliverables

A single completion report that explicitly:

- Lists what was in memory at session start (zero on the first run, non-zero on the second).
- Records one new `decisions` entry summarising the choice between two equally valid options the agent picks during the run.
- Records one new `constraints` entry that captures a rule future briefs should respect.

Both writes use the native `write_project_memory` tool. No manual file editing.

## Constraints

- Cap on `inherit_memory` injection is 20 entries per category. Do not assume the full history is visible on a long-running project.
- Memory is per-project. Cross-project context is out of scope; do not attempt to read another project's memory.
- Decisions are visible only to planner / reviewer / critic in multi-agent runs. This brief is single-agent so the full view is in play.

## Tools required

- `read_project_memory` (default-allowed via `filesystem_read`).
- `write_project_memory` (requires `filesystem_write`, which this brief authorizes).

## Notes / unknowns

Run from this repo's root:

```bash
export ANTHROPIC_API_KEY=...
npx @pythonluvr/openwar run examples/project-memory-brief.md --adapter anthropic
```

Inspect the resulting memory between runs:

```bash
npx @pythonluvr/openwar memory list project-memory-demo
npx @pythonluvr/openwar memory show project-memory-demo <entry_id>
```

Reset for a clean second-run demo:

```bash
npx @pythonluvr/openwar memory remove project-memory-demo <entry_id>
# or just rm -rf ~/.openwar/projects/project-memory-demo
```

Multi-agent variant (executor's view omits `decisions`):

```yaml
roles:
  planner:
    adapter: anthropic
    model: claude-haiku-4-5
  executor:
    adapter: anthropic
  reviewer:
    adapter: anthropic
    model: claude-haiku-4-5
```

The reviewer can still raise prior-decision concerns because reviewer has the full view. The executor solves the current sub-task without bias from past decisions.
