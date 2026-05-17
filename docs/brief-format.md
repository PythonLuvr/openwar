# Brief format

Briefs are markdown files with YAML frontmatter. The frontmatter declares the project, authorization scope, and orchestration shape. The markdown body holds the actual instructions for the agent. A reference template ships at [`templates/brief.md`](../templates/brief.md).

## Frontmatter schema

```yaml
---
project: <slug>                    # required, kebab-case (lowercase + digits + hyphens)
brief_id: YYYY-MM-DD-NNN           # optional; auto-generated if absent
deadline: YYYY-MM-DD               # optional
scope_locked: true|false           # if true, the agent refuses out-of-scope additions
mode: gated|auto                   # optional override of per-step gating
workdir: ./relative-or-absolute    # optional. Filesystem tools sandboxed here.

authorized_costs:                  # pre-approves these destructive categories
  - filesystem_write
  - shell_exec
  - http_fetch
  - mcp_tool:filesystem

mcp_servers:                       # optional. name=command, one per entry.
  - filesystem=npx -y @modelcontextprotocol/server-filesystem /allowed/dir

# Multi-agent orchestration (v0.4+). See multi-agent.md.
roles:
  - planner
  - executor
  - reviewer
  # - critic

# Per-role adapter mixing (v0.5.1+). See multi-agent.md.
# Map form replaces the flat-list form when overrides are needed.
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

# Per-run cost ceilings (v0.4+).
budgets:
  max_tokens: 80000
  max_wall_clock_minutes: 25
  max_tool_calls_per_subtask: 12
  max_retries_per_subtask: 3

# cli-bridge configuration (v0.5+). Used when adapter is cli-bridge at the
# top level or any role. See adapters.md.
cli:
  binary: claude
  args: ["--print", "--output-format", "stream-json"]
  timeout_ms: 600000
  framework_prefix: true
---
```

## Authorized cost categories

The `authorized_costs:` list pre-approves destructive operations so the runtime doesn't prompt mid-run for every gated call. Recognized categories:

| Category | Notes |
|---|---|
| `filesystem_read` | **Default-allowed.** No need to list. |
| `filesystem_write` | Required for `write_file`, `apply_patch`. |
| `filesystem_delete` | Required for any delete operation. |
| `shell_exec` | Required for `shell_exec` native tool and the `cli-bridge` adapter. |
| `http_fetch` | Required for `http_fetch` native tool. Subject to the HTTP host allowlist. |
| `paid_api_call` | Generic flag for any pay-per-call adapter. Surfaced in the cost-tier preview. |
| `git_write` / `git_push` | Local vs remote git operations. |
| `deploy` | Deployment-class destructive actions. |
| `external_message` | Sending Slack / email / Discord / etc. |
| `mcp_tool:<server>` | All tools exposed by a named MCP server. |
| `mcp_tool:<server>:<tool>` | A specific MCP server's specific tool. |

### Wildcards

| Pattern | Matches |
|---|---|
| `*` | Every category. Triggers a brief-lint warning. |
| `mcp_tool:*` | Any tool from any MCP server. |
| `mcp_tool:server:*` | Any tool from a specific server. |

Almost always you want specific entries, not wildcards. The lint warning on `*` exists because it's a footgun: a brief authorized for everything can no longer Phase 3 anything.

## Body sections

The markdown body uses these conventional headings. The runtime extracts them when producing the Confirmation Summary:

- **Objective**: what outcome the operator actually wants
- **Deliverables**: concrete artifacts that constitute "done"
- **Constraints**: what the agent must respect (cost ceilings, deadlines, scope locks, banned tools)
- **Tools required**: what capabilities the agent needs; flag anything missing
- **Notes / unknowns**: anything ambiguous, contradictory, or under-specified

A brief without these sections still runs, but the Confirmation Summary will be less structured.

## Validation

Validate a brief without executing:

```bash
openwar validate <brief.md>
```

The validator checks:
- `project` is present and kebab-case
- `brief_id` matches `YYYY-MM-DD-<id>` if set
- `authorized_costs` entries are recognized categories or valid wildcards
- `roles:` references known role ids (built-ins plus any registered via `registerRole()`)
- `roles` map values declare a valid adapter id
- Roles pinned to `cli-bridge` come with `shell_exec` in `authorized_costs`
- `budgets` values are positive numbers

Errors abort; warnings (like the `*` wildcard) report but don't fail.

## Example briefs

The `examples/` directory ships reference briefs you can run end-to-end. See [examples/README.md](../examples/README.md) for the full list. Recommended first reads:

- `examples/creative-brief.md`: single-agent, gated mode, light authorization
- `examples/multi-agent-brief.md`: three-role coordinator run
- `examples/cli-bridge-brief.md`: bridged to a local CLI agent
- `examples/per-role-adapters-brief.md`: mixing adapters per role
