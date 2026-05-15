---
project: mcp-filesystem-survey
brief_id: 2026-05-15-003
scope_locked: true
mode: gated
authorized_costs:
  - filesystem_read
  - mcp_tool:filesystem:*
mcp_servers:
  - filesystem=npx -y @modelcontextprotocol/server-filesystem ./
---

# Objective

Survey the current workdir using the official Filesystem MCP server and report the top 5 largest files.

# Deliverables

- A list of the 5 largest files, with sizes, printed to the chat.
- A one-paragraph observation about file-size distribution.

# Constraints

- Use the MCP server's tools (e.g. `filesystem:read_file`, `filesystem:list_directory`). Do not call native tools for this brief; the goal is to exercise the MCP path.
- Read-only. No writes anywhere.

# Tools required

- `mcp_tool:filesystem:*` (pre-approved in `authorized_costs`).

# Notes / unknowns

- First run will spawn the MCP server via npx; this can take 20-30 seconds on a cold cache.
- If the server fails to start, the runtime logs a warning and falls back to native tools. That defeats the brief; check the MCP install before retrying.
