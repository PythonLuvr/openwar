# Learning from run history (v0.9+)

OpenWar's framing is discipline, not intelligence. v0.9 starts to let the runtime get *sharper* the more you run it, without getting *cleverer*. No second LLM judges the first. Adaptation is heuristic, inspectable, deterministic, and operator-gated.

This release ships in two halves.

| Version | Scope | Status |
|---|---|---|
| v0.9.0 | `openwar history`: read accumulated traces, produce a descriptive report. Counts and quantiles only. No runtime behavior change. | **Shipped.** |
| v0.9.1 | Adaptive autonomy plumbing: `openwar learn`, `learned_profile:` frontmatter, runner integration, detector sensitivity. Conservative thresholds make the system a no-op until run ~10. | **Shipped.** |
| v0.9.2+ | Threshold tuning against real distributions. Patch releases adjust the constants in `src/state/heuristics.ts`. | Pending real-run data. |

v0.9.0 is descriptive. v0.9.1 will be prescriptive. The split exists because adapting against synthetic / thin samples ships footguns. The data foundation has to exist before recommendations against it can be load-bearing.

---

## What v0.9.0 ships

```
openwar history <project_slug>
openwar history <project_slug> --since <ISO>
openwar history <project_slug> --min-samples <N>
openwar history <project_slug> --json
openwar inspect <brief_id> --history    # show the history report for the brief's project
```

The report covers four sections, each derived deterministically from trace events alone:

1. **Tool usage**: per-tool call count, last-used timestamp, "dead" flag when zero calls across a sufficient sample.
2. **Phase tool-call distribution**: P50 / P90 / max per phase, computed by attributing each `tool_call` event to the most recent `phase_enter`.
3. **Detector fire rates**: count per detector + fires per run.
4. **Phase timing**: total `duration_ms` per phase across all runs, plus average.

The report is descriptive. v0.9.0 makes no recommendation, applies nothing at runtime, and does not write any profile to disk.

---

## Per-detector false-positive semantics (locked for v0.9.1)

v0.9.1 will recommend detector sensitivity adjustments. Doing that requires a precise definition of "false positive" per detector. Locking it here so v0.9.1 codes to a spec, not a vibe.

A detector "fires" when its predicate returns truthy. Whether that fire was "right" is detector-specific:

### `blocker`

- **True positive**: fired AND the session halted at Phase 2 AND was not resumed with new context.
- **False positive**: fired AND the session was resumed with continued execution AND completed cleanly.
- **Undefined**: fired AND the session was resumed AND the resume itself halted. (Treat as 0.5 weight; the original blocker was at least partly real.)

The rare path where blocker FP is actually computable is: resume after blocker, then clean Phase 4. v0.8 captures phase transitions and final phase in session metadata. Sample size will be small.

### `destructive`

