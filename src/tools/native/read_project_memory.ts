// v0.6: read_project_memory native tool. filesystem_read; default-allowed.
//
// Returns matching entries from the named per-project memory category. The
// brief's `project` field scopes the lookup. Reads tolerate corrupted JSONL
// rows: bad lines are skipped and reported alongside the valid entries.

import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from "../types.js";
import { readMemory, MEMORY_CATEGORIES, type MemoryCategory } from "../../state/memory.js";

export const READ_PROJECT_MEMORY_DEFINITION: ToolDefinition = {
  name: "read_project_memory",
  description:
    "Read entries from the project's memory store. The brief's `project` field scopes the lookup. " +
    "Categories: decisions (why-we-chose-X records), knowledge (longer-form notes), " +
    "constraints (persistent rules). Returns up to `limit` entries in reverse-chronological order. " +
    "Optional `query` is a case-insensitive substring filter against the entry's primary text.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: [...MEMORY_CATEGORIES] },
      query: { type: "string", description: "Optional case-insensitive substring filter." },
      limit: {
        type: "number",
        description: "Max entries returned. Default 20. Pass 0 for unlimited.",
      },
    },
    required: ["category"],
  },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

interface ReadArgs {
  category: MemoryCategory;
  query?: string;
  limit?: number;
}

function parseArgs(call: ToolCall): ReadArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.category !== "string" || !MEMORY_CATEGORIES.includes(a.category as MemoryCategory)) {
    return { error: `category must be one of: ${MEMORY_CATEGORIES.join(", ")}` };
  }
  if (a.query !== undefined && typeof a.query !== "string") {
    return { error: "query must be a string if provided" };
  }
  if (a.limit !== undefined && (typeof a.limit !== "number" || a.limit < 0)) {
    return { error: "limit must be a non-negative number if provided" };
  }
  return {
    category: a.category as MemoryCategory,
    query: a.query as string | undefined,
    limit: a.limit as number | undefined,
  };
}

export const readProjectMemoryExecutor: ToolExecutor = async (
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
  // ctx.project_slug is populated by the runner from brief.frontmatter.project
  // at session start. Memory is scoped per project; reads outside a project
  // context are an operator-side concern (see `openwar memory`).
  const slug = ctx.project_slug;
  if (!slug) {
    return {
      call_id: call.id,
      success: false,
      content: "no project slug in session context; memory tools require a brief with `project:` set",
      error: { code: "NO_PROJECT", message: "no project slug in session context" },
    };
  }
  const start = Date.now();
  const result = await readMemory(slug, parsed);
  return {
    call_id: call.id,
    success: true,
    content: JSON.stringify({
      project: slug,
      category: parsed.category,
      ...(parsed.query !== undefined && { query: parsed.query }),
      count: result.entries.length,
      entries: result.entries,
      ...(result.corrupted_lines.length > 0 && { corrupted_lines: result.corrupted_lines }),
    }, null, 2),
    meta: {
      duration_ms: Date.now() - start,
      bytes: 0,
    },
  };
};
