# OpenAI-compatible proxy (`openwar serve`, v0.13.0+)

OpenWar exposes its runtime as an OpenAI Chat Completions HTTP server. Any tool that speaks OpenAI's API (Aider, Continue, Cline, Cursor's CLI mode, the OpenAI SDKs themselves, the dozens of OpenAI-API homegrown wrappers) can point at the server and consume OpenWar's discipline layer with zero changes on its end. The tool thinks it is talking to OpenAI; OpenWar applies its phase machine, trace, and detector pipeline underneath, then routes the actual completion to whatever upstream adapter is configured (Anthropic, OpenAI, Gemini, Grok, openai-compat local model, or a cli-bridge spawn).

## v0.13.0 scope

This is the **MVP cut**. It ships:

- `POST /v1/chat/completions`. both streaming (SSE) and non-streaming JSON.
- `GET /v1/models`. declares one model entry for the configured upstream.
- `GET /healthz`. liveness probe; no auth required.
- 404 fallback in OpenAI error shape on every other path.
- Bearer-token auth with constant-time compare, plus `--no-auth` for local dev.
- Localhost-default bind (`127.0.0.1`); binding to `0.0.0.0` requires explicit intent and warns.
- Per-request concurrency cap (`--max-concurrent`, default 4) returning OpenAI `rate_limit_error` 429 on excess.
- Per-request synthesized brief at `~/.openwar/sessions/proxy-<uuid>.trace.ndjson` so the operator can audit what the foreign client did via `openwar inspect proxy-<uuid>`.
- `X-OpenWar-Trace-Id` response header on every response for trace correlation.

It does **NOT** yet ship:

- Tool-call translation (request `tools` array, response `tool_calls`). v0.13.0 acknowledges the `tools` field at parse time and records the count in `proxy_request`, but does not yet round-trip tool calls. **Plain-text Aider / Continue / Cline sessions work end-to-end; agentic tool-use does not.**
- PermissionBridge negotiation via `openwar:request_permission` tool_calls. The encoding helpers exist; the routing lands when tools light up.
- cli-bridge composition is structurally supported (cli-bridge is a normal upstream adapter) but agentic capability is gated on the tool surface above.

Both deferred items land in v0.13.1.

## Threat model

The proxy is designed to be safe by default on a developer laptop:

- **Localhost-only bind**. `--bind 0.0.0.0` requires explicit intent and emits a startup warning. The operator running with the default cannot accidentally expose the proxy on a network.
- **Bearer-token auth required**. Without `--auth-token` AND without `--no-auth`, the server refuses to start. `--no-auth` works but warns every startup. The constant-time compare in [`src/serve/auth.ts`](../src/serve/auth.ts) means token-guessing attacks cannot be timed against the localhost socket.
- **Conservative `authorized_costs` default**. Synthesized briefs get `filesystem_read` only by default. Operators expand explicitly via `--authorized-costs filesystem_read,filesystem_write,shell_exec` (or narrower) per their trust model. The proxy does NOT silently grant write or shell privileges to foreign clients.
- **Stateless across requests**. Each proxied request is its own `Session`. No cross-request memory unless the client sends prior messages in its next request (standard OpenAI conversation pattern). Persistent permission grants from `~/.openwar/projects/<slug>/permission_grants.jsonl` are NOT loaded for proxy sessions; proxy sessions are project-less by design.
- **No TLS in the proxy itself**. Operators wanting HTTPS run a reverse proxy (nginx, Caddy, Cloudflare Tunnel) in front. The localhost-default keeps the default safe.
- **Trace audit trail**. Every request emits `proxy_request` at start, `proxy_response` at end, plus any tool_call / detector / phase events that fire. Auditable via `openwar inspect proxy-<uuid>`.

## Quick start

```bash
openwar serve --openai-compat \
  --auth-token "$(openssl rand -hex 16)" \
  --authorized-costs filesystem_read,filesystem_write,shell_exec
```

The server prints a startup banner with the curl command you can paste to test, plus the `authorized_costs` expansion hint reminding you that agentic clients typically need more than the conservative default.

Once running, any OpenAI-compat tool points at it:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:1234/v1
export OPENAI_API_KEY=<the-token-from-above>
aider --model openwar
```

The `--model openwar` part is arbitrary; the proxy passes whatever model name the client sends through to the upstream adapter (substituting `--upstream-model` if the upstream needs a different name; substitution is recorded on the `proxy_request` trace event via `model_substituted_from`).

## CLI surface

| Flag | Default | Notes |
|---|---|---|
| `--openai-compat` | (required) | v0.13.0 ships this one serve mode; the flag exists so future modes (raw MCP, native OpenWar API) can slot in alongside. |
| `--port <n>` | `1234` | LM Studio convention; friendly to existing OpenAI-compat client habits. |
| `--bind <host>` | `127.0.0.1` | `0.0.0.0` warns at startup. |
| `--upstream-adapter <id>` | auto-detect | `anthropic / openai / gemini / grok / openai-compat / cli-bridge`. Auto-detection precedence matches `openwar chat`: `ANTHROPIC_API_KEY > OPENAI_API_KEY > GEMINI_API_KEY (or GOOGLE_API_KEY) > XAI_API_KEY > OPENAI_COMPAT_API_KEY`. |
| `--upstream-model <name>` | adapter default | When the client's requested model differs, the proxy substitutes this and records the substitution in `proxy_request.model_substituted_from`. |
| `--auth-token <token>` | (required unless `--no-auth`) | Constant-time compared against the `Authorization: Bearer <token>` header. Server refuses to start without this OR `--no-auth`. |
| `--no-auth` | off | Opt-out for local development. Warns every startup. |
| `--workdir <path>` | `process.cwd()` | Synthesized-brief sandbox root. |
| `--authorized-costs <list>` | `filesystem_read` | Comma-separated. Operators expand explicitly. |
| `--max-concurrent <n>` | `4` | Excess returns OpenAI `rate_limit_error` 429 with code `openwar_max_concurrent`. |
| `--log-requests` | off | One line per request to stderr. |

## Composition with cli-bridge

`--upstream-adapter cli-bridge` is structurally supported and emits a startup warning:

```
WARNING: cli-bridge as upstream spawns one CLI child per request.
         Each request adds 2-5s of cold-start latency. Concurrent
         requests scale memory by ~400MB per Claude Code instance.
         Consider --max-concurrent 1 for cli-bridge upstream.
