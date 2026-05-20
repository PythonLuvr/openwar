# Adapters

OpenWar abstracts the agent backend behind a small adapter interface. Each adapter takes a `SendMessageOptions` payload and yields `StreamEvent`s. You configure adapters with a `BYOK` (bring your own key) model: the runtime owns nothing on the provider side, just calls what you've already configured.

## Built-in adapters

| Adapter | Env var | Default model | Tier |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | paid |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` | paid |
| `gemini` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-2.0-flash` | paid |
| `grok` | `XAI_API_KEY` | `grok-2-latest` | paid |
| `openai-compat` | `OPENAI_COMPAT_API_KEY` | (specify with `--base-url`) | paid (override to free for local) |
| `cli-bridge` | (none, uses local CLI) | (specify with `--cli-binary`) | free |
| `mock` | (none, deterministic) | `mock` | free |

The runtime calls `isConfigured()` on the adapter at startup. API adapters with a missing key fail fast with a clear error.

## openai-compat: local models via Ollama, vLLM, llama.cpp

`openai-compat` covers any backend that speaks OpenAI's chat-completions protocol. That includes OpenRouter, Groq, Together, and local servers like Ollama and llama.cpp. Examples:

**Ollama:**
```bash
npx @pythonluvr/openwar run brief.md \
  --adapter openai-compat \
  --base-url http://localhost:11434/v1 \
  --model llama3.1
```

**vLLM / LM Studio / llama.cpp (local):**
```bash
npx @pythonluvr/openwar run brief.md \
  --adapter openai-compat \
  --base-url http://localhost:8000/v1 \
  --model your-local-model-id
```

Local servers don't need an API key but the adapter still wants one set. Use any non-empty value:

```bash
export OPENAI_COMPAT_API_KEY=local
```

For local runs you'll also want to override the default `paid` tier so the cost banner doesn't lie:

```bash
# Brief frontmatter
adapter_overrides:
  openai-compat:
    tier: free
```

## cli-bridge: treat a CLI binary as the agent (v0.5+)

`cli-bridge` is the adapter that turns a local CLI agent (Claude Code, Codex CLI, Gemini CLI, aider, your own custom tool) into an OpenWar-coordinated executor. The runtime spawns the binary, pipes the prompt in via stdin, streams stdout as `text_delta` events, and applies the phase machine the same way it would against any LLM adapter.

### Powered by Squire (v0.11+)

