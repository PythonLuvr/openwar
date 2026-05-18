# Tools and MCP

The OpenWar runtime ships nine native tools and a hand-rolled MCP client. Every tool call goes through a four-step pipeline before it executes:

1. **Schema translation** in the adapter to the provider's native function-calling format.
2. **Authorization check** against the brief's `authorized_costs` and any session-approved categories.
3. **Sandbox execution**: workdir-bounded paths, timeout enforcement, output caps, HTTP host allowlist.
4. **Result feed-back** to the LLM for the next round.

If a tool call requires an unauthorized category, the runtime halts into Phase 3 and prompts the operator for `y` (this call only), `Y` (promote category session-wide), or `n` (deny). On deny, the LLM receives a synthetic tool result so it can recover.

## Native tools

| Name | Categories required | Notes |
|---|---|---|
| `read_file` | `filesystem_read` | Default-allowed. Caps at `max_bytes` (1 MB default). |
| `write_file` | `filesystem_write` | Atomic via tmp+rename. Creates parent dirs. |
| `list_dir` | `filesystem_read` | Skips `.git`, `node_modules`, etc. Honors `.openwarignore`. |
| `shell_exec` | `shell_exec` | SIGTERM then SIGKILL on timeout. `--no-shell` disables entirely. |
| `http_fetch` | `http_fetch` | HTTPS only by default. Optional `~/.openwar/http-allow.json` host allowlist. |
| `apply_patch` | `filesystem_write` | Unified-diff applier. Rolls back on hunk failure. |
| `read_project_memory` | `filesystem_read` | v0.6+. Reaches `~/.openwar/projects/<slug>/<category>.jsonl` directly (not workdir-sandboxed). v0.7.3 added optional `project` + `id` args. |
| `write_project_memory` | `filesystem_write` | v0.6+. Appends an entry to the project's memory store. Same scoping as `read_project_memory`. |
| `list_project_memory` | `filesystem_read` | v0.7.3. Summarizes a project's memory store; returns per-category counts and 200-char excerpts. Use it to find ids; follow up with `read_project_memory` for full bodies. |

List them with:

```bash
openwar tools
```

## Sandbox details

- **`workdir`** roots all filesystem paths. Set per brief in frontmatter or per run via `--workdir`. Native tools refuse paths outside the workdir.
- **`max_bytes`** caps `read_file` (default 1 MB) and `http_fetch` (default 5 MB) output. Larger reads truncate with a notice.
- **HTTP host allowlist** at `~/.openwar/http-allow.json` restricts `http_fetch` targets. Without the file, all HTTPS hosts are allowed.
- **Symlink escape protection** prevents tools from following symlinks outside the workdir.
- **Shell timeouts** default to 30 seconds. SIGTERM with a 5-second grace period before SIGKILL.
- **Cancellation** (v0.11.1+): every native tool reads `ctx.signal` (an `AbortSignal` the runtime provides per call) and aborts cleanly when fired. `shell_exec` gets a 3-second SIGTERM grace window before SIGKILL on operator cancel (longer than the 2-second timeout grace, so well-behaved children have time to flush). `http_fetch` aborts the underlying `fetch` and surfaces whatever body bytes arrived as the partial output. `apply_patch` captures pre-images during planning and rolls back already-written files if cancellation fires mid-write, leaving the tree in its pre-call state. Cancelled tools return a `ToolResult` with `error.code === "CANCELLED"`; the dispatcher emits a `tool_cancelled` trace event and routes a structured cancelled tool-result back to the model. Custom-tool authors who want to participate in cancellation must thread `ctx.signal` through their own implementations.

## MCP servers

OpenWar ships a hand-rolled MCP client (no `@modelcontextprotocol/sdk` dependency) that talks JSON-RPC over stdio. Configure servers at three scopes:

### Per-brief (frontmatter)

```yaml
mcp_servers:
  - filesystem=npx -y @modelcontextprotocol/server-filesystem /allowed/dir
  - github=npx -y @modelcontextprotocol/server-github
```

### Per-run (CLI flag)

```bash
openwar run brief.md \
  --mcp-server "filesystem=npx -y @modelcontextprotocol/server-filesystem /allowed/dir"
```

### Global (persisted to ~/.openwar/mcp.json)

```bash
openwar mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /allowed/dir
openwar mcp list
openwar mcp remove filesystem
```

## Authorizing MCP tools

Each MCP server's tools auto-register under `<server>:<tool>`. To authorize a brief to call them, add to `authorized_costs`:

| Pattern | Authorizes |
|---|---|
| `mcp_tool:filesystem:read_file` | Specific tool from specific server |
| `mcp_tool:filesystem` | All tools from the `filesystem` server (legacy shorthand) |
| `mcp_tool:filesystem:*` | All tools from the `filesystem` server (explicit wildcard) |
| `mcp_tool:*` | All tools from any MCP server |

## Smoke-testing a server

Before relying on an MCP server in a real brief, verify the handshake works:

```bash
openwar mcp test filesystem
```

This connects, lists tools, and disconnects. Useful for debugging permission issues, missing binaries, or malformed config.

## Authorization model summary

The brief's `authorized_costs` is the operator's standing approval list. Categories in this list never trigger a Phase 3 prompt. Categories NOT in the list trigger a prompt on first use, with three operator responses:

- **`y`**: approve this call only. Next call from the same category re-prompts.
- **`Y`**: approve the category session-wide. Promotes into `session_approved_categories` in `SessionMeta`.
- **`n`**: deny. LLM receives a synthetic "denied" tool result.

This pattern lets a brief start tight ("nothing destructive authorized") and widen as the operator decides what's safe in context. See [brief-format.md](./brief-format.md) for the full authorized_costs category list and wildcard rules.
