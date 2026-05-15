---
project: rename-symbol
brief_id: 2026-05-15-001
scope_locked: true
mode: auto
authorized_costs:
  - filesystem_write
---

# Objective

Rename every occurrence of the function `getCwd` to `getCurrentWorkingDirectory` in this workdir's TypeScript files, leaving non-TS files alone. Update both definitions and callers.

# Deliverables

- All `.ts` files in the workdir updated.
- A short summary of how many files were changed and a list of paths.

# Constraints

- Don't touch `node_modules`, `dist`, or `.git`.
- One rename, no scope creep. Do not "improve" code along the way.
- No git operations. The operator will commit.

# Tools required

- `list_dir` to enumerate `.ts` files.
- `read_file` to inspect each file before modifying.
- `apply_patch` to write changes.

# Notes / unknowns

- The rename should be exact; partial matches (e.g. `getCwdInternal`) stay untouched.
