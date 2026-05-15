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
