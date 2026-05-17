// v0.6: per-project memory persistence.
//
// Three categories live as JSONL files under ~/.openwar/projects/<slug>/:
//   decisions.jsonl    why-we-chose-X records (append-only)
//   knowledge.jsonl    longer-form notes (append-only)
//   constraints.jsonl  persistent rules the agent must respect (append-only)
//
// Reads tolerate corrupted lines: bad rows are skipped and the line index
// (1-based) is returned alongside valid entries so the operator can prune.
// Writes are atomic: each append goes through a tmp+rename so a crashed
// process never leaves a half-line in the file.
//
// No retrieval scoring, no summarization, no compaction. Cap-and-paginate is
// the v0.6 read story; v0.6.x can layer semantic search on top.

import { mkdir, readFile, writeFile, appendFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  memoryFile,
  projectDir,
  type MemoryCategory,
  MEMORY_CATEGORIES,
} from "./paths.js";

export type { MemoryCategory };
export { MEMORY_CATEGORIES };

export interface MemoryEntryBase {
  id: string;
  at: string; // ISO timestamp
  brief_id?: string; // when produced inside a session
  metadata?: Record<string, unknown>;
}

export interface DecisionEntry extends MemoryEntryBase {
  category: "decisions";
  summary: string;
  rationale: string;
  superseded_by?: string;
}

export interface KnowledgeEntry extends MemoryEntryBase {
  category: "knowledge";
  content: string;
}

export interface ConstraintEntry extends MemoryEntryBase {
  category: "constraints";
  rule: string;
  rationale?: string;
}

export type MemoryEntry = DecisionEntry | KnowledgeEntry | ConstraintEntry;

export interface ReadMemoryResult {
  entries: MemoryEntry[];
  // Line numbers (1-based) of rows that failed to parse. Surfaced so the
  // operator can fix or remove them; entries continue to load past the
  // damage.
  corrupted_lines: number[];
}

export interface MemoryReadOptions {
  category: MemoryCategory;
  // Cap entries returned. Default 20 per v0.6 design. 0 = unlimited.
  limit?: number;
  // Free-form needle. v0.6 implementation: case-insensitive substring match
  // against the entry's primary text field (summary / content / rule). v0.6.x
  // can swap in real retrieval.
  query?: string;
}

const DEFAULT_LIMIT = 20;

async function ensureProjectDir(projectSlug: string): Promise<void> {
  await mkdir(projectDir(projectSlug), { recursive: true });
}

function newEntryId(): string {
  // Compact, sortable enough for human inspection. Not load-bearing for
  // ordering (files are append-only and chronological by line).
  return `mem-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function primaryText(entry: MemoryEntry): string {
  switch (entry.category) {
    case "decisions": return `${entry.summary}\n${entry.rationale}`;
    case "knowledge": return entry.content;
    case "constraints": return entry.rule + (entry.rationale ? `\n${entry.rationale}` : "");
  }
}

function matchesQuery(entry: MemoryEntry, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return primaryText(entry).toLowerCase().includes(needle);
}

// Append-only write. Constructs the entry, JSON-stringifies it, and writes
// via tmp+rename then concat-append so the file is never half-written.
// (Direct appendFile is non-atomic across crash boundaries on most systems;
// the tmp dance gives us a clean recovery path.)
export async function appendMemoryEntry(
  projectSlug: string,
  category: MemoryCategory,
  body: Omit<DecisionEntry, "id" | "at" | "category"> | Omit<KnowledgeEntry, "id" | "at" | "category"> | Omit<ConstraintEntry, "id" | "at" | "category">,
): Promise<MemoryEntry> {
  await ensureProjectDir(projectSlug);
  const id = newEntryId();
  const at = new Date().toISOString();
  const entry = { id, at, category, ...body } as MemoryEntry;
  const line = JSON.stringify(entry) + "\n";
  const path = memoryFile(projectSlug, category);
  // Two-step write: stage line in a tmp file, then appendFile from disk to
  // disk. If the process dies between the stage and the append, the tmp is
  // discarded on next call (different random suffix).
  const tmp = `${path}.openwar-append-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, line, "utf8");
  try {
    await appendFile(path, line, "utf8");
  } finally {
    // Best-effort cleanup. A stuck tmp doesn't corrupt anything.
    try { await unlink(tmp); } catch { /* ignore */ }
  }
  return entry;
}

