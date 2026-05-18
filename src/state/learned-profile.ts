// v0.9.1: learned profile schema + load/save. The runner reads this file at
// session start when a brief sets `learned_profile: <slug>`. Atomic writes via
// tmp+rename (same pattern as memory.ts; this is low-frequency persistence,
// not a high-frequency log).

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { projectDir } from "./paths.js";
import { stringifyDeterministic } from "./history.js";
import type {
  DetectorRecommendation,
  PhaseBudgetRecommendation,
  ToolUsageRecommendation,
  Sensitivity,
} from "./heuristics.js";

export const LEARNED_PROFILE_SCHEMA_VERSION = 1;

export interface LearnedProfile {
  schema_version: number;
  slug: string;
  generated_at: string;
  source_runs: string[];
  detector_overrides: Record<
    string,
    {
      sensitivity: Sensitivity;
      reason: string;
      fire_rate: number;
      sample_size: number;
    }
  >;
  phase_budgets: Record<
    string,
    {
      tool_calls: number;
      observed_p50: number;
      observed_p90: number;
      sample_size: number;
    }
  >;
  tool_usage: Record<
    string,
    {
      calls: number;
      last_used: string | null;
      dead: boolean;
    }
  >;
  notes: string[];
}

export function learnedProfilePath(slug: string): string {
  return join(projectDir(slug), "learned.json");
}

export class LearnedProfileSchemaError extends Error {
  readonly code: "MISSING_VERSION" | "VERSION_MISMATCH" | "PARSE" | "SHAPE";
  readonly path: string;
  constructor(code: "MISSING_VERSION" | "VERSION_MISMATCH" | "PARSE" | "SHAPE", path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.name = "LearnedProfileSchemaError";
  }
}

export function profileExists(slug: string): boolean {
  return existsSync(learnedProfilePath(slug));
}

export function loadLearnedProfile(slug: string): LearnedProfile | null {
  const path = learnedProfilePath(slug);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new LearnedProfileSchemaError("PARSE", path, `Cannot read learned profile: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LearnedProfileSchemaError("PARSE", path, `Malformed JSON in learned profile: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LearnedProfileSchemaError("SHAPE", path, `Learned profile root must be a JSON object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!("schema_version" in obj)) {
    throw new LearnedProfileSchemaError(
      "MISSING_VERSION",
      path,
      `Learned profile is missing schema_version. Regenerate via 'openwar learn <slug> --apply'.`,
    );
  }
  if (obj.schema_version !== LEARNED_PROFILE_SCHEMA_VERSION) {
    throw new LearnedProfileSchemaError(
      "VERSION_MISMATCH",
      path,
      `Learned profile schema_version=${String(obj.schema_version)} does not match runtime version ${LEARNED_PROFILE_SCHEMA_VERSION}. Regenerate via 'openwar learn <slug> --apply'.`,
    );
  }
  // Light shape validation. Full validation would duplicate the type system;
  // we trust that anyone editing this file by hand reads docs/learning.md.
  for (const field of ["slug", "generated_at", "source_runs", "detector_overrides", "phase_budgets", "tool_usage", "notes"]) {
    if (!(field in obj)) {
      throw new LearnedProfileSchemaError(
        "SHAPE",
        path,
        `Learned profile missing required field: ${field}.`,
      );
    }
  }
  return obj as unknown as LearnedProfile;
}

export function saveLearnedProfile(profile: LearnedProfile): string {
  const path = learnedProfilePath(profile.slug);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic via tmp + rename. Low-frequency write so the cost is fine.
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, stringifyDeterministic(profile) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

export function deleteLearnedProfile(slug: string): boolean {
  const path = learnedProfilePath(slug);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// Convenience builder. Assembles a profile from heuristic recommendation
// arrays. Keeps the learn subcommand thin.

export interface BuildProfileInput {
  slug: string;
  source_runs: readonly string[];
  detectors: readonly DetectorRecommendation[];
  phase_budgets: readonly PhaseBudgetRecommendation[];
  tools: readonly ToolUsageRecommendation[];
  notes: readonly string[];
  // Override for tests; production uses new Date().toISOString().
  generated_at?: string;
}

export function buildLearnedProfile(input: BuildProfileInput): LearnedProfile {
  const detector_overrides: LearnedProfile["detector_overrides"] = {};
  for (const d of input.detectors) {
    detector_overrides[d.detector] = {
      sensitivity: d.sensitivity,
      reason: d.reason,
      fire_rate: d.fire_rate,
      sample_size: d.sample_size,
    };
  }
  const phase_budgets: LearnedProfile["phase_budgets"] = {};
  for (const p of input.phase_budgets) {
    phase_budgets[p.phase] = {
      tool_calls: p.tool_calls,
      observed_p50: p.observed_p50,
      observed_p90: p.observed_p90,
      sample_size: p.sample_size,
    };
  }
  const tool_usage: LearnedProfile["tool_usage"] = {};
  for (const t of input.tools) {
    tool_usage[t.tool] = {
      calls: t.calls,
      last_used: t.last_used,
      dead: t.dead,
    };
  }
  return {
    schema_version: LEARNED_PROFILE_SCHEMA_VERSION,
    slug: input.slug,
    generated_at: input.generated_at ?? new Date().toISOString(),
    source_runs: [...input.source_runs].sort(),
    detector_overrides,
    phase_budgets,
    tool_usage,
    notes: [...input.notes],
  };
}

// Helper used by the runner: derive a DetectorSensitivityMap from a loaded
// profile. The map is what gets threaded through the detector pass.

export type DetectorSensitivityMap = Record<string, Sensitivity>;

export function sensitivityMapFromProfile(profile: LearnedProfile): DetectorSensitivityMap {
  const map: DetectorSensitivityMap = {};
  for (const [name, override] of Object.entries(profile.detector_overrides)) {
    map[name] = override.sensitivity;
  }
  return map;
}
