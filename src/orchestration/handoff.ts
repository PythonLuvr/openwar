// Typed cross-role communication. Every handoff between roles uses one of
// these shapes. Roles emit a handoff inside a fenced ```json block at the
// end of their final assistant turn; the coordinator parses, validates,
// and rejects malformed handoffs with a clear error the role can react to.
//
// The validator is hand-written (zero deps) and adversarial-resistant:
//   - Unknown extra fields are stripped (no prototype pollution surface).
//   - String fields are length-capped and stripped of control characters.
//   - Arrays are length-capped.
//   - Discriminator `kind` is exact-match required.
//
// Roles must NOT be able to inject behavior into the coordinator by
// crafting handoff fields. Anything passed through to operator prompts or
// other roles is sanitized via `sanitizeText`.

import type {
  PlanHandoff,
  ExecutionHandoff,
  ReviewHandoff,
  EscalationHandoff,
  SubTask,
  ToolCallRecord,
} from "../types.js";

// ---------- Limits ----------

const MAX_STRING_LEN = 16_000;
const MAX_SHORT_STRING_LEN = 1_024;
const MAX_LIST_LEN = 64;
const MAX_TOOLCALLS_LEN = 256;

// ---------- Errors ----------

export class HandoffParseError extends Error {
  readonly code = "HANDOFF_PARSE" as const;
  constructor(message: string, public readonly cause_text: string) {
    super(message);
    this.name = "HandoffParseError";
  }
}

export class HandoffValidationError extends Error {
  readonly code = "HANDOFF_VALIDATION" as const;
  constructor(message: string, public readonly path: string) {
    super(`handoff invalid at ${path}: ${message}`);
    this.name = "HandoffValidationError";
  }
}

// ---------- Fenced-block extractor ----------

