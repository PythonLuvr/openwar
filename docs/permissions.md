# PermissionBridge (v0.12+)

OpenWar's Phase 3 destructive-action gate has always existed: a tool call requires authorization, and unauthorized calls halt the runtime for an operator decision. The gate was reactive. The agent attempted; the gate reacted.

PermissionBridge gives the agent (or any bridged CLI) a structured way to ask BEFORE acting. The operator answers with structure too. Phase 3 still fires when no grant matches. Nothing relaxes; the conversation gets articulate.

## At a glance

- Agent calls `request_permission` (new native tool, also exposed via MCP as `openwar:request_permission`) before a destructive action.
- Runtime prompts the operator with a multi-line form: action, reason, fallback, requested scope.
- Operator approves at the requested scope (`y`), at session scope (`s`), at persistent scope (`p`), or denies (`n` / `n: <note>`).
- Approved requests register a grant in the per-session `GrantLedger`.
- Next time the agent makes a destructive tool call, Phase 3 checks the ledger first. A matching grant skips the operator prompt and lets the call proceed; the runtime emits `permission_grant_consumed` for the audit trail.
- Persistent grants survive the session via `~/.openwar/projects/<slug>/permission_grants.jsonl`. The next run for the same project starts with them already in the ledger.

## The new tool

`request_permission` accepts the following arguments:

| Field | Required | Description |
|---|---|---|
| `action` | yes | Concrete description of what the agent wants to do. The operator reads this verbatim; write it like you would explain to a peer. |
| `reasoning` | yes | Why the action is needed. One or two sentences. |
| `scope` | no | One of `this_call`, `this_session`, `persistent`. Defaults to `this_call`. |
| `fallback` | no | What the agent will do if denied. Helps the operator gauge cost of denial. |
| `category` | no | Auth category tag for grant matching (e.g. `filesystem_write`, `shell_exec`). |

Response (returned to the agent as the tool result):

```jsonc
{
  "granted": true,
  "scope_granted": "this_call",
  "operator_note": "",
  "grant_id": "<uuid>"
}
```

On denial, `granted: false`, no `scope_granted`, an `operator_note` (which may be empty), and a placeholder `grant_id`. Denial is NOT an error; the agent decides whether to retry, switch approach, or report back. Halting is operator-side via `/revoke` or by closing the session.

The tool has `authorization_categories: []` (default-allowed). Requesting permission is never itself destructive.

## Scope semantics

| Scope | Lifetime | Behavior on Phase 3 match |
|---|---|---|
| `this_call` | Exactly one upcoming destructive tool call | Consumed on first match (flips `consumed=true`); no longer matches afterward |
| `this_session` | Until session end or revocation | Matches every Phase 3 fire whose category overlaps; never gets consumed |
| `persistent` | Until explicit revocation (across sessions) | Same as `this_session`, plus serialized to disk for the next session |

When `persistent` is requested but the run has no `project_slug`, the scope silently degrades to `this_session`. The operator sees this in the tool-result `scope_granted` field; the agent can act on it.

## Match semantics (load-bearing)

A grant matches an upcoming destructive tool call by **category overlap**. There is no literal action-string matching: Phase 3 sees structured tool calls (tool name + args), not free text, so matching the `action` string against a tool call's actual operation would be unreliable.

Match rules:

- `this_call` + category supplied: matches the next Phase-3-firing tool call whose required auth category overlaps the grant category. Non-destructive tool calls (read_file, etc.) between request and match do NOT consume the grant.
- `this_call` + no category: matches the next Phase-3-firing tool call regardless of category. Use sparingly. The agent is saying "the very next risky thing I'm about to do".
- `this_session` / `persistent` + category: matches every Phase-3-firing call with a matching category until session end or revocation.
- `this_session` / `persistent` + no category: matches every Phase-3-firing call. **Broad on purpose.** Operators approving a session-scope or persistent grant without a category are saying "I trust this agent with arbitrary destructive actions in this scope". Be deliberate.

If multiple grants could match a call, the runtime prefers the most recently granted unconsumed `this_call` grant over `this_session` / `persistent` grants. The intent reading is "I just asked; let me do it." After all `this_call` grants are exhausted, session and persistent grants apply.

## The operator prompt

When the agent calls `request_permission`, the chat REPL renders:

```
Permission request from agent:
  ACTION    Delete the file src/legacy.ts
  REASON    File is unreferenced; cleaning up before the refactor.
  FALLBACK  Skip the cleanup; refactor proceeds with the file present.
  CATEGORY  filesystem_write
  REQUESTED SCOPE  this_call

Approve at what scope?
  y         grant at requested scope (this_call)
  s         grant for the rest of this session
  p         grant persistently (saved to project memory)
  n         deny
  n: <msg>  deny with a note for the agent
>
```

In headless `openwar run` against a TTY, the same prompt renders to stderr. Against a non-TTY (CI, redirected stdin), the runtime denies-by-default with `operator_note: "no interactive operator available"`. The agent reads the denial and decides whether to fall back or escalate.

## Slash commands

The chat REPL adds two operator-only commands:

