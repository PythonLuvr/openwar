---
project: rate-limiter
brief_id: 2026-01-15-E1
scope_locked: true
mode: auto
authorized_costs:
  - filesystem_write
---

# Objective

Add a token-bucket rate limiter to an existing Node HTTP service. The limiter must be per-IP, configurable, and survive process restart without losing the in-flight bucket state.

# Deliverables

- A `src/middleware/rateLimit.ts` module exporting a factory function `createRateLimit(options)`
- Unit tests at `tests/middleware/rateLimit.test.ts` covering happy path, exhaustion, refill, and restart-state recovery
- A short README section under `docs/rate-limit.md` documenting how to wire it up and what the configuration knobs do

# Constraints

- Zero new runtime dependencies. Use only Node stdlib.
- Persistence must be file-backed under `./.cache/ratelimit/`. No external store.
- Default config: 60 requests per minute per IP, burst of 10.
- Public API of the existing service must not change.

# Tools required

- Filesystem (read / write)
- Node test runner via `node --test`

# Notes / unknowns

- The existing service entry is at `src/server.ts`; the middleware should plug in there but the wiring change is part of the deliverable.
- Clock-skew handling: assume monotonic clock from `performance.now()` is acceptable.
