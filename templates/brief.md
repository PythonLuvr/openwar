---
project: <slug>
brief_id: YYYY-MM-DD-NNN
deadline: YYYY-MM-DD
scope_locked: false
mode: gated
# workdir: ./relative-or-absolute-path
# All filesystem tools resolve paths against this. Defaults to cwd.
authorized_costs:
  # - filesystem_write
  # - shell_exec
  # - http_fetch
  # - mcp_tool:filesystem
# mcp_servers:
#   - filesystem=npx -y @modelcontextprotocol/server-filesystem /allowed/dir
#
# v0.4 multi-agent. Omit to run single-agent (v0.3 behavior). Empty list
# (roles: []) is the same as omitting it. With multi-agent, the planner
# decomposes the brief, the executor runs each sub-task, and the reviewer
# evaluates against the acceptance criteria. Add "critic" for parallel
# second-opinion review (a disagreement halts the coordinator).
# roles:
#   - planner
#   - executor
#   - reviewer
#   # - critic
#
# Optional cost ceilings. Falls back to defaults if omitted:
#   max_tokens: 50000
#   max_wall_clock_minutes: 20
#   max_tool_calls_per_subtask: 15
#   max_retries_per_subtask: 3
# budgets:
#   max_tokens: 100000
#   max_wall_clock_minutes: 30
#   max_tool_calls_per_subtask: 20
#   max_retries_per_subtask: 3
---

# Objective

One paragraph. What outcome do I actually want when this is done.

# Deliverables

- Concrete artifact 1
- Concrete artifact 2

# Constraints

- Hard limit on cost / time / scope / tooling
- Anything that's banned

# Tools required

- What capabilities the agent needs (filesystem, web fetch, specific MCP servers, etc.)
- Flag anything you're not sure the agent has

# Notes / unknowns

- Things you don't know yet
- Things the agent should ask about in Phase 0