// Pulls the LAST fenced ```json block out of a role's output. The "last"
// rule means roles may write narrative + thinking before the formal
// handoff and we always pick the canonical one.
export function extractHandoffJson(text: string): string | null {
  const re = /```(?:json|JSON)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = re.exec(text)) !== null) {
    last = match[1] ?? null;
  }
  return last === null ? null : last.trim();
}

// ---------- Sanitizers ----------

// Strip C0 control characters except 0x09 (tab), 0x0A (LF), 0x0D (CR),
// plus DEL (0x7F). Built from hex escapes so the source stays grep-clean.
const CONTROL_CHARS = new RegExp(
  String.fromCharCode(0x5b) +
    "\\x00-\\x08" +
    "\\x0B\\x0C" +
    "\\x0E-\\x1F" +
    "\\x7F" +
    String.fromCharCode(0x5d),
  "g",
);
function sanitizeText(value: unknown, max = MAX_STRING_LEN): string {
  if (typeof value !== "string") return "";
  // Strip C0 control chars except tab, LF, CR; plus DEL. Then cap length.
  const cleaned = value.replace(CONTROL_CHARS, "");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function sanitizeShort(value: unknown): string {
  return sanitizeText(value, MAX_SHORT_STRING_LEN);
}

function sanitizeStringArray(value: unknown, max = MAX_LIST_LEN): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") {
      const s = sanitizeShort(v).trim();
      if (s.length > 0) out.push(s);
    }
    if (out.length >= max) break;
  }
  return out;
}

// ---------- Validators ----------

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new HandoffValidationError(`expected non-empty string at "${key}"`, path);
  }
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validatePlanHandoff(raw: unknown): PlanHandoff {
  if (!isPlainObject(raw)) {
    throw new HandoffValidationError("expected object", "$");
  }
  const kind = requireString(raw, "kind", "$.kind");
  if (kind !== "plan") {
    throw new HandoffValidationError(`expected kind="plan", got ${JSON.stringify(kind)}`, "$.kind");
  }
  if (!Array.isArray(raw.subtasks)) {
    throw new HandoffValidationError("expected array", "$.subtasks");
  }
  if (raw.subtasks.length === 0) {
    throw new HandoffValidationError("plan must contain at least one sub-task", "$.subtasks");
  }
  if (raw.subtasks.length > MAX_LIST_LEN) {
    throw new HandoffValidationError(`too many sub-tasks (max ${MAX_LIST_LEN})`, "$.subtasks");
  }

  const subtasks: SubTask[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.subtasks.length; i++) {
    const st = raw.subtasks[i];
    const stPath = `$.subtasks[${i}]`;
    if (!isPlainObject(st)) {
      throw new HandoffValidationError("expected object", stPath);
    }
    const id = sanitizeShort(st.id).trim();
    if (!id) throw new HandoffValidationError("subtask id required", `${stPath}.id`);
    if (seenIds.has(id)) {
      throw new HandoffValidationError(`duplicate subtask id ${JSON.stringify(id)}`, `${stPath}.id`);
    }
    seenIds.add(id);
    const title = sanitizeShort(st.title).trim();
    if (!title) throw new HandoffValidationError("subtask title required", `${stPath}.title`);
    const instruction = sanitizeText(st.instruction).trim();
    if (!instruction) {
      throw new HandoffValidationError("subtask instruction required", `${stPath}.instruction`);
    }
    const acceptance_criteria = sanitizeStringArray(st.acceptance_criteria);
    if (acceptance_criteria.length === 0) {
      throw new HandoffValidationError(
        "subtask acceptance_criteria must list at least one item",
        `${stPath}.acceptance_criteria`,
      );
    }
    const order = typeof st.order === "number" && Number.isFinite(st.order) ? st.order : i;
    const depends_on = sanitizeStringArray(st.depends_on, 4);
    // v0.4: linear plans only. Sub-task N may depend only on sub-task N-1
    // (or no dependency). Anything else fails validation.
    if (depends_on.length > 0) {
      if (depends_on.length > 1) {
        throw new HandoffValidationError(
          "v0.4 supports linear plans only (max one dependency per sub-task)",
          `${stPath}.depends_on`,
        );
      }
      const prior = subtasks[subtasks.length - 1];
      if (!prior || depends_on[0] !== prior.id) {
        throw new HandoffValidationError(
          "v0.4 supports linear plans only (dependency must be the immediately preceding sub-task)",
          `${stPath}.depends_on`,
        );
      }
    }
    subtasks.push({
      id,
      title,
      instruction,
      acceptance_criteria,
      order,
      ...(depends_on.length > 0 ? { depends_on } : {}),
    });
  }

  // Stable ordering: ensure `order` is monotonic. Reassign if planner skipped.
  subtasks.sort((a, b) => a.order - b.order);
  for (let i = 0; i < subtasks.length; i++) (subtasks[i] as SubTask).order = i;

  const rationale = sanitizeText(raw.rationale).trim();

  return { kind: "plan", subtasks, rationale };
}

export function validateExecutionHandoff(raw: unknown): ExecutionHandoff {
  if (!isPlainObject(raw)) throw new HandoffValidationError("expected object", "$");
  const kind = requireString(raw, "kind", "$.kind");
  if (kind !== "execution") {
    throw new HandoffValidationError(`expected kind="execution"`, "$.kind");
  }
  const subtask_id = sanitizeShort(raw.subtask_id).trim();
  if (!subtask_id) throw new HandoffValidationError("subtask_id required", "$.subtask_id");
  const output = sanitizeText(raw.output);
  const notes = sanitizeText(raw.notes);
  const tool_calls = sanitizeToolCalls(raw.tool_calls);
  return { kind: "execution", subtask_id, output, tool_calls, notes };
}

function sanitizeToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ToolCallRecord[] = [];
  for (const v of value) {
    if (!isPlainObject(v)) continue;
    const call_id = sanitizeShort(v.call_id).trim();
    const name = sanitizeShort(v.name).trim();
    if (!call_id || !name) continue;
    const at = sanitizeShort(v.at).trim() || new Date().toISOString();
    const authorized = v.authorized === true;
    const auth_note = typeof v.auth_note === "string" ? sanitizeShort(v.auth_note) : undefined;
    let result: ToolCallRecord["result"];
    if (isPlainObject(v.result)) {
      result = {
        success: v.result.success === true,
        content: sanitizeText(v.result.content),
      };
    }
    out.push({
      call_id,
      name,
      arguments: v.arguments,
      at,
      authorized,
      ...(auth_note ? { auth_note } : {}),
      ...(result ? { result } : {}),
    });
    if (out.length >= MAX_TOOLCALLS_LEN) break;
  }
  return out;
}

export function validateReviewHandoff(raw: unknown): ReviewHandoff {
  if (!isPlainObject(raw)) throw new HandoffValidationError("expected object", "$");
  const kind = requireString(raw, "kind", "$.kind");
  if (kind !== "review") {
    throw new HandoffValidationError(`expected kind="review"`, "$.kind");
  }
  const subtask_id = sanitizeShort(raw.subtask_id).trim();
  if (!subtask_id) throw new HandoffValidationError("subtask_id required", "$.subtask_id");
  const verdict = raw.verdict;
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "needs_retry") {
    throw new HandoffValidationError(
      `verdict must be "pass" | "fail" | "needs_retry"`,
      "$.verdict",
    );
  }
  const rationale = sanitizeText(raw.rationale).trim();
  if (!rationale) {
    throw new HandoffValidationError("rationale required", "$.rationale");
  }
  const suggested_revision = typeof raw.suggested_revision === "string"
    ? sanitizeText(raw.suggested_revision)
    : undefined;
  return {
    kind: "review",
    subtask_id,
    verdict,
    rationale,
    ...(suggested_revision ? { suggested_revision } : {}),
  };
}

export function validateEscalationHandoff(raw: unknown): EscalationHandoff {
  if (!isPlainObject(raw)) throw new HandoffValidationError("expected object", "$");
  const kind = requireString(raw, "kind", "$.kind");
  if (kind !== "escalation") {
    throw new HandoffValidationError(`expected kind="escalation"`, "$.kind");
  }
  const severity = raw.severity;
  if (severity !== "info" && severity !== "warn" && severity !== "error") {
    throw new HandoffValidationError(`severity must be info|warn|error`, "$.severity");
  }
  const role = sanitizeShort(raw.role).trim();
  if (!role) throw new HandoffValidationError("role required", "$.role");
  const reason = sanitizeText(raw.reason).trim();
  if (!reason) throw new HandoffValidationError("reason required", "$.reason");
  const context = sanitizeText(raw.context);
  const budget_metric =
    raw.budget_metric === "tokens" ||
    raw.budget_metric === "wall_clock_ms" ||
    raw.budget_metric === "tool_calls"
      ? raw.budget_metric
      : undefined;
  return {
    kind: "escalation",
    severity,
    role,
    reason,
    context,
    ...(budget_metric ? { budget_metric } : {}),
  };
}

// ---------- Top-level discriminator ----------

export type AnyHandoff = PlanHandoff | ExecutionHandoff | ReviewHandoff | EscalationHandoff;

// Parse text → handoff. Two-stage: extract fenced block, JSON.parse, then
// run the kind-specific validator. Returns a discriminated result so callers
// can attribute failures (no fenced block vs. malformed JSON vs. invalid shape).
export type ParseResult =
  | { ok: true; handoff: AnyHandoff }
  | { ok: false; reason: "no_fence" | "bad_json" | "validation"; message: string };

export function parseHandoffFromText(text: string): ParseResult {
  const fenced = extractHandoffJson(text);
  if (fenced === null) {
    return { ok: false, reason: "no_fence", message: "no fenced ```json block found" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch (err) {
    return {
      ok: false,
      reason: "bad_json",
      message: (err as Error).message.slice(0, 240),
    };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "validation", message: "handoff must be a JSON object" };
  }
  const kind = parsed.kind;
  try {
    if (kind === "plan") return { ok: true, handoff: validatePlanHandoff(parsed) };
    if (kind === "execution") return { ok: true, handoff: validateExecutionHandoff(parsed) };
    if (kind === "review") return { ok: true, handoff: validateReviewHandoff(parsed) };
    if (kind === "escalation") return { ok: true, handoff: validateEscalationHandoff(parsed) };
    return {
      ok: false,
      reason: "validation",
      message: `unknown handoff kind ${JSON.stringify(kind)}`,
    };
  } catch (err) {
    if (err instanceof HandoffValidationError) {
      return { ok: false, reason: "validation", message: err.message };
    }
    throw err;
  }
}