- `/grants` lists active grants in the current run (`scope`, `category`, `action`, `reason`, `granted_at`). Shows consumed `this_call` grants too so the operator can see what was used.
- `/revoke <grant_id>` revokes a grant. Persistent grants are also marked revoked on disk. The agent will get re-prompted next time it requests a matching action.

Active grants are also surfaced after-the-fact via `openwar inspect <brief_id> --permissions`.

## Phase 3 integration

The integration is a single new branch in the dispatch path at `src/phases/execute.ts`. Before halting on an unauthorized tool call, the runtime queries `ctx.grantLedger.findMatchingGrant(missing_categories)`. If a match is returned:

1. `permission_grant_consumed` is emitted into the trace with the grant id and the consuming tool call id.
2. An `auth_check_fired` allow event is also emitted (so `inspect --tools` shows the call as authorized).
3. The grant is consumed (for `this_call`) and the dispatcher continues to the executor.

If no match, the existing Phase 3 halt path runs (operator prompt for y / Y / n).

Phase 3 still fires when no grant matches. PermissionBridge is an upstream hint, not a bypass.

## Trace events

Five new event types (all additive; `TRACE_SCHEMA_VERSION` bumped to 3):

| Event | Fields |
|---|---|
| `permission_requested` | `grant_id`, `action`, `category`, `scope_requested`, `reasoning`, `fallback`, `at` |
| `permission_granted` | `grant_id`, `scope_granted`, `operator_note`, `at` |
| `permission_denied` | `grant_id`, `operator_note`, `at` |
| `permission_grant_consumed` | `grant_id`, `consuming_tool_call_id`, `at` |
| `permission_revoked` | `grant_id`, `revoked_at` |

Read them via `openwar inspect <brief_id> --permissions` for a per-grant audit row (status, scope, category, action, timestamp) or `openwar inspect <brief_id> --trace` for the raw event stream.

## Persistence

Persistent grants live at `~/.openwar/projects/<slug>/permission_grants.jsonl`. The file is append-only, same shape contract as the v0.6 memory store and v0.8 trace ndjson:

```jsonc
{ "v": 1, "op": "grant", "grant_id": "...", "action": "...", "category": "...", "scope": "persistent", "reasoning": "...", "granted_at": "2026-05-19T..." }
{ "v": 1, "op": "revoke", "grant_id": "...", "revoked_at": "2026-05-19T..." }
```

Mid-line corruption skips that line; the rest of the file still loads. Write failures emit a one-time stderr warning and keep the grant in memory for the current session only. There is no TTL; persistent grants live until explicitly revoked.

## Programmatic surface

Library consumers see the new API via the existing `Session` interface returned through `RunOptions.onSession`:

```ts
interface Session {
  // v0.11.1 surface (unchanged)
  cancelCurrentToolCall(): Promise<boolean>;
  // v0.12.0 additions
  listActiveGrants(): readonly Grant[];
  revokeGrant(grant_id: string): boolean;
}
```

Programs that drive their own grant flow (custom UIs, web bridges, integration tests) can read `listActiveGrants()` for state and call `revokeGrant()` to invalidate. The chat REPL uses the same surface to back `/grants` and `/revoke`.

## Worked examples

### Bridged CLI requesting a filesystem write

```
agent calls openwar:request_permission with:
  action:    "Overwrite docs/api.md with the regenerated content"
  category:  "filesystem_write"
  scope:     "this_call"
  reasoning: "the source schema changed; the docs are stale"
  fallback:  "skip the regen; flag the staleness in the next handoff"

operator sees the prompt, types: y
  -> grant registered (this_call, filesystem_write)
  -> agent receives { granted: true, scope_granted: "this_call", grant_id: "..." }

agent calls write_file (which requires filesystem_write):
  -> Phase 3 would normally halt
  -> grant ledger returns the grant; permission_grant_consumed emitted
  -> write proceeds; grant is now consumed

next time the agent calls write_file, Phase 3 halts again (no matching grant).
```

### Persistent grant for a recurring action

```
agent calls openwar:request_permission with:
  action:    "Append release notes to RELEASES.md whenever I publish"
  category:  "filesystem_write"
  scope:     "persistent"
  reasoning: "this is the standard publish-notes flow"

operator types: p
  -> persistent grant registered + serialized to
     ~/.openwar/projects/<slug>/permission_grants.jsonl

(later, in a different session for the same project)
  -> GrantLedger seeds the in-memory ledger from disk
  -> agent's filesystem_write tool calls in that session are auto-authorized
     by category match until the grant is revoked

operator runs: /revoke <grant_id>
  -> revoke row appended to the JSONL store
  -> grant marked revoked; further filesystem_write calls hit Phase 3 again
```

## What this is not

- Not auto-approval rules. v0.12 is interactive only. A future release may add `~/.openwar/policies.json` for rules like "auto-grant filesystem_write under /tmp/*", but that is its own design.
- Not delegation across sessions. A `this_session` grant cannot be promoted to another session; each session has its own ledger. Persistent grants are the supported cross-session surface.
- Not encrypted. Persistent grants live in plain JSONL like the rest of v0.6 project memory.
- Not multi-operator. Single operator only.
- Not a bypass for Phase 3. The gate still fires whenever no grant matches. Cancellation of a destructive call in flight is still a separate concern (v0.11.1).
