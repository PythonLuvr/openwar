---
project: multi-agent-demo
brief_id: 2026-02-01-M1
scope_locked: true
mode: auto
authorized_costs:
  - filesystem_read
  - filesystem_write
roles:
  - planner
  - executor
  - reviewer
budgets:
  max_tokens: 80000
  max_wall_clock_minutes: 25
  max_tool_calls_per_subtask: 12
  max_retries_per_subtask: 3
---

# Objective

Stand up a tiny static-site generator in pure Node. Take a directory of markdown files and produce a directory of HTML files, with a per-page title pulled from the first h1.

# Deliverables

- `src/ssg.ts` exporting a single `build(srcDir, outDir)` function.
- `tests/ssg.test.ts` covering at least: a happy-path build, a missing-h1 fallback, and a non-existent source directory.
- A short usage section in `docs/ssg.md` showing the call pattern.

# Constraints

- No new runtime dependencies. Node stdlib only.
- HTML output must be UTF-8 with a Content-Type-friendly `<meta charset>` tag.
- Do not invent a CSS framework. No styling beyond the bare `<html><body>` shell.

# Tools required

- Filesystem read and write.

# Notes / unknowns

- Front-matter parsing is out of scope. Treat the entire markdown file as body content; the title is whatever comes after the first `#`.
- If a file has no h1, the title falls back to the file's basename.
