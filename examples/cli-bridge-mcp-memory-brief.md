---
project: cli-bridge-mcp-memory-demo
brief_id: 2026-05-17-CMMD
scope_locked: true
mode: gated
authorized_costs:
  - filesystem_read
  - filesystem_write
  - shell_exec
inherit_memory: true
cli:
  mcp_forward: true
budgets:
  max_tokens: 40000
  max_wall_clock_minutes: 15
---

# cli-bridge MCP-server-mode + project memory demo (v0.7)

## Objective

End-to-end validation of v0.7 MCP-server-mode. The bridged Claude Code spawns
OpenWar's MCP server as a subprocess; the agent's calls to
`openwar:write_project_memory` and `openwar:read_project_memory` round-trip
through OpenWar's auth gate and land in `~/.openwar/projects/cli-bridge-mcp-memory-demo/`.

The loop the operator should observe:

1. On the first run, the bridged Claude Code sees an empty memory inherited
   into its system prompt (per `inherit_memory: true`).
2. The agent makes a decision during execution and calls
   `openwar:write_project_memory` to record it.
3. The OpenWar runtime authorizes the call (because `filesystem_write` is in
   `authorized_costs`), executes it in the sandboxed tool layer, and logs the
   call to the per-session JSONL.
4. On session end, the runtime folds the JSONL into the transcript with
   `meta.via = "mcp_bridge"`.
5. On the second run, the inherited memory is non-empty; the agent should
   notice and reference its prior decision.

## Deliverables

A completion report that:

- Lists what was in memory at session start.
- Records one new `decisions` entry via `openwar:write_project_memory`.
- Records one new `constraints` entry via the same tool.
- Confirms both entries land in the OpenWar transcript with `meta.via = "mcp_bridge"`
  (visible via `openwar inspect <brief_id> --transcript`).

## Constraints

- The bridged Claude Code has its own permission system. Pre-authorize the
  brief's filesystem paths in Claude Code's permission settings before running,
  or the bridged agent will declare Phase 2 when its own permission layer
  rejects writes the OpenWar brief authorized. The brief-validator emits a
  warning about this at `openwar validate` time.
- This brief uses the cli-bridge adapter at the top level. To verify the
  per-role variant, swap `roles:` to the v0.5.1 nested-map shape and pin
  executor to cli-bridge while planner / reviewer use a cheap API.

## Tools required

- `claude` on PATH (npm i -g @anthropic-ai/claude-code installs as `claude.cmd`
  on Windows; v0.6.2's PATHEXT fix resolves it as just `claude`).
- ANTHROPIC_API_KEY in the env for any non-cli-bridge role (none in this
  single-adapter brief).

## Notes / unknowns

Run from this repo's root:

```bash
npx @pythonluvr/openwar run examples/cli-bridge-mcp-memory-brief.md \
  --adapter cli-bridge \
  --cli-binary claude \
  --mode auto
```

Inspect the captured MCP-mediated tool calls in the transcript:

```bash
npx @pythonluvr/openwar inspect cli-bridge-mcp-memory-demo-<id> --transcript
```

Inspect the persisted memory:

```bash
npx @pythonluvr/openwar memory list cli-bridge-mcp-memory-demo
```

Opt out of MCP forwarding to verify the fallback (bridged Claude Code's own
tools only, no `openwar:*` calls; the brief deliberately asks for one and
should fail with the bridged agent declaring Phase 2):

```yaml
cli:
  mcp_forward: false
```
