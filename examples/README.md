# OpenWar example briefs

Five reference briefs you can run end-to-end against any configured adapter.

## creative-brief.md

A copywriting task with gated execution. Demonstrates frontmatter with `scope_locked: false`, `mode: gated`, and a soft `generation_credits` pre-approval.

```bash
npx openwar run examples/creative-brief.md --adapter anthropic
```

## engineering-brief.md

A code task with auto-pilot execution and a locked scope. Demonstrates `scope_locked: true`, `mode: auto`, and `filesystem_write` pre-approved.

```bash
npx openwar run examples/engineering-brief.md --adapter openai --model gpt-4o
```

## file-editing-brief.md (v0.3+, requires tools)

A real refactor: rename a symbol across every `.ts` file in the workdir. Demonstrates `read_file`, `list_dir`, and `apply_patch` native tools with `filesystem_write` pre-approved.

```bash
npx openwar run examples/file-editing-brief.md --adapter anthropic --workdir ./your-project
```

## research-brief.md (v0.3+, requires tools + network)

Fetch three GitHub README files and save them locally. Demonstrates `http_fetch` and `write_file`. If you have `~/.openwar/http-allow.json` configured, allow `*.githubusercontent.com` first.

```bash
npx openwar run examples/research-brief.md --adapter anthropic
```

## mcp-brief.md (v0.3+, requires MCP)

Survey the workdir through the official Filesystem MCP server. Demonstrates `mcp_servers` in frontmatter and the `mcp_tool:filesystem:*` wildcard.

```bash
npx openwar run examples/mcp-brief.md --adapter anthropic
```

## Inspecting after the run

```bash
openwar list                              # show recent sessions
openwar inspect <brief_id>                # show session metadata
openwar inspect <brief_id> --transcript   # full back-and-forth
```

Sessions persist to `~/.openwar/sessions/`. Resume with `openwar resume <brief_id>`.
