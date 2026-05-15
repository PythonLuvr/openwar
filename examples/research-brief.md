---
project: research-snapshot
brief_id: 2026-05-15-002
scope_locked: false
mode: gated
authorized_costs:
  - filesystem_write
  - http_fetch
---

# Objective

Pull the latest README of three open-source projects and save them as separate files in this workdir for offline reading.

# Deliverables

- `research/react.md` (text of facebook/react README)
- `research/svelte.md` (text of sveltejs/svelte README)
- `research/solid.md` (text of solidjs/solid README)
- A short summary in `research/index.md` listing the files and their sizes.

# Constraints

- Use only the GitHub raw content URL (`raw.githubusercontent.com`).
- Skip any project whose fetch fails. Note the failure in `index.md` instead of crashing.
- No code modifications outside `research/`.

# Tools required

- `http_fetch` for each README URL.
- `write_file` to save each result.

# Notes / unknowns

- If `~/.openwar/http-allow.json` is configured, ensure `raw.githubusercontent.com` and `*.githubusercontent.com` are allowed.
