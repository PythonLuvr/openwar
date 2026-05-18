// v0.7.3: list_project_memory native tool. filesystem_read.
//
// Returns a summary view of the project's memory store, scoped per-project
// like write_project_memory + read_project_memory. Two modes:
//
//   - Single category: returns the most recent N entries with truncated
//     summaries (200 chars).
//   - All categories (when category is omitted): returns per-category counts
//     plus the last few summaries from each. Empty categories are included
//     so the agent can see "this project has 5 decisions and 0 constraints"
//     at a glance.
//
// Summaries DO NOT include the full entry body. The agent uses them to find
// what it wants, then calls read_project_memory with the id for full content.
//
// Cross-project listing is out of scope; each call is scoped to one project.

import type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  ToolExecutor,
} from "../types.js";
import { readMemory, MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry } from "../../state/memory.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const SUMMARY_TRUNCATE = 200;

export const LIST_PROJECT_MEMORY_DEFINITION: ToolDefinition = {
  name: "list_project_memory",
  description:
    "Summarize a project's memory store. Pass `project` (required) and optionally `category` to limit to one. " +
    "Without `category`, returns per-category counts plus recent summaries across all three categories. " +
    "Each entry includes id, at, category, summary_or_excerpt (200 chars), and brief_id when set. " +
    "Reaches the memory store directly (not workdir-sandboxed). Use read_project_memory with an entry id " +
    "to fetch the full body.",
  input_schema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug (kebab-case)." },
      category: { type: "string", enum: [...MEMORY_CATEGORIES], description: "Optional; default: all three." },
      since: { type: "string", description: "Optional ISO timestamp filter. Entries with `at` before this are excluded." },
      limit: {
        type: "number",
        description: `Max entries per category. Default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
      },
    },
    required: ["project"],
  },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

interface ListArgs {
  project: string;
  category?: MemoryCategory;
  since?: string;
  limit?: number;
}

function parseArgs(call: ToolCall): ListArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.project !== "string" || a.project.length === 0) {
    return { error: "project must be a non-empty string" };
  }
  if (a.category !== undefined && (typeof a.category !== "string" || !MEMORY_CATEGORIES.includes(a.category as MemoryCategory))) {
    return { error: `category must be one of: ${MEMORY_CATEGORIES.join(", ")}` };
  }
  if (a.since !== undefined && typeof a.since !== "string") {
    return { error: "since must be an ISO timestamp string if provided" };
  }
  if (a.limit !== undefined && (typeof a.limit !== "number" || a.limit < 0)) {
    return { error: "limit must be a non-negative number if provided" };
  }
  return {
    project: a.project,
    ...(typeof a.category === "string" && { category: a.category as MemoryCategory }),
    ...(typeof a.since === "string" && { since: a.since }),
    ...(typeof a.limit === "number" && { limit: a.limit }),
  };
}

// Per the brief's Phase 0 Q3: category-specific accessors for the
// summary_or_excerpt field. No schema unification across categories.
function summaryOf(entry: MemoryEntry): string {
  let raw: string;
  switch (entry.category) {
    case "decisions":   raw = entry.summary; break;
    case "knowledge":   raw = entry.content; break;
    case "constraints": raw = entry.rule; break;
  }
  if (raw.length <= SUMMARY_TRUNCATE) return raw;
  return raw.slice(0, SUMMARY_TRUNCATE - 3) + "...";
}

interface SummaryEntry {
  id: string;
  at: string;
  category: MemoryCategory;
  summary_or_excerpt: string;
  brief_id?: string;
}

interface CategorySummary {
  category: MemoryCategory;
  count: number;
  entries: SummaryEntry[];
  corrupted_lines?: number[];
}

function applySinceFilter(entries: MemoryEntry[], since: string | undefined): MemoryEntry[] {
  if (!since) return entries;
  return entries.filter((e) => e.at >= since);
}

function toSummary(entry: MemoryEntry): SummaryEntry {
  return {
    id: entry.id,
    at: entry.at,
    category: entry.category,
    summary_or_excerpt: summaryOf(entry),
    ...(entry.brief_id && { brief_id: entry.brief_id }),
  };
}

async function summarizeCategory(
  project: string,
  category: MemoryCategory,
  since: string | undefined,
  limit: number,
): Promise<CategorySummary> {
  const result = await readMemory(project, { category, limit });
  const filtered = applySinceFilter(result.entries, since);
  return {
    category,
    count: filtered.length,
    entries: filtered.map(toSummary),
    ...(result.corrupted_lines.length > 0 && { corrupted_lines: result.corrupted_lines }),
  };
}

export const listProjectMemoryExecutor: ToolExecutor = async (
  call: ToolCall,
  _ctx: ToolExecutionContext,
): Promise<ToolResult> => {
  void _ctx;
  const parsed = parseArgs(call);
  if ("error" in parsed) {
    return {
      call_id: call.id,
      success: false,
      content: parsed.error,
      error: { code: "INVALID_ARGS", message: parsed.error },
    };
  }
  const start = Date.now();
  const requestedLimit = parsed.limit ?? DEFAULT_LIMIT;
  const cappedLimit = requestedLimit === 0
    ? MAX_LIMIT
    : Math.min(requestedLimit, MAX_LIMIT);

  const categories: MemoryCategory[] = parsed.category
    ? [parsed.category]
    : [...MEMORY_CATEGORIES];

  const summaries: CategorySummary[] = [];
  for (const cat of categories) {
    summaries.push(await summarizeCategory(parsed.project, cat, parsed.since, cappedLimit));
  }

  return {
    call_id: call.id,
    success: true,
    content: JSON.stringify({
      project: parsed.project,
      ...(parsed.since !== undefined && { since: parsed.since }),
      ...(parsed.category !== undefined && { category: parsed.category }),
      categories: summaries,
    }, null, 2),
    meta: {
      duration_ms: Date.now() - start,
      bytes: 0,
    },
  };
};
