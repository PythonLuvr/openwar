// v0.6 / v0.7.3: read_project_memory native tool. filesystem_read; default-allowed.
//
// Returns matching entries from the named per-project memory category. The
// memory store lives at ~/.openwar/projects/<slug>/<category>.jsonl, sibling
// to any brief's workdir. This tool reaches it directly via project slug,
// bypassing the workdir sandbox by design (same scoping write_project_memory
// has had since v0.6).
//
// v0.7.3 additions on top of v0.6's signature:
//   - `project` argument (optional; falls back to ctx.project_slug). Bridged
//     agents in MCP-server-mode may not have ctx.project_slug populated from
//     the parent runtime, so explicit-arg works there too.
//   - `id` argument (optional; fetches one specific entry by id).
//   - Default `limit` bumped from 20 to 50.
//
// Back-compat: v0.6 callers using `category` + optional `query` + `limit`
// behave identically (except for the larger default cap).

import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from "../types.js";
import { readMemory, MEMORY_CATEGORIES, type MemoryCategory } from "../../state/memory.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const READ_PROJECT_MEMORY_DEFINITION: ToolDefinition = {
  name: "read_project_memory",
  description:
    "Read entries from the project's memory store. Reaches ~/.openwar/projects/<project>/<category>.jsonl " +
    "directly; not subject to the run's workdir sandbox. Pass `project` explicitly (recommended) or rely on " +
    "the session's project slug. Pass `id` to fetch one specific entry, or omit to receive the most recent " +
    "`limit` entries in reverse-chronological order. Optional `query` is a case-insensitive substring filter " +
    "against the entry's primary text (decisions.summary, knowledge.content, constraints.rule).",
  input_schema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug (kebab-case). Defaults to the session's project." },
      category: { type: "string", enum: [...MEMORY_CATEGORIES] },
      id: { type: "string", description: "Optional entry id. When set, returns only that entry." },
      query: { type: "string", description: "Optional case-insensitive substring filter." },
      limit: {
        type: "number",
        description: `Max entries returned. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}. Pass 0 for unlimited.`,
      },
    },
    required: ["category"],
  },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

interface ReadArgs {
  project?: string;
  category: MemoryCategory;
  id?: string;
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
  if (a.project !== undefined && typeof a.project !== "string") {
    return { error: "project must be a string if provided" };
  }
  if (a.id !== undefined && typeof a.id !== "string") {
    return { error: "id must be a string if provided" };
  }
  if (a.query !== undefined && typeof a.query !== "string") {
    return { error: "query must be a string if provided" };
  }
  if (a.limit !== undefined && (typeof a.limit !== "number" || a.limit < 0)) {
    return { error: "limit must be a non-negative number if provided" };
  }
  return {
    ...(typeof a.project === "string" && { project: a.project }),
    category: a.category as MemoryCategory,
    ...(typeof a.id === "string" && { id: a.id }),
    ...(typeof a.query === "string" && { query: a.query }),
    ...(typeof a.limit === "number" && { limit: a.limit }),
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
  // Project resolution: explicit arg wins, ctx.project_slug is fallback.
  const slug = parsed.project ?? ctx.project_slug;
  if (!slug) {
    return {
      call_id: call.id,
      success: false,
      content:
        "no project slug: pass `project` explicitly or run inside a session whose brief has `project:` set",
      error: { code: "NO_PROJECT", message: "no project slug" },
    };
  }
  const start = Date.now();
  // Cap the limit at MAX_LIMIT regardless of caller intent; unbounded reads
  // would blow up token cost on a large memory store.
  const requestedLimit = parsed.limit ?? DEFAULT_LIMIT;
  const cappedLimit = requestedLimit === 0
    ? MAX_LIMIT
    : Math.min(requestedLimit, MAX_LIMIT);

  // v0.7.3: id lookup. readMemory doesn't have an id filter natively; fetch
  // up to the cap and filter in-process. JSONL is read-once, the filter is
  // cheap, and id collisions are impossible (UUIDs).
  const memoryResult = await readMemory(slug, {
    category: parsed.category,
    ...(parsed.query !== undefined && { query: parsed.query }),
    limit: parsed.id ? MAX_LIMIT : cappedLimit,
  });

  let entries = memoryResult.entries;
  if (parsed.id) {
    entries = entries.filter((e) => e.id === parsed.id);
  }

  return {
    call_id: call.id,
    success: true,
    content: JSON.stringify({
      project: slug,
      category: parsed.category,
      ...(parsed.id !== undefined && { id: parsed.id }),
      ...(parsed.query !== undefined && { query: parsed.query }),
      count: entries.length,
      entries,
      ...(memoryResult.corrupted_lines.length > 0 && { corrupted_lines: memoryResult.corrupted_lines }),
    }, null, 2),
    meta: {
      duration_ms: Date.now() - start,
      bytes: 0,
    },
  };
};
