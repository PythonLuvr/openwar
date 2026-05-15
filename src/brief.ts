import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Brief,
  BriefFrontmatter,
  BriefSections,
  ValidationResult,
  ValidationIssue,
  ExecutionMode,
} from "./types.js";

// ---------- Public API ----------

export function parseBrief(input: string): Brief {
  const isPath = looksLikePath(input);
  let raw: string;
  let source_path: string | undefined;

  if (isPath) {
    source_path = resolve(input);
    raw = readFileSync(source_path, "utf8");
  } else {
    raw = input;
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(frontmatter);
  const sections = parseSections(body);

  return {
    frontmatter: fm,
    sections,
    raw,
    ...(source_path ? { source_path } : {}),
  };
}

export function validateBrief(brief: Brief): ValidationResult {
  const issues: ValidationIssue[] = [];
  const fm = brief.frontmatter;

  if (!fm.project) {
    issues.push({
      field: "project",
      message: "required",
      severity: "error",
    });
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(fm.project)) {
    issues.push({
      field: "project",
      message: "must be kebab-case (lowercase, digits, hyphens)",
      severity: "error",
    });
  }

  if (fm.brief_id && !/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9]+$/.test(fm.brief_id)) {
    issues.push({
      field: "brief_id",
      message: "must match YYYY-MM-DD-<id> (operator-assigned id may be alphanumeric)",
      severity: "error",
    });
  }

  if (fm.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(fm.deadline)) {
    issues.push({
      field: "deadline",
      message: "must match YYYY-MM-DD",
      severity: "error",
    });
  }

  if (fm.mode && fm.mode !== "gated" && fm.mode !== "auto") {
    issues.push({
      field: "mode",
      message: 'must be "gated" or "auto"',
      severity: "error",
    });
  }

  if (!brief.sections.objective.trim()) {
    issues.push({
      field: "Objective",
      message: "section is required",
      severity: "error",
    });
  }

  if (!brief.sections.deliverables.trim()) {
    issues.push({
      field: "Deliverables",
      message: "section is required",
      severity: "error",
    });
  }

  if (!brief.sections.constraints.trim()) {
    issues.push({
      field: "Constraints",
      message: "section is empty; consider adding scope guardrails",
      severity: "warning",
    });
  }

  return {
    valid: issues.every((i) => i.severity !== "error"),
    issues,
  };
}

// Render the brief's body sections back to markdown. Used to compose the
// agent's first user message.
export function renderBriefForAgent(brief: Brief): string {
  const fm = brief.frontmatter;
  const lines: string[] = [];
  lines.push(`# Brief: ${fm.project}`);
  if (fm.brief_id) lines.push(`brief_id: ${fm.brief_id}`);
  if (fm.deadline) lines.push(`deadline: ${fm.deadline}`);
  lines.push(`scope_locked: ${fm.scope_locked}`);
  if (fm.mode) lines.push(`mode: ${fm.mode}`);
  if (fm.authorized_costs.length) {
    lines.push(`authorized_costs: ${fm.authorized_costs.join(", ")}`);
  }
  lines.push("");

  const s = brief.sections;
  if (s.objective.trim()) lines.push("## Objective", s.objective.trim(), "");
  if (s.deliverables.trim()) lines.push("## Deliverables", s.deliverables.trim(), "");
  if (s.constraints.trim()) lines.push("## Constraints", s.constraints.trim(), "");
  if (s.tools_required.trim()) lines.push("## Tools required", s.tools_required.trim(), "");
  if (s.notes.trim()) lines.push("## Notes / unknowns", s.notes.trim(), "");

  for (const [heading, content] of Object.entries(s.extra)) {
    if (content.trim()) lines.push(`## ${heading}`, content.trim(), "");
  }

  return lines.join("\n").trim() + "\n";
}

// ---------- Internals ----------

function looksLikePath(input: string): boolean {
  // Heuristic: if it has no newline, ends in .md, and exists on disk, treat as path.
  if (input.includes("\n")) return false;
  if (input.length > 1024) return false;
  if (!/\.(md|markdown|txt)$/i.test(input)) return false;
  try {
    if (!existsSync(input)) return false;
    return statSync(input).isFile();
  } catch {
    return false;
  }
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  // Tolerate BOM and leading whitespace.
  const text = raw.replace(/^﻿/, "");
  // Frontmatter must start at column 0 with --- and end at a line of ---.
  if (!text.startsWith("---")) {
    return { frontmatter: "", body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    throw new Error("Brief frontmatter started with --- but never closed (expected matching ---).");
  }
  const frontmatter = text.slice(3, end).replace(/^\r?\n/, "");
  // Move past closing --- and its newline.
  const rest = text.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter, body: rest };
}