```

This composition is the most powerful configuration the proxy supports. a foreign OpenAI-API tool routes through OpenWar, which dispatches to Claude Code (or Codex / Gemini CLI), which executes with the structured-event capture from v0.12.1 all the way through. The trace at `~/.openwar/sessions/proxy-<uuid>.trace.ndjson` captures every `bridged_tool_call` / `bridged_tool_result` / `bridged_thinking_delta` / `bridged_usage` event from the inner CLI's run alongside the proxy bookkeeping events. The composition is real; the operator-experience caveat is real too. keep `--max-concurrent` low and expect cold-start latency on burst traffic.

## Trace surface

Every proxied request produces a fresh trace file at `~/.openwar/sessions/proxy-<uuid>.trace.ndjson`. Two new event types beyond the existing trace schema:

- **`proxy_request`**. emitted at session start. Fields: `request_id`, `client_addr`, `model`, `stream` (boolean), `tool_count`, `at`, optional `model_substituted_from`.
- **`proxy_response`**. emitted at session end. Fields: `request_id`, `status_code`, `duration_ms`, `bytes_written`, `cancelled`, `at`.

`TRACE_SCHEMA_VERSION` bumps from 4 to 5 for these additive variants. Old readers ignore unknown types.

Inspect a completed request:

```bash
openwar inspect proxy-<uuid>            # session summary
openwar inspect proxy-<uuid> --trace    # raw event stream
```

The `X-OpenWar-Trace-Id` response header on every proxy response carries the request id, so tooling that wants to audit a request can grab the id without parsing logs.

## Out of scope (v0.13.0)

The brief deferred or never-scoped the following. Some land in v0.13.1, some are reserved indefinitely:

- **Legacy `/v1/completions` endpoint.** Chat Completions only.
- **Embeddings endpoint.** Not an agentic surface.
- **OpenAI Assistants API.** Different protocol, different state model.
- **Legacy `functions` field.** Modern `tools` field only (when it lands in v0.13.1).
- **WebSocket / realtime API.** Out of scope.
- **Multi-tenant auth.** Single bearer token, single operator. Multi-tenant is a War Room concern.
- **TLS / HTTPS.** Use a reverse proxy.
- **Persistent permission grants in proxy sessions.** Proxy sessions are project-less; ledger is in-memory per request.
- **Rate limiting beyond `--max-concurrent`.** No per-token / per-IP / per-hour rate limiting. Operator-side concern.
- **Vision, custom `tool_choice` variants beyond `auto`/`none`/`required`, `parallel_tool_calls` beyond default.** Extensions land in patch releases if specific named clients need them.
- **Legacy `prompt` field for ancient OpenAI clients.** Document the requirement: clients must use modern `messages`.

## Known limitations vs full OpenAI API (v0.13.0)

- No `tools` round-trip. The request's `tools` array is recognized at parse time and surfaces in `proxy_request.tool_count`, but the upstream adapter is called WITHOUT the tool definitions. Plain-text completion only in v0.13.0.
- No `usage` reporting. v0.13.0 does not run a tokenizer or thread upstream usage data into the response. The `usage` field is omitted; OpenAI clients tolerate the absence.
- No conversation history beyond what the client sends in `messages`. Each request is a fresh `Session`.
- `finish_reason` in v0.13.0 is always `stop` for successful completions. `content_filter` / `tool_calls` / `length` are reserved for v0.13.1 + later.

These items are not bugs; they are scope. v0.13.1 closes the tool surface; v0.13.x patches address specific client compatibility issues as they surface.

## Worked example (Aider)

```bash
# 1. Start the proxy with an Anthropic API key configured upstream:
export ANTHROPIC_API_KEY="sk-ant-..."
openwar serve --openai-compat \
  --auth-token "my-local-token" \
  --authorized-costs filesystem_read,filesystem_write \
  --upstream-model claude-opus-4-7

# 2. In another shell, point Aider at the proxy:
export OPENAI_BASE_URL=http://127.0.0.1:1234/v1
export OPENAI_API_KEY=my-local-token
aider --model openwar src/foo.py

# 3. Aider sends Chat Completions requests; OpenWar routes them to
#    Anthropic (or whatever upstream is configured), translates the
#    response back to OpenAI shape, and records the whole thing in
#    a trace file. Inspect:
openwar inspect $(curl -s -X POST http://127.0.0.1:1234/v1/chat/completions \
  -H "Authorization: Bearer my-local-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"openwar","messages":[{"role":"user","content":"hi"}]}' \
  -D - | grep -i x-openwar-trace-id | cut -d: -f2 | tr -d ' \r\n')
```

(v0.13.0 caveat: Aider's tool-use features will not work end-to-end yet. Plain-text chat works.)

## Comprehensive Continue / Cline / Cursor examples + tool-use coverage land in v0.13.1.
