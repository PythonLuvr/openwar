# Squire fixture snapshot

Source: `@pythonluvr/squire` source repo at `tests/fixtures/`.
Snapshotted from: **Squire v1.1.0** (the version on npm when OpenWar v0.12.1 was authored).
Date snapshotted: 2026-05-19.

These JSONL files are raw stdout streams from real CLI agents. They are
input to Squire's vendor-aware adapters, which parse them into
`SquireEvent[]`. OpenWar's `cli-bridge.ts` then translates those
`SquireEvent` values into OpenWar's `StreamEvent` surface. Re-snapshot
on any Squire minor / major bump that touches the structured-event
shapes; the version header above is the drift trigger.

Contents:

| Path | Source CLI | Notes |
|---|---|---|
| `claude-code/list-files.jsonl` | Claude Code stream-json | Tool use (Glob), thinking, usage, message stop |
| `gemini-cli/list-files.jsonl` | Gemini CLI stream-json | Tool use, thinking, usage, message stop |

Both fixtures cover the same scenario: a single-turn "list files" request
producing one tool call, one tool result, an assistant message, and a
final usage report. Used to exercise the full Squire-parse →
OpenWar-translate chain across both vendor adapters in v0.12.1 tests.
