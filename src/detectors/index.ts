import type { DetectorSnapshot } from "../types.js";
import { detectConfirmationSummary } from "./confirmation-summary.js";
import { detectBlocker } from "./blocker.js";
import { detectDestructive } from "./destructive.js";
import { detectBannedPhrases } from "./banned-phrases.js";
import { detectPhaseMarkers } from "./phase-marker.js";
import { detectCompletion } from "./completion.js";
import { isSafetyCritical, type Sensitivity } from "../state/heuristics.js";
import type { DetectorSensitivityMap } from "../state/learned-profile.js";

export {
  detectConfirmationSummary,
  detectBlocker,
  detectDestructive,
  detectBannedPhrases,
  detectPhaseMarkers,
  detectCompletion,
};

// v0.9.1: per-detector consultation record. The runner reads this to emit
// `learned_sensitivity_consulted` trace events: one per detector that had
// a non-default sensitivity applied, with whether it fired or was suppressed.
export interface DetectorConsultation {
  detector: string;
  sensitivity: Sensitivity;
  fired: boolean;
  // True when the detector was bypassed entirely because sensitivity was
  // "disabled" and the detector is not safety_critical. Records explicitly
  // so the operator can audit that no real signal was missed.
  bypassed: boolean;
}

export interface SnapshotResult {
  snapshot: DetectorSnapshot;
  // Empty when no DetectorSensitivityMap was provided OR every detector ran
  // at default sensitivity. Populated when at least one detector consulted
  // a non-default sensitivity.
  consultations: DetectorConsultation[];
}

// Convenience: run every detector against a single agent turn.
//
// v0.9.1: the optional `sensitivities` map applies per-detector overrides.
// `disabled` is honored only for non-safety-critical detectors; safety
// detectors (blocker, destructive, completion, confirmation) ignore disabled
// and fall back to default. The consultation record surfaces which
// detectors had a non-default sensitivity so the runner can emit trace.
export function snapshot(
  output: string,
  ctx: { authorized_costs?: string[]; sensitivities?: DetectorSensitivityMap } = {},
): DetectorSnapshot {
  return snapshotWithConsultations(output, ctx).snapshot;
}

export function snapshotWithConsultations(
  output: string,
  ctx: { authorized_costs?: string[]; sensitivities?: DetectorSensitivityMap } = {},
): SnapshotResult {
  const sensitivities = ctx.sensitivities ?? {};
  const consultations: DetectorConsultation[] = [];

  // Per-detector effective sensitivity. Safety-critical detectors that are
  // configured `disabled` are bumped back to `default` (and recorded in the
  // consultation as a non-bypass + sensitivity=default for the audit trail).
  function effective(name: string, raw: Sensitivity | undefined): { eff: Sensitivity; bypassed: boolean } {
    if (!raw || raw === "default") return { eff: "default", bypassed: false };
    if (raw === "disabled") {
      if (isSafetyCritical(name)) {
        // Safety-critical: force default; we still record the original
        // sensitivity below so the audit trail shows the override was
        // attempted-and-blocked.
        return { eff: "default", bypassed: false };
      }
      return { eff: "disabled", bypassed: true };
    }
    return { eff: raw, bypassed: false };
  }

  function consult(name: string, raw: Sensitivity | undefined, fired: boolean, bypassed: boolean): void {
    if (!raw || raw === "default") return; // No consultation record for default.
    consultations.push({ detector: name, sensitivity: raw, fired, bypassed });
  }

  const eConfirm = effective("confirmation", sensitivities.confirmation);
  const confirmation = eConfirm.bypassed
    ? undefined
    : detectConfirmationSummary(output, eConfirm.eff);
  consult("confirmation", sensitivities.confirmation, !!confirmation?.found, eConfirm.bypassed);

  const eBlock = effective("blocker", sensitivities.blocker);
  const blocker = eBlock.bypassed ? undefined : detectBlocker(output, eBlock.eff);
  consult("blocker", sensitivities.blocker, !!blocker?.blocked, eBlock.bypassed);

  const eDest = effective("destructive", sensitivities.destructive);
  const destructive = eDest.bypassed
    ? undefined
    : detectDestructive(output, ctx.authorized_costs ?? [], eDest.eff);
  consult("destructive", sensitivities.destructive, !!destructive?.destructive, eDest.bypassed);

  const eBanned = effective("banned_phrases", sensitivities.banned_phrases);
  const banned_phrases = eBanned.bypassed
    ? undefined
    : detectBannedPhrases(output, eBanned.eff);
  consult("banned_phrases", sensitivities.banned_phrases, !!banned_phrases && banned_phrases.count > 0, eBanned.bypassed);

  const ePhase = effective("phase_marker", sensitivities.phase_marker);
  const phase_marker = ePhase.bypassed ? undefined : detectPhaseMarkers(output, ePhase.eff);
  consult("phase_marker", sensitivities.phase_marker, !!phase_marker && phase_marker.declared.length > 0, ePhase.bypassed);

  const eComp = effective("completion", sensitivities.completion);
  const completion = eComp.bypassed ? undefined : detectCompletion(output, eComp.eff);
  consult("completion", sensitivities.completion, !!completion?.complete, eComp.bypassed);

  const snap: DetectorSnapshot = {};
  if (confirmation) snap.confirmation = confirmation;
  if (blocker) snap.blocker = blocker;
  if (destructive) snap.destructive = destructive;
  if (banned_phrases) snap.banned_phrases = banned_phrases;
  if (phase_marker) snap.phase_marker = phase_marker;
  if (completion) snap.completion = completion;

  return { snapshot: snap, consultations };
}
