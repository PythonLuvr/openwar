# Multi-agent orchestration

When a brief opts into multi-agent mode by setting `roles:` in its frontmatter, the runtime stops running one agent against the whole brief and instead drives a small team of role-scoped agents through a coordinator FSM.

## Built-in roles

- **planner** decomposes the brief into a linear ordered list of sub-tasks with acceptance criteria. No tool access.
- **executor** runs each sub-task with the full native-tool layer, gated by the brief's `authorized_costs`. Standard Phase 3 gates apply.
- **reviewer** evaluates the executor's output against each sub-task's acceptance criteria. Read-only filesystem access for verification. Emits `pass`, `fail`, or `needs_retry`.
- **critic** (optional fourth role) gives an independent second-opinion review. Runs after the reviewer. Disagreement halts the coordinator into Phase 2 for an operator decision.

The framework applies recursively. Every role's output passes through the same detectors as a single-agent run. Every executor sub-task gets its own Phase 0 (confirm the sub-task, then execute). Phase 2 (blocker) and Phase 3 (destructive flag) fire inside the role that triggered them and propagate up to the coordinator.

## Enabling multi-agent mode

Two shapes are accepted in `roles:`.

### Flat list (v0.4+)

```yaml
roles:
  - planner
  - executor
  - reviewer
```

All roles use the run-wide `--adapter` (or the default `anthropic`). Simplest case.

### Map with per-role adapter overrides (v0.5.1+)

```yaml
roles:
  planner:
    adapter: anthropic
    model: claude-haiku-4-5
  executor:
    adapter: cli-bridge
    binary: claude
  reviewer:
    adapter: anthropic
    model: claude-haiku-4-5
```

The canonical case: cheap API for planning and review, local CLI agent for execution. The bill drops 80% on workloads where the executor is doing most of the work, because Haiku is roughly 1/10 the price of Sonnet per token.

Roles omitted from the map fall back to the run-wide `--adapter` default. The flat-list shape still works for briefs that don't need overrides.

## Coordinator states

```
init -> plan -> dispatch -> execute -> review_step ->
  next_subtask -> dispatch (next) | complete
any -> block | escalate
```

The coordinator persists its state after every transition. Resuming a halted run picks up at the next state without replay.

## Dry-running the planner

To see the plan a brief would produce without spending tokens on execution:

```bash
openwar plan examples/multi-agent-brief.md --adapter anthropic
```

This calls the planner only, prints the sub-task decomposition, and exits. Useful for checking that the brief is decomposable in the way you expect before committing to a full run.

Full run:

```bash
openwar run examples/multi-agent-brief.md --adapter anthropic
```

## Handoffs

Roles communicate via typed JSON handoffs (`plan`, `execution`, `review`, `escalation`) emitted as fenced JSON blocks at the end of the role's reply. The coordinator validates each handoff against a strict schema. Malformed handoffs trigger one retry, then escalation.

## Budgets

Briefs may set per-run cost ceilings:

```yaml
budgets:
  max_tokens: 80000
  max_wall_clock_minutes: 25
  max_tool_calls_per_subtask: 12
  max_retries_per_subtask: 3
```

Defaults if omitted: 50k tokens, 20 minutes, 15 tool calls per sub-task, 3 retries per sub-task.

Hitting any ceiling halts the coordinator cleanly. State persists; the operator can extend the budget and resume:

```bash
openwar resume <brief_id> --max-tokens 120000
```

## Role scope versus brief authorization

Two independent checks gate every tool call in multi-agent mode:

1. **Role scope** (structural): does the role's allowlist include this tool's category? Failure here is a programming error (coordinator routed a call to the wrong role) and halts the run with no operator prompt.
2. **Brief authorization** (operator decision): does the brief's `authorized_costs` cover the tool's categories? Failure here triggers the standard Phase 3 prompt for explicit per-session approval.

## Custom roles

You can register additional roles at runtime via `registerRole()` from `src/roles/registry.ts`. A role definition specifies:

```ts
interface RoleDefinition {
  id: string;
  description: string;
  prompt_overlay: string;        // system-prompt addition on top of openwar.md
  tool_categories: string[];      // structural allowlist (wildcards OK)
  allow_read_file?: boolean;
}
```

Briefs reference custom roles by id in their `roles:` list. The coordinator dispatches to them the same way as built-ins.

## Single-agent mode

Omitting `roles:` (or passing `--single`) keeps the v0.3 behavior: one agent, no coordinator, native tools and authorization model unchanged. v0.4+ sessions are backward-compatible; v0.3 sessions can resume cleanly under the v0.4 runtime.

## Example briefs

- `examples/multi-agent-brief.md`: three-role static-site generator
- `examples/critic-disagreement-brief.md`: four-role flow exercising the critic
- `examples/per-role-adapters-brief.md`: adapter mixing per role
- `examples/cli-bridge-multi-agent-brief.md`: coordinator driving cli-bridge across every role
