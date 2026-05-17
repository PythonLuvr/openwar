---
project: cli-bridge-demo
brief_id: 2026-05-17-CLI1
scope_locked: true
mode: gated
authorized_costs:
  - filesystem_read
  - shell_exec
---

# Bridge OpenWar to a local CLI agent

## Objective

Demonstrate the v0.5 cli-bridge adapter. OpenWar delegates the brief to a
locally installed CLI agent (Claude Code in this example), captures stdout,
runs the deterministic detectors against it, and applies the phase machine.

This brief is intentionally trivial so the bridge can be exercised end-to-end
without spending tokens on a complex task. Swap in your own brief once the
plumbing works.

## Deliverables

1. Read `package.json` (single file).
2. Report the package name and version in one short paragraph.
3. Phase 4 completion.

## Constraints

- Use only `filesystem_read` from OpenWar's authorized_costs. The bridged
  CLI may have its own tool list; OpenWar does not relitigate it.
- Do not write any files. This is a read-only demo.
- Keep output under 200 words.

## Tools required

- `claude` (Claude Code) installed and on PATH. Substitute any other CLI
  agent by passing `--cli-binary` at runtime.

## Notes / unknowns

Run from this repo's root so `package.json` exists in the workdir:

```bash
npx @pythonluvr/openwar run examples/cli-bridge-brief.md \
  --adapter cli-bridge \
  --cli-binary claude
```

Or with a different CLI agent (Codex, Gemini, aider, your own custom binary):

```bash
npx @pythonluvr/openwar run examples/cli-bridge-brief.md \
  --adapter cli-bridge \
  --cli-binary gemini \
  --cli-arg "--text-input"
```

The framework doc gets prepended to the prompt by default so the bridged CLI
behaves like an OpenWar-aware agent. Pass `--cli-no-framework` to skip that
prepend if your CLI already has OpenWar in its own system prompt.