As of v0.11, the subprocess spawn / Windows quirks / stdio streaming layer lives in a standalone npm package, **[@pythonluvr/squire](https://github.com/PythonLuvr/squire)**, which OpenWar consumes as a dependency. The split is purely architectural; users see no behavior change at OpenWar's surface. The benefit is for the broader ecosystem: developers searching "run Claude Code from Node.js" or "orchestrate multiple CLI agents" land on Squire's focused README and find a clean API, then graduate to OpenWar when they want phase gates, traces, and replayable execution on top of it.

If you're building your own CLI-agent integration and don't need OpenWar's phase machinery, you can use Squire directly. See [Squire's openwar-integration doc](https://github.com/PythonLuvr/squire/blob/main/docs/openwar-integration.md) for a worked example of how OpenWar's `CliBridgeAdapter` wraps it.

### Minimum invocation

```bash
npx @pythonluvr/openwar run examples/cli-bridge-brief.md \
  --adapter cli-bridge \
  --cli-binary claude
```

The brief must include `shell_exec` in `authorized_costs` because every cli-bridge invocation shells out a child process. The runtime halts pre-Phase-0 with a copy-pasteable frontmatter snippet if missing.

### Full config (brief frontmatter)

```yaml
cli:
  binary: claude
  args: ["--print", "--output-format", "stream-json"]
  timeout_ms: 600000           # default 10 min
  framework_prefix: true        # prepend openwar.md to the prompt
  tier: free                    # default; set to "paid" if your CLI bills
```

### When framework_prefix matters

`framework_prefix: true` (default) prepends the contents of `openwar.md` to every prompt sent to the CLI. This makes non-OpenWar-aware CLIs behave like OpenWar-aware ones for the duration of the call. The cost is roughly 15 KB of tokens per invocation.

Set `framework_prefix: false` (or pass `--cli-no-framework`) when the CLI already has OpenWar in its own system prompt. For Claude Code with `openwar.md` already in CLAUDE.md, the prepend is redundant and wasteful.

### MCP-server-mode and the bridged-CLI registry (v0.7+)

When a brief uses cli-bridge, OpenWar additionally exposes its eight native tools (`read_file`, `write_file`, `list_dir`, `shell_exec`, `http_fetch`, `apply_patch`, `read_project_memory`, `write_project_memory`) to the bridged CLI through standard MCP. The bridged agent can call any of them as `openwar:<tool_name>` and the runtime authorizes every call through the brief's `authorized_costs`.

The runtime knows how to wire MCP forwarding for these bridged CLIs out of the box:

| Binary basename | CLI | Config file | Wiring | Persists |
|---|---|---|---|---|
| `claude` | Claude Code | `<temp>/openwar-mcp-config-*.json` | `--mcp-config <path>` flag injection | cleaned up at session end |
| `gemini` | Gemini CLI | `<workdir>/.gemini/settings.json` | auto-discovered | yes (no cleanup) |
| `codex` | Codex CLI (v0.7.1+) | `~/.codex/config.toml` | auto-discovered, merged into existing TOML | yes (no cleanup) |

Unknown binaries (aider, custom tools without native MCP support) hit a fallback: the OpenWar MCP config is still written to a temp JSON file, but no CLI args are injected. The runtime emits a startup warning so the operator can wire MCP manually for that CLI, or set `cli.mcp_forward: false` in the brief frontmatter to disable forwarding entirely and run the bridged CLI in its own tool sandbox.

The Codex entry preserves operator hand-edits to other sections of `~/.codex/config.toml` (it reads the file, replaces or appends the `[mcp_servers.openwar]` block, leaves everything else untouched). Same model is expected to extend to other TOML-config CLIs in v0.7.3+.

### Claude Code permission auto-setup (v0.7.2+)

Claude Code treats every external MCP tool as separate-trust. Even with MCP forwarding wired correctly, the bridged Claude Code halts at its own permission gate on the first openwar tool call (`Claude requested permissions to use mcp__openwar__openwar_<tool>, but you haven't granted it yet.`). Neither `--permission-mode bypassPermissions` nor `--allowedTools` covers external MCP tools.

v0.7.2 closes that gap by pre-authorizing the openwar MCP tools in `~/.claude/settings.json` before spawn. The runner:

1. Reads the existing settings file (if any) and validates it parses as JSON.
2. Adds any missing `mcp__openwar__openwar_<tool>` patterns to `permissions.allow` (eight entries, one per native tool).
3. Writes atomically via tmp + rename.
4. Emits a banner: `Pre-authorized openwar MCP tools in Claude Code settings at <path> (added N new grants / all already authorized). Existing operator settings preserved.`

Operator-edited keys (other MCP servers' grants, Bash / Read / WebFetch entries, top-level keys, `permissions.deny`) are preserved verbatim. The merge is idempotent.

If the existing settings file is malformed JSON, the runner halts cleanly into Phase 2 with `halt_reason: cli_bridge_permission_setup_failed_parse` and a remediation message rather than clobbering. Same for write-permission failures.

Operators who manage their Claude Code settings via dotfiles, Ansible, or company policy can opt out with `cli.skip_permission_setup: true` in the brief frontmatter; the merge is skipped and the operator manages permissions themselves. Gemini CLI and Codex CLI permission auto-setup are not in v0.7.2; if real testing surfaces the same friction with those CLIs, handling lands in v0.7.3+.

### Structured event capture (v0.12.1+)

Squire's vendor-aware adapters (`claude-code`, `gemini-cli`) parse the bridged CLI's stream-json output and emit four structured event variants beyond plain text: `tool_call`, `tool_result`, `thinking_delta`, and `usage`. As of v0.12.1, OpenWar's cli-bridge translates these into corresponding `bridged_*` `StreamEvent` variants and routes them into the trace and (when a multi-agent coordinator is running) the cost ledger:

| Squire event | OpenWar `StreamEvent` | OpenWar trace event | Notes |
|---|---|---|---|
| `tool_call` | `bridged_tool_call` | `bridged_tool_call` | Field rename: Squire `id`/`name`/`input` to OpenWar `call_id`/`tool_name`/`arguments`. The `binary` field names the bridged CLI. |
| `tool_result` | `bridged_tool_result` | `bridged_tool_result` | Carries the matching `call_id` plus the vendor's `output` and `is_error`. |
| `thinking_delta` | `bridged_thinking_delta` | `bridged_thinking_delta` | Kept distinct from `text_delta` so observers can filter or hide thinking content. |
| `usage` | `bridged_usage` | `bridged_usage` | Reports `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` (all optional; vendors report what they have). Input + output flow into the cost ledger's `tokens_used`; cache reads / writes are recorded separately for visibility and excluded from the running budget total. |

The `bridged_` prefix is load-bearing: it distinguishes events captured from inside a bridged CLI's run from OpenWar's own native-tool dispatch (which uses the un-prefixed `tool_call` / `tool_result` trace events). Observers, dashboards, and `openwar inspect --tools` use the prefix to group the two streams.

If your cli-bridge run targets a CLI that Squire does not have a vendor-aware adapter for (the default text-stream path), no structured events are emitted; OpenWar sees only `text_delta` and `message_stop` and the trace captures the existing text-only shape.

When Squire ships additional vendor-aware adapters (e.g. Codex CLI in a future Squire release), OpenWar's translation code already handles the same four variants automatically. No OpenWar code change is required to adopt them; bumping the Squire dep range is enough.

### When to use cli-bridge vs an API adapter

Use `cli-bridge` when:
- Your CLI agent (Claude Code, aider, Codex) has its own MCP servers, session memory, or workdir conventions you want to preserve.
- You're already paying for a CLI subscription and don't want to double-pay via API.
- The task benefits from the CLI's built-in tool ecosystem (Claude Code's filesystem + bash + MCP integration, for example).

Use an API adapter when:
- You want OpenWar's native tools (`read_file`, `write_file`, `shell_exec`, etc) to handle execution directly.
- You need the runtime's tighter sandbox guarantees over the CLI's looser ones.
- One-shot stateless calls (no session state, no resume) are sufficient.

See [multi-agent.md](./multi-agent.md) for mixing adapters across roles (planner on a cheap API, executor on a local CLI, reviewer on a third model).

## Tier-aware cost preview

Every adapter declares a tier (`free` or `paid`) used in the pre-Phase-0 cost banner. The banner fires before the operator confirms the run, so you see the cost shape before any LLM call.

- **`free`**: local CLI subscription, local model, mock. No per-call billing.
- **`paid`**: cloud API. May incur charges per the provider's pricing.

Override the default via `extra.tier` in adapter config or `adapter_overrides.<id>.tier` in the brief frontmatter.

## Adding a custom adapter

OpenWar adapters implement a small interface. To plug in a custom backend (a private API gateway, a different CLI shape, an experimental model), implement:

```ts
interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent>;
}
```

See [library.md](./library.md) for the full type surface and an integration example.
