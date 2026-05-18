// v0.6: write_project_memory native tool. filesystem_write; Phase 3 prompts
// unless the brief pre-approves filesystem_write in authorized_costs (which
// is the same gate every other persistence write uses).
//
// Appends an entry to the named category. Schema varies per category:
//   decisions   { summary, rationale, superseded_by?, metadata? }
//   knowledge   { content, metadata? }
//   constraints { rule, rationale?, metadata? }

import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from "../types.js";
import { appendMemoryEntry, MEMORY_CATEGORIES, type MemoryCategory } from "../../state/memory.js";
import { isAborted, cancelledResult } from "./_cancellation.js";

export const WRITE_PROJECT_MEMORY_DEFINITION: ToolDefinition = {
  name: "write_project_memory",
  description:
    "Append an entry to the project's memory store. The brief's `project` field scopes the write. " +
    "Categories and required fields: " +
    "decisions { summary, rationale, superseded_by? }; " +
    "knowledge { content }; " +
    "constraints { rule, rationale? }. " +
    "Optional `metadata` object on any entry. Writes are atomic; corrupted-line recovery on read.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: [...MEMORY_CATEGORIES] },
      // Per-category shape lives in `entry`. Validation in the executor
      // because JSON Schema's union types are awkward across adapters.
      entry: {
        type: "object",
        description: "Per-category entry body. See description for required fields.",
      },
    },
    required: ["category", "entry"],
  },
  origin: "native",
  authorization_categories: ["filesystem_write"],
};

interface WriteArgs {
  category: MemoryCategory;
  entry: Record<string, unknown>;
}

function parseArgs(call: ToolCall): WriteArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.category !== "string" || !MEMORY_CATEGORIES.includes(a.category as MemoryCategory)) {
    return { error: `category must be one of: ${MEMORY_CATEGORIES.join(", ")}` };
  }
  if (typeof a.entry !== "object" || a.entry === null || Array.isArray(a.entry)) {
    return { error: "entry must be an object matching the category schema" };
  }
  return {
    category: a.category as MemoryCategory,
    entry: a.entry as Record<string, unknown>,
  };
}

function validateEntryShape(
  category: MemoryCategory,
  entry: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (category === "decisions") {
    if (typeof entry.summary !== "string" || !entry.summary.trim()) {
      return { ok: false, reason: "decisions entry requires non-empty `summary` string" };
    }
    if (typeof entry.rationale !== "string" || !entry.rationale.trim()) {
      return { ok: false, reason: "decisions entry requires non-empty `rationale` string" };
    }
    if (entry.superseded_by !== undefined && typeof entry.superseded_by !== "string") {
      return { ok: false, reason: "`superseded_by` must be a string if provided" };
    }
    return { ok: true };
  }
  if (category === "knowledge") {
    if (typeof entry.content !== "string" || !entry.content.trim()) {
      return { ok: false, reason: "knowledge entry requires non-empty `content` string" };
    }
    return { ok: true };
  }
  // constraints
  if (typeof entry.rule !== "string" || !entry.rule.trim()) {
    return { ok: false, reason: "constraints entry requires non-empty `rule` string" };
  }
  if (entry.rationale !== undefined && typeof entry.rationale !== "string") {
    return { ok: false, reason: "`rationale` must be a string if provided" };
  }
  return { ok: true };
}

export const writeProjectMemoryExecutor: ToolExecutor = async (
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> => {
  const parsed = parseArgs(call);
  if ("error" in parsed) {
    return {
      call_id: call.id,
      success: false,
      content: parsed.error,
      error: { code: "INVALID_ARGS", message: parsed.error },
    };
  }
  const slug = ctx.project_slug;
  if (!slug) {
    return {
      call_id: call.id,
      success: false,
      content: "no project slug in session context; memory tools require a brief with `project:` set",
      error: { code: "NO_PROJECT", message: "no project slug in session context" },
    };
  }
  const shape = validateEntryShape(parsed.category, parsed.entry);
  if (!shape.ok) {
    return {
      call_id: call.id,
      success: false,
      content: shape.reason,
      error: { code: "INVALID_ENTRY", message: shape.reason },
    };
  }
  const start = Date.now();
  if (isAborted(ctx.signal)) return cancelledResult(call, "", start);
  // Strip `id`, `at`, `category` if the caller passed them; we set those.
  const { id: _id, at: _at, category: _cat, brief_id: providedBriefId, metadata, ...rest } = parsed.entry as Record<string, unknown>;
  void _id; void _at; void _cat;
  const body = {
    ...rest,
    ...(ctx.brief_id ? { brief_id: ctx.brief_id } : providedBriefId ? { brief_id: providedBriefId as string } : {}),
    ...(metadata && typeof metadata === "object" ? { metadata: metadata as Record<string, unknown> } : {}),
  } as Parameters<typeof appendMemoryEntry>[2];
  const written = await appendMemoryEntry(slug, parsed.category, body);
  return {
    call_id: call.id,
    success: true,
    content: JSON.stringify({
      project: slug,
      category: parsed.category,
      written: written,
    }, null, 2),
    meta: { duration_ms: Date.now() - start, bytes: JSON.stringify(written).length },
  };
};
