# Chat (v0.10+)

`openwar chat` collapses the YAML-brief + CLI-flag UX into a conversation. A non-developer describes what they want in plain English. OpenWar asks clarifying questions if needed, proposes a plan, gets approval, executes through the existing phase machine, and surfaces destructive-action prompts as plain English questions.

Discipline preserved: phases, detectors, authorization gates, trace.ndjson, learned profiles all fire identically. The chat layer is a translator between the user and the runtime. It is not a new actor.

---

## Walkthrough

```
$ openwar chat
openwar v0.10.0 chat session started (id: chat-mp93k7-a4b2)
agent: anthropic  exec: cli-bridge  project: my-site
Type your request, or /help for commands.

> hey can you update my landing page to add a testimonials section

a few questions before I start:
  1. which page file should I edit?
  2. where should the testimonials go (above the CTA, in the middle, somewhere else)?
  3. how many testimonials, and do you have real quotes or should I use placeholders?

> /index.html, mid-page below features, three placeholder ones

Plan:
  - Read /index.html and locate the features section
  - Add a testimonials section directly below it with three placeholder testimonials
  - Match the existing styling (tailwind, judging from the rest of the page)
  - Show you the diff before committing anything

Authorized:
  - read files in this directory
  - read and write files in this directory

Not authorized:
  - publish changes to your repository (git push)
  - deploy to a live environment
  - send messages outside this session (Slack, email, etc.)
  If the agent needs any of these during execution, I'll ask you in plain English first.

Proceed? (yes / no / change something)

> yes

working...
  doing: reading a file...
  doing: writing a file...
Added testimonials section to /index.html. The diff matches existing tailwind classes.

Want to save this conversation as a reusable brief? It would let you re-run the same workflow on another input with one command. (use /save [name])

> /save add-testimonials

saved to ~/.openwar/briefs/add-testimonials.md
Replay: openwar run ~/.openwar/briefs/add-testimonials.md

> /quit

chat session saved (id: chat-mp93k7-a4b2). Resume: openwar chat --resume chat-mp93k7-a4b2
```

---

## Architecture (one paragraph)

The conversation agent uses a separate adapter from the execution runtime. The conversation agent must support structured tool-call output (the intent contract: `ask_clarification`, `propose_plan`, `start_execution`, `summarize_result`). cli-bridge does not support tool calls, so cli-bridge is incompatible with the conversation agent. cli-bridge IS supported as the execution adapter via `--exec-adapter cli-bridge --exec-binary claude`, giving you free local execution on your existing Claude Code subscription while keeping intent extraction deterministic via a BYOK key.

---

## Flag surface

```
openwar chat                                  start a fresh session
openwar chat --resume <chat_id> | last        resume saved session
openwar chat --adapter <name>                 conversation-agent adapter override
openwar chat --model <name>                   conversation-agent model override
openwar chat --exec-adapter <name>            execution adapter override (default: same as conversation)
openwar chat --exec-binary <path>             cli-bridge binary for execution (when --exec-adapter cli-bridge)
openwar chat --project <slug>                 load project memory + learned profile
openwar chat --no-save                        do not persist chat to disk
```

## Default conversation-agent adapter precedence

```
1. ANTHROPIC_API_KEY        -> anthropic
2. OPENAI_API_KEY           -> openai
3. GEMINI_API_KEY / GOOGLE_API_KEY -> gemini
4. XAI_API_KEY              -> grok
5. OPENAI_COMPAT_API_KEY    -> openai-compat
```

If none are set, `openwar chat` exits with an install hint pointing at the hand-authored brief path (`openwar run brief.md --adapter cli-bridge --binary claude`), which works without any BYOK key.

---

## Conservative authorization (the load-bearing invariant)

The brief compiler never auto-grants destructive categories. Even when the conversation agent says it intends to `git push` or `deploy`, the compiler routes those through the Phase 3 destructive gate at execution time. The user sees them as natural-language confirms during execution (`"publish this change to your repo?"`) rather than as silent grants in a plan they might skim past.

Auto-granted (the compiler will include these in `authorized_costs` when the agent requests them):

- `filesystem_read`
- `filesystem_write`

Always routed through Phase 3 (regardless of what the agent claims to want):

- `filesystem_delete`
- `shell_exec`
- `http_fetch`
- `paid_api_call`
- `git_write`
- `git_push`
- `deploy`
- `external_message`

Unknown categories are also routed through Phase 3 (safe default). The plan presenter surfaces them in the "Not authorized" list with a reassuring "I'll ask you in plain English first" note.

If you ever see a category from the second list auto-granted in your saved brief, that's a P0 regression in OpenWar. Tests pin the conservative invariant adversarially.

---

## Slash commands

```
/help               show the command list
/save [name]        save the compiled brief to ~/.openwar/briefs/<name>.md
/inspect            print the inspect pointer for the most recent execution
/history            print the conversation buffer so far
/resume <chat_id>   re-run with --resume <id>
/abort              polite abort: ends at next phase boundary (v0.10.0)
/quit               exit; chat log is saved automatically
```