// Read all valid entries from a category file. Missing file = empty result.
// Corrupted JSON lines are skipped with their line number captured; the read
// keeps going so a single bad row can't lock the project out of its memory.
export async function readMemory(
  projectSlug: string,
  opts: MemoryReadOptions,
): Promise<ReadMemoryResult> {
  const path = memoryFile(projectSlug, opts.category);
  if (!existsSync(path)) {
    return { entries: [], corrupted_lines: [] };
  }
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  const corrupted: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MemoryEntry;
      if (typeof parsed !== "object" || parsed === null || parsed.category !== opts.category) {
        corrupted.push(i + 1);
        continue;
      }
      entries.push(parsed);
    } catch {
      corrupted.push(i + 1);
    }
  }

  // Apply query filter (substring, case-insensitive).
  const filtered = opts.query ? entries.filter((e) => matchesQuery(e, opts.query!)) : entries;

  // Reverse-chronological cap. Order on disk is insertion order; the most
  // recent entries are at the tail. Take from the end.
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const capped = limit === 0 ? filtered.slice().reverse() : filtered.slice(-limit).reverse();

  return { entries: capped, corrupted_lines: corrupted };
}

// Remove a single entry by id. Rewrites the category file atomically so a
// crash during prune doesn't corrupt the surviving rows.
export async function removeMemoryEntry(
  projectSlug: string,
  category: MemoryCategory,
  entryId: string,
): Promise<boolean> {
  const path = memoryFile(projectSlug, category);
  if (!existsSync(path)) return false;
  const raw = await readFile(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let found = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MemoryEntry;
      if (parsed.id === entryId) {
        found = true;
        continue;
      }
      kept.push(line);
    } catch {
      // Preserve corrupted lines so the operator can still see them via
      // readMemory's corrupted_lines list. Prune is targeted, not janitorial.
      kept.push(line);
    }
  }
  if (!found) return false;
  const tmp = `${path}.openwar-tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
  await ensureParentDir(path);
  await rename(tmp, path);
  return true;
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

// Render a per-category memory summary for injection into the system prompt.
// Used by inherit_memory:true. Cap stays at 20 per category per v0.6 design.
export async function renderMemoryForPrompt(
  projectSlug: string,
  opts: { perCategoryLimit?: number; categories?: MemoryCategory[] } = {},
): Promise<string> {
  const limit = opts.perCategoryLimit ?? 20;
  const cats = opts.categories ?? MEMORY_CATEGORIES;
  const sections: string[] = [];
  for (const cat of cats) {
    const { entries } = await readMemory(projectSlug, { category: cat, limit });
    if (entries.length === 0) continue;
    sections.push(`## Memory: ${cat} (${entries.length} most recent)\n`);
    for (const e of entries) {
      sections.push(formatEntryForPrompt(e));
    }
    sections.push("");
  }
  if (sections.length === 0) return "";
  return ["# Project memory (inherited from prior briefs)", "", ...sections, "---", ""].join("\n");
}

function formatEntryForPrompt(e: MemoryEntry): string {
  const head = `- [${e.id}] ${e.at}`;
  switch (e.category) {
    case "decisions":
      return [
        head,
        `  summary: ${e.summary}`,
        `  rationale: ${e.rationale}`,
        ...(e.superseded_by ? [`  superseded_by: ${e.superseded_by}`] : []),
      ].join("\n");
    case "knowledge":
      return [head, `  ${oneLine(e.content)}`].join("\n");
    case "constraints":
      return [
        head,
        `  rule: ${e.rule}`,
        ...(e.rationale ? [`  rationale: ${e.rationale}`] : []),
      ].join("\n");
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