// Tight YAML subset. Supports:
//   key: value            (scalar string, bool, or date)
//   key:                  (followed by indented list)
//     - item
//     - item
// No nested maps, no quoted multilines, no anchors. Comments after # ok.
function parseFrontmatter(text: string): BriefFrontmatter {
  const out: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      throw new Error(`Bad frontmatter line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const key = m[1]!;
    const rawValue = stripComment(m[2] ?? "").trim();

    if (rawValue === "") {
      // Maybe a list follows on subsequent indented lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const ln = lines[j] ?? "";
        if (!ln.trim()) {
          j++;
          continue;
        }
        const lm = /^(\s+)-\s+(.+)$/.exec(ln);
        if (!lm) break;
        items.push(stripComment(lm[2]!).trim());
        j++;
      }
      if (items.length > 0) {
        out[key] = items;
        i = j;
        continue;
      }
      out[key] = "";
      i++;
      continue;
    }

    out[key] = coerceScalar(rawValue);
    i++;
  }

  return finalizeFrontmatter(out);
}

function stripComment(s: string): string {
  // Drop trailing # comment unless inside quotes. We don't support quoted strings.
  const hash = s.indexOf("#");
  if (hash === -1) return s;
  // Allow # inside a token if it's preceded by a non-space (e.g. URL fragments
  // would not appear in OpenWar frontmatter, but be lenient).
  if (hash > 0 && /\S/.test(s[hash - 1] ?? "")) return s;
  return s.slice(0, hash);
}

function coerceScalar(s: string): string | boolean | number {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  // Strip surrounding quotes if present.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function finalizeFrontmatter(raw: Record<string, unknown>): BriefFrontmatter {
  const project = typeof raw.project === "string" ? raw.project.trim() : "";

  let brief_id: string | undefined;
  if (typeof raw.brief_id === "string" && raw.brief_id.trim()) {
    brief_id = raw.brief_id.trim();
  }

  let deadline: string | undefined;
  if (typeof raw.deadline === "string" && raw.deadline.trim()) {
    deadline = raw.deadline.trim();
  }

  const scope_locked = raw.scope_locked === true;

  let mode: ExecutionMode | undefined;
  if (raw.mode === "gated" || raw.mode === "auto") mode = raw.mode;

  let authorized_costs: string[] = [];
  if (Array.isArray(raw.authorized_costs)) {
    authorized_costs = raw.authorized_costs
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
  }

  return {
    project,
    ...(brief_id ? { brief_id } : {}),
    ...(deadline ? { deadline } : {}),
    scope_locked,
    ...(mode ? { mode } : {}),
    authorized_costs,
  };
}

const HEADING_ALIASES: Record<string, keyof Omit<BriefSections, "extra">> = {
  objective: "objective",
  objectives: "objective",
  goal: "objective",
  goals: "objective",
  deliverables: "deliverables",
  deliverable: "deliverables",
  constraints: "constraints",
  constraint: "constraints",
  "tools required": "tools_required",
  tools: "tools_required",
  "tools needed": "tools_required",
  "notes / unknowns": "notes",
  "notes/unknowns": "notes",
  notes: "notes",
  unknowns: "notes",
};

function parseSections(body: string): BriefSections {
  const sections: BriefSections = {
    objective: "",
    deliverables: "",
    constraints: "",
    tools_required: "",
    notes: "",
    extra: {},
  };

  const lines = body.split(/\r?\n/);
  let current: { heading: string; key?: keyof Omit<BriefSections, "extra">; buf: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.buf.join("\n").replace(/\s+$/g, "");
    if (current.key) {
      sections[current.key] = text;
    } else {
      sections.extra[current.heading] = text;
    }
  };

  for (const line of lines) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      const heading = h[1]!.trim();
      const key = HEADING_ALIASES[heading.toLowerCase()];
      current = key ? { heading, key, buf: [] } : { heading, buf: [] };
      continue;
    }
    if (current) {
      current.buf.push(line);
    }
  }
  flush();

  return sections;
}

// Utility: generate a brief_id when frontmatter doesn't have one.
export function generateBriefId(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const rand = randomToken(6);
  return `${y}-${m}-${d}-${rand}`;
}

function randomToken(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