You don't need any of these. Just describe what you want. The commands are an escape hatch for when you do.

---

## Saved briefs

`/save` writes a v0.x-compatible YAML-frontmatter markdown file to `~/.openwar/briefs/<name>.md`. The file includes:

- Standard brief frontmatter (`project`, `mode`, `authorized_costs`, etc.).
- A `# Generated by openwar chat (session: <chat_id>)` header.
- The conversation that compiled to this brief, included as a markdown blockquote under `# Source conversation`.

### Replay semantics

A saved brief replays the deliverables on the named project. **If repo state has drifted since the chat ran, the agent may need different actions.** The brief carries the conversation that compiled it, not a snapshot of the repo state at chat time. This is by design; the brief is a workflow template, not a state restore.

Replay any saved brief with:

```
openwar run ~/.openwar/briefs/<name>.md
```

---

## Project memory and learned profile

When `--project <slug>` is set (or inferred from the working directory basename), `openwar chat`:

1. Reads recent entries from `~/.openwar/projects/<slug>/{decisions,knowledge,constraints}.jsonl` and surfaces them in the conversation agent's context. The agent can reference past work naturally.
2. Loads `~/.openwar/projects/<slug>/learned.json` if present, and stamps `learned_profile: <slug>` into the compiled brief's frontmatter so the runtime applies the profile at execution time (per v0.9.1 semantics).

Both are best-effort. A missing profile, an unreadable memory file, or a schema-mismatched profile produces a warning but does not block the session.

---

## Determinism

The brief compiler is deterministic: the same conversation buffer produces the same brief bit-for-bit. The conversation that feeds the compiler is stochastic (it includes agent turns), so two runs of the same user input may produce different compiled briefs. This is unavoidable given LLM behavior; the deterministic claim scopes to "compiler input -> compiler output" only.

---

## Intent extraction (load-bearing piece)

The conversation agent declares its intent via structured tool calls, not free text. Four tools:

- `ask_clarification` -- ask the user 1-4 questions before proposing a plan
- `propose_plan` -- present a draft brief + plan_text; user approves or refines
- `start_execution` -- signal that the user approved; the session manager verifies against actual user input
- `summarize_result` -- after the runtime reports completion; optionally offers save-brief

If the agent fails to produce a valid tool call (free text only, hallucinated 5th tool, multiple calls, malformed args, fabricated approval), the session manager increments a drift counter. After 3 consecutive drift turns, the user sees a deterministic fallback question. After 5, the session halts cleanly with a save-and-resume pointer.

This contract eliminates the free-text-classification drift that would otherwise dominate chat-style UX. Adversarial fixtures in `tests/chat/intent.test.ts` pin each failure mode.

---

## Windows readline notes

`openwar chat` runs on the Node `readline/promises` interface. A few cross-platform notes:

- **Ctrl-C** installs a SIGINT handler that closes readline cleanly and routes through the `/quit` path so the chat-store gets a proper `chat_session_ended` event. Without this, Node would forward SIGINT to the process and exit immediately with no "session saved" confirmation.
- **EOF on piped stdin** (Ctrl-D on POSIX, Ctrl-Z then Enter on Windows) is treated identically to `/quit`. The session ends cleanly.
- **CRLF line endings** from a Windows-native pipe are parsed correctly. The readline interface strips `\r` from each line before handing it to the chat loop.
- **History** is in-memory only (200-entry buffer). v0.10.0 does not persist readline history across sessions; the chat-store NDJSON is the durable record.
- **Programmatic stdin** (used by tests and integrators embedding `openwar chat` in another tool) sets `terminal: false`, disabling raw mode and ANSI escape interpretation. The `runChatCommand` function accepts optional `stdin` and `stdout` overrides on the options object so embedders can drive the loop from custom streams.

## What's not in v0.10.0 (deferred to v0.10.1)

- **README hero rewrite reframing OpenWar as "the agent runtime non-developers can actually use".** Positioning change waits for non-dev adoption signal from v0.10.0 use. v0.10.0 ships a "New in v0.10" section that opens the chat path; the existing hero stays.
- **Mid-tool-call cancellation.** v0.10.0 ships polite abort: `/abort` ends at the next phase boundary, not mid-tool-call. v0.10.1 adds true mid-call cancel if real users hit the gap.
- **Streaming responses during agent turns.** Batched per-turn is fine; streaming polish later.
- **Multi-channel chat surfaces (Discord, Slack, Telegram).** Terminal `openwar chat` is the v0.10 ship. Multi-channel could come as v0.10.x or v0.11.

## What's definitely not in scope (ever, for v0.10.x)

- Web UI for chat. The dashboard from v0.8 is the web view; chat is terminal-native.
- Voice input.
- Persona customization (OpenClaw's territory).
- Inline file attachments (operator references files by path).
- Multi-task per session (off-topic mid-conversation gets a "remember it for after" response, not a second compile).
- Cost preview infrastructure (the v0.5 tier banner already surfaces through the plan-presentation step).
