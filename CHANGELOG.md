# Changelog

## 0.2.0

Runtime release. The framework gets a real engine.

### Added

- Node / TypeScript package with a `openwar` CLI.
- Brief parser and validator (markdown + frontmatter), with kebab-case project slugs, optional `brief_id` autogen, scope-lock and mode overrides, and an `authorized_costs` list that pre-approves categories of destructive actions.
- Phase-aware runner enforcing Phase 0 (Confirmation Summary required), Phase 1 (gated or auto-pilot execution), Phase 2 (blocker halt + persist + resume), Phase 3 (destructive flag, explicit per-session approval), and Phase 4 (canonical completion report).
- Deterministic detectors for confirmation, blocker, destructive intent, banned phrases, phase markers, and completion. Regex / pattern based; no second LLM.
- BYOK adapters: Anthropic Claude, OpenAI, Google Gemini, xAI Grok, and an OpenAI-compatible adapter that handles OpenRouter / Groq / Together / Ollama / vLLM / llama.cpp.
- MockAdapter for deterministic offline tests.
- Session persistence at `~/.openwar/sessions/` (one JSON per session + JSONL append-only transcript). `openwar resume <brief_id>` reopens.
- CLI commands: `run`, `resume`, `list`, `inspect`, `validate`, `adapters`, `version`.
- Library surface: `run`, `parseBrief`, `validateBrief`, all adapters, all detectors, and state helpers exported from the package root so integrators (e.g. War Room) can embed the runtime.
- Examples: a gated creative brief and an auto-pilot engineering brief.
- Cross-platform CI (Ubuntu, macOS, Windows on Node 20 and 22) with em-dash and personal-data sanity lints in front of the build / test pipeline.

### Changed

- `openwar.md` clarified: OpenWar is now both a framework (the markdown doc) and a runtime (this package). The "not a runtime" sentence in v0.1 has been removed.

### Notes for War Room integrators

The library surface is stable for v0.2. Re-exporting from `openwar` (root) gives you everything War Room needs to swap its raw adapter path for the OpenWar phase loop in channels where the operator selects the framework.

## 0.1.0

Initial release. System-prompt-only framework. Single markdown file (`openwar.md`), reference brief template, MIT license.
