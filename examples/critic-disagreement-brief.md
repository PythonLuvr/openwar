---
project: critic-disagree-demo
brief_id: 2026-02-01-C1
scope_locked: true
mode: auto
authorized_costs:
  - filesystem_read
  - filesystem_write
roles:
  - planner
  - executor
  - reviewer
  - critic
budgets:
  max_tokens: 60000
  max_wall_clock_minutes: 20
  max_tool_calls_per_subtask: 10
  max_retries_per_subtask: 2
---

# Objective

Write a function that returns whether a year is a leap year in the Gregorian calendar. Provide three small unit tests covering common edge cases.

# Deliverables

- `src/leap.ts` exporting `isLeap(year: number): boolean`.
- `tests/leap.test.ts` covering at least: divisible-by-4-but-not-100, divisible-by-100-but-not-400, divisible-by-400.

# Constraints

- Single-file implementation. No date library imports.
- No mutation. The function is pure.

# Tools required

- Filesystem read and write.

# Notes / unknowns

- This brief is intentionally small so that the four-role flow is easy to follow end-to-end. The reviewer and critic should agree most of the time. When they disagree, the coordinator halts on Phase 2 and asks you which verdict to accept.
- Negative years (BCE) are out of scope; the function may assume `year >= 0`.