- **True positive**: fired AND the operator answered `n` at the Phase 3 prompt.
- **False positive**: fired AND the operator answered `y` or `Y`. (Approval means the action was authorized in context; the detector was correct to flag it but the operator's call overrode.)
- **Calibration trap**: "false positive" here does NOT mean "the detector was wrong to fire." It means "the detector fired on something the operator considered safe in context." v0.9.1 must surface this distinction in the inspect output so the operator does not interpret a high destructive FP rate as "the detector is broken." It is doing its job.

### `banned_phrases`

- No operator-override path exists today. The runtime warns but does not gate.
- **FP rate is undefined.** v0.9.1 will not recommend sensitivity changes for this detector. The history report counts fires only.

### `phase_marker`

- No gating effect. Pure observation.
- **FP rate is undefined.** Same as banned_phrases.

### `confirmation`

- Fires in Phase 0. Required to advance.
- **FP rate is undefined** (the runtime cannot proceed without it firing; FP would mean "fired without the operator accepting," which is the intake re-prompt path; we treat that as detector working as designed).

### `completion`

- **True positive**: fired AND the session reached Phase 4 (`done`).
- **False positive**: fired AND the session did not reach Phase 4 (operator intervened, blocker hit, max_steps).

The runtime currently halts on completion fire and proceeds to Phase 4. The only way completion is FP is if the runtime intervened between fire and Phase 4 transition (rare; max_steps is the realistic case).

### Safety-critical flag (v0.9.1)

Detectors get a `safety_critical: boolean` field:

| Detector | safety_critical | v0.9.1 can recommend `disabled`? |
|---|---|---|
| blocker | true | no, capped at `loose` |
| destructive | true | no, capped at `loose` |
| completion | true | no, capped at `loose` |
| confirmation | true | no, capped at `loose` |
| banned_phrases | false | yes |
| phase_marker | false | yes |

The cap protects against a per-project FP rate convincing the operator to silence a detector that catches real failures on a future brief that drifts.

### Sample-size thresholds (v0.9.1)

No recommendation fires until the sample is meaningful. v0.9.0 inherits this rule for the `dead` flag on tools (only set when sample ≥ 3). v0.9.1 raises the bar:

| Recommendation | Min sample |
|---|---|
| Tool dead | 3 |
| Detector sensitivity `loose` | 5 |
| Detector sensitivity `disabled` (non-safety-critical only) | 10 |
| Phase budget | 5 |

These numbers are guesses. v0.9.1 may revise them once real distributions surface.

---

## Phase attribution

Every `tool_call` event in v0.8 is attributed to a phase by walking the event stream and crediting the call to the most recent `phase_enter`. The walker is in `src/state/history.ts` (`attributeToolCallsToPhases`). v0.9.1 inherits the same walker for budget math; the history report uses it for the per-phase P50 / P90 / max columns.

A trace whose `phase_enter` event for a phase is missing (a corrupted middle line) credits subsequent tool calls to the previous known phase. Corrupted lines are surfaced separately in the report's footer.

---

## Determinism guarantee

Same trace inputs produce the same report bit-for-bit:

- `source_runs` arrays sorted lexicographically.
- JSON serialization with sorted object keys.
- Map iteration via explicit sort.

The deterministic invariant is tested in `tests/state/history.test.ts`. Breaking it requires updating the test.

---

## File layout

v0.9.0 reads from existing v0.8 trace files:

```
~/.openwar/sessions/<brief_id>.trace.ndjson
```

v0.9.0 writes nothing. v0.9.1 will write `~/.openwar/projects/<slug>/learned.json`.

Override the trace directory with `OPENWAR_SESSIONS_DIR` (introduced in v0.8).

---

## What gets revisited in v0.9.1

- Implicit vs explicit `learned_profile:` (lean explicit; decide after one quarter of v0.9.0 use).
- Profile discovery rules.
- Recommendation expiry: do old runs auto-age out, or is `--since` always operator-driven?
- A/B harness for sensitivity tuning.

All deferred. v0.9.0 is intentionally narrower.

---

## v0.9.1 plumbing layer

v0.9.1 ships the runtime plumbing for adaptive autonomy with conservative defaults. The system is a no-op for the first 9 runs against any project; the first usable recommendation arrives around run 10. v0.9.2+ patch releases tune the constants in `src/state/heuristics.ts` against real observation.

### `openwar learn <slug>`

```
openwar learn <slug>                       # dry run: print candidate profile + diff vs existing
openwar learn <slug> --apply               # write ~/.openwar/projects/<slug>/learned.json
openwar learn <slug> --reset               # delete existing profile
openwar learn <slug> --since <ISO>         # only consider traces newer than the timestamp
openwar learn <slug> --min-samples <N>     # floor 5; default 10
openwar learn <slug> --emit-frontmatter    # print the YAML snippet for paste-into-brief
```

### Threshold constants

All thresholds live in `src/state/heuristics.ts` as named constants with a paragraph each explaining what would justify lowering them. Patch releases change these constants and document the observation that justified the change in the CHANGELOG. `tests/state/heuristics.test.ts` pins the current values so an accidental tuning fails CI.

| Constant | v0.9.1 value | What it gates |
|---|---|---|
| `DETECTOR_LOOSE_FIRE_RATE_BAR` | 0.85 | Min fires-per-run to recommend `loose` |
| `DETECTOR_LOOSE_MIN_SAMPLES` | 10 | Min runs for any loose recommendation |
| `DETECTOR_DISABLED_FIRE_RATE_BAR` | 0.95 | Min fires-per-run to recommend `disabled` (non-safety only) |
| `DETECTOR_DISABLED_MIN_SAMPLES` | 20 | Min runs for any disabled recommendation |
| `PHASE_BUDGET_MIN_SAMPLES` | 10 | Min runs reaching a phase before recommending a budget |
| `PHASE_BUDGET_FORMULA` | "p90+5" | Recommended budget is `ceil(p90) + 5` |
| `DEAD_TOOL_MIN_SAMPLES` | 10 | Min runs before declaring a tool dead |

### Brief frontmatter

```yaml
---
project: my-project
brief_id: 2026-05-20-X
scope_locked: true
authorized_costs:
  - generation_credits
learned_profile: my-project        # explicit only; no auto-discovery from project slug
---
```

### Runtime behavior

When `learned_profile:` is set:

1. Runner loads `~/.openwar/projects/<slug>/learned.json` at session start.
2. Detector sensitivity overrides thread through the detector pass via `DetectorSensitivityMap`.
3. `safety_critical: true` detectors (blocker, destructive, completion, confirmation) ignore `disabled` and fall back to `default`. The consultation record surfaces the attempted override for audit.
4. Phase budgets apply to `max_steps` in single-agent runs. Multi-agent coordinator runs ignore learned phase budgets in v0.9.1 (different budget primitives; revisited in v0.9.2+).
5. Brief-explicit settings always win. There is no current brief field that competes with learned sensitivity, but the precedence order is `brief > learned > defaults`.

Missing profile file is a soft warning, not an error. The run proceeds with defaults. Schema-version mismatch raises a hard error with a regenerate-via-`openwar learn` remediation.

### Trace events

Three new event types in the v0.8 union (additive, no schema bump):

| Event | Fires when |
|---|---|
| `learned_profile_applied` | Once at session start, when a profile loads. Carries counts of detector overrides, phase budgets, and dead-tool callouts. |
| `learned_sensitivity_consulted` | Per detector consultation with non-default sensitivity. Records the sensitivity value and whether the detector fired or was suppressed. |
| `learned_budget_consulted` | At each phase enter, with the recommended budget, the actually-applied value, and the source (`learned`, `brief`, or `default`). |

See `docs/observability.md` for the full event reference.

### `openwar inspect <brief_id> --learned`

Shows the on-disk profile for the brief's project slug plus consultation history from the brief's trace. Render:

```
Learned profile view
  brief_id:       <id>
  slug:           <slug>
  generated_at:   <ISO>
  schema_version: 1
  source_runs:    N

Detector overrides:
  detector       sensitivity  flag             fire_rate  sample  reason
  blocker        loose        safety_critical  0.91       12      ...

Phase budgets:
  phase    tool_calls  p50  p90  sample
  execute  18          8    13   12

Tool usage:
  tool        calls  last_used               flag
  shell_exec  0      -                       DEAD

Consultation summary:
  Applied at: <ISO>
  Counts:     detectors=1 budgets=1 dead=1
  Detector consultations: 14
    fired:      3
    suppressed: 11

Notes:
  - v0.9.1 conservative thresholds active: ...
```

### Out of scope (deferred to v0.9.2+)

- Threshold tuning against observed real-world distributions.
- Per-detector "strict" semantics (the parameter is accepted but treated as default in v0.9.1).
- Multi-agent coordinator budget integration.
- Auto-recommendation expiry / age-off.
- A/B sensitivity-tuning harness.
- OpenTelemetry export of the three new event types.
