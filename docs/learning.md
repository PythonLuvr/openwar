# Learning from run history (v0.9+)

OpenWar's framing is discipline, not intelligence. v0.9 starts to let the runtime get *sharper* the more you run it, without getting *cleverer*. No second LLM judges the first. Adaptation is heuristic, inspectable, deterministic, and operator-gated.

This release ships in two halves.

| Version | Scope | Status |
|---|---|---|
| v0.9.0 | `openwar history`: read accumulated traces, produce a descriptive report. Counts and quantiles only. No runtime behavior change. | **Shipping.** |
| v0.9.1 | Adaptive autonomy: `openwar learn`, `learned_profile:` frontmatter, runner integration, detector sensitivity. | Deferred until v0.8 trace data accumulates in real use. |

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
