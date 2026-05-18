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
import { listRoleIds } from "./roles/registry.js";

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

export interface ValidateBriefOptions {
  // Known role ids the brief may reference. When omitted, validation falls
  // back to the role registry's current contents (built-ins plus any
  // `registerRole()` additions). Callers that want to validate against a
  // closed set (tests, CLI dry-runs) pass an explicit list.
  knownRoles?: readonly string[];
}

const BUILT_IN_ROLE_IDS = ["planner", "executor", "reviewer", "critic"] as const;

function resolveKnownRoles(options: ValidateBriefOptions): Set<string> {
  if (options.knownRoles) return new Set(options.knownRoles);
  const ids = listRoleIds();
  return ids.length > 0 ? new Set(ids) : new Set(BUILT_IN_ROLE_IDS);
}

export function validateBrief(brief: Brief, options: ValidateBriefOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  const fm = brief.frontmatter;
  const knownRoles = resolveKnownRoles(options);

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

  // v0.4: roles validation. Unknown ids are errors; empty list means
  // explicit single-agent mode (valid).
  if (fm.roles) {
    for (const r of fm.roles) {
      if (!knownRoles.has(r)) {
        issues.push({
          field: "roles",
          message: `unknown role "${r}". Registered: ${[...knownRoles].join(", ")}`,
          severity: "error",
        });
      }
    }
    // Planner is the only role allowed to plan; if multi-agent mode is
    // requested at all, planner must be present.
    if (fm.roles.length > 0 && !fm.roles.includes("planner")) {
      issues.push({
        field: "roles",
        message: 'multi-agent mode requires "planner" in the roles list',
        severity: "error",
      });
    }
    // Executor is required for any concrete work; reviewer is the quality gate.
    if (fm.roles.length > 0 && !fm.roles.includes("executor")) {
      issues.push({
        field: "roles",
        message: 'multi-agent mode requires "executor" in the roles list',
        severity: "error",
      });
    }
  }

  // v0.6.2: surface the cli-bridge / bridged-CLI permission interaction as a
  // brief-lint warning. When any role is pinned to cli-bridge AND the brief
  // authorizes non-trivial side effects, the bridged CLI's own permission
  // system (Claude Code's permissions, etc) sits on top of OpenWar's gates.
  // The two layers don't talk; an operator who pre-approved filesystem_write
  // in the brief may still see the bridged agent declare Phase 2 because the
  // CLI rejected the write under its own rules. Warning, not an error.
  const sideEffectCategories = new Set([
    "filesystem_write",
    "filesystem_delete",
    "shell_exec",
    "http_fetch",
    "git_write",
    "git_push",
    "deploy",
    "external_message",
    "paid_api_call",
  ]);
  const briefUsesCliBridge =
    !!fm.role_adapters &&
    Object.values(fm.role_adapters).some((cfg) => cfg.adapter === "cli-bridge");
  const briefAuthorsSideEffects = fm.authorized_costs.some(
    (c) => sideEffectCategories.has(c) || c === "*",
  );
  if (briefUsesCliBridge && briefAuthorsSideEffects) {
    issues.push({
      field: "role_adapters",
      message:
        "cli-bridge is in play and the brief authorizes side-effecting categories. " +
        "OpenWar's authorized_costs apply to OpenWar tool calls, but the bridged CLI runs " +
        "as its own subprocess with its own permission system. v0.7.2+ auto-authorizes the " +
        "openwar MCP tools in Claude Code's settings before spawn. Other permission categories " +
        "(filesystem paths the bridged CLI's own tools touch, shell commands it runs internally) " +
        "remain the operator's responsibility; set cli.skip_permission_setup: true to opt out of " +
        "auto-authorization.",
      severity: "warning",
    });
  }

  // v0.5.1: role_adapters validation. Every key must reference a role in
  // `roles`, every adapter id must be in the known set, and any role pinned to
  // cli-bridge requires `shell_exec` in the brief's authorized_costs.
  if (fm.role_adapters) {
    const knownAdapterIds = new Set([
      "anthropic",
      "openai",
      "gemini",
      "grok",
      "openai-compat",
      "cli-bridge",
      "mock",
    ]);
    const roleSet = new Set(fm.roles ?? []);
    const hasShellExec =
      fm.authorized_costs.includes("shell_exec") ||
      fm.authorized_costs.includes("*");
    for (const [roleId, cfg] of Object.entries(fm.role_adapters)) {
      if (!roleSet.has(roleId)) {
        issues.push({
          field: `role_adapters.${roleId}`,
          message: `references role "${roleId}" not declared in roles`,
          severity: "error",
        });
      }
      if (!cfg.adapter) {
        issues.push({
          field: `role_adapters.${roleId}.adapter`,
          message: "required (e.g. anthropic, cli-bridge, openai-compat)",
          severity: "error",
        });
      } else if (!knownAdapterIds.has(cfg.adapter)) {
        issues.push({
          field: `role_adapters.${roleId}.adapter`,
          message: `unknown adapter "${cfg.adapter}". Known: ${[...knownAdapterIds].join(", ")}`,
          severity: "error",
        });
      } else if (cfg.adapter === "cli-bridge" && !hasShellExec) {
        issues.push({
          field: `role_adapters.${roleId}.adapter`,
          message:
            'role uses cli-bridge but the brief is missing "shell_exec" in authorized_costs',
          severity: "error",
        });
      }
    }
  }

  // v0.4: budgets validation. Non-positive values are errors.
  if (fm.budgets) {
    for (const [k, v] of Object.entries(fm.budgets)) {
      if (typeof v !== "number" || v <= 0 || !Number.isFinite(v)) {
        issues.push({
          field: `budgets.${k}`,
          message: "must be a positive number",
          severity: "error",
        });
      }
    }
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
  if (fm.roles && fm.roles.length > 0) {
    lines.push(`roles: ${fm.roles.join(", ")}`);
    if (fm.role_adapters) {
      for (const [roleId, cfg] of Object.entries(fm.role_adapters)) {
        const extras: string[] = [`adapter=${cfg.adapter || "(default)"}`];
        if (cfg.model) extras.push(`model=${cfg.model}`);
        for (const [k, v] of Object.entries(cfg)) {
          if (k === "adapter" || k === "model") continue;
          extras.push(`${k}=${String(v)}`);
        }
        lines.push(`  ${roleId}: ${extras.join(", ")}`);
      }
    }
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
//   key:                  (followed by an indented nested map of scalars)
//     subkey: value
//     subkey: value
// No deep nesting, no quoted multilines, no anchors. Comments after # ok.
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
      // Lookahead: list, nested map, or empty.
      // 1) List: next non-blank indented line starts with "-".
      // 2) Nested map: next non-blank indented line has `subkey: scalar`.
      let j = i + 1;
      // Skip blanks/comments to peek.
      while (j < lines.length) {
        const ln = lines[j] ?? "";
        if (!ln.trim() || ln.trim().startsWith("#")) {
          j++;
          continue;
        }
        break;
      }
      const peek = lines[j] ?? "";
      const listLead = /^(\s+)-\s+(.+)$/.exec(peek);
      // v0.5.1: accept maps whose first child has an empty inline value
      // (which means a nested-nested map follows). The (.*)$ rather than
      // (.+)$ is the only change vs the v0.4 parser.
      const mapLead = /^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(peek);

      if (listLead) {
        const items: unknown[] = [];
        while (j < lines.length) {
          const ln = lines[j] ?? "";
          if (!ln.trim()) { j++; continue; }
          if (ln.trim().startsWith("#")) { j++; continue; }
          const lm = /^(\s+)-\s+(.+)$/.exec(ln);
          if (!lm) break;
          // List items run through the same scalar coercion as plain keys so
          // quote-wrapped tokens (e.g. "*") arrive without their quotes.
          items.push(coerceScalar(stripComment(lm[2]!).trim()));
          j++;
        }
        out[key] = items;
        i = j;
        continue;
      }

      if (mapLead) {
        const nested: Record<string, unknown> = {};
        const leadIndent = mapLead[1]!.length;
        while (j < lines.length) {
          const ln = lines[j] ?? "";
          if (!ln.trim()) { j++; continue; }
          if (ln.trim().startsWith("#")) { j++; continue; }
          const sub = /^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(ln);
          if (!sub) break;
          if (sub[1]!.length < leadIndent) break;
          const subkey = sub[2]!;
          const subval = stripComment(sub[3] ?? "").trim();
          if (subval === "") {
            // v0.5.1: nested-nested map. The subkey has no inline value and
            // the following lines are indented further than the parent. Treat
            // them as a child map of scalars. Used by `role_adapters:` and the
            // object form of `roles:`. Still only two levels deep; lists and
            // triple-nested maps are out of scope for this parser.
            let k = j + 1;
            while (k < lines.length) {
              const peekLn = lines[k] ?? "";
              if (!peekLn.trim() || peekLn.trim().startsWith("#")) { k++; continue; }
              break;
            }
            const childPeek = lines[k] ?? "";
            const childMatch = /^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(childPeek);
            if (!childMatch || childMatch[1]!.length <= sub[1]!.length) {
              // No child content (or not deeper). Record as empty object so the
              // caller can detect "key declared but no children".
              nested[subkey] = {};
              j = k;
              continue;
            }
            const childIndent = childMatch[1]!.length;
            const childMap: Record<string, unknown> = {};
            while (k < lines.length) {
              const ln2 = lines[k] ?? "";
              if (!ln2.trim()) { k++; continue; }
              if (ln2.trim().startsWith("#")) { k++; continue; }
              const cm = /^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(ln2);
              if (!cm) break;
              if (cm[1]!.length < childIndent) break;
              const ckey = cm[2]!;
              const cval = stripComment(cm[3] ?? "").trim();
              if (cval === "") break; // triple-nesting not supported
              childMap[ckey] = coerceScalar(cval);
              k++;
            }
            nested[subkey] = childMap;
            j = k;
            continue;
          }
          nested[subkey] = coerceScalar(subval);
          j++;
        }
        out[key] = nested;
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

  let workdir: string | undefined;
  if (typeof raw.workdir === "string" && raw.workdir.trim()) {
    workdir = raw.workdir.trim();
  }

  // mcp_servers: a list of strings in "name=command" form. The minimal YAML
  // parser does not support nested objects; this keeps frontmatter flat.
  let mcp_servers: { name: string; command: string }[] | undefined;
  if (Array.isArray(raw.mcp_servers)) {
    mcp_servers = [];
    for (const entry of raw.mcp_servers) {
      if (typeof entry !== "string") continue;
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      const name = entry.slice(0, eq).trim();
      const command = entry.slice(eq + 1).trim();
      if (name && command) mcp_servers.push({ name, command });
    }
    if (mcp_servers.length === 0) mcp_servers = undefined;
  }

  // v0.7: cli.mcp_forward boolean. Defaults true. Lives under a nested `cli`
  // key in frontmatter so future cli-bridge knobs can live alongside without
  // polluting the top level (cli.timeout_override etc).
  let cli: { mcp_forward?: boolean; skip_permission_setup?: boolean } | undefined;
  if (raw.cli && typeof raw.cli === "object" && !Array.isArray(raw.cli)) {
    const c = raw.cli as Record<string, unknown>;
    cli = {};
    if (typeof c.mcp_forward === "boolean") cli.mcp_forward = c.mcp_forward;
    if (typeof c.skip_permission_setup === "boolean") cli.skip_permission_setup = c.skip_permission_setup;
    if (Object.keys(cli).length === 0) cli = undefined;
  }

  // v0.6: inherit_memory boolean. Default false. When true, the runner reads
  // ~/.openwar/projects/<slug>/{decisions,knowledge,constraints}.jsonl and
  // injects a structured summary into the system prompt at session start.
  const inherit_memory = raw.inherit_memory === true;

  // v0.9.1: learned_profile string. When set, the runner loads
  // ~/.openwar/projects/<slug>/learned.json at session start and applies the
  // detector sensitivity overrides + phase budget recommendations recorded
  // there. Explicit-only: there is no auto-discovery from the project slug.
  const learned_profile = typeof raw.learned_profile === "string" && raw.learned_profile.trim().length > 0
    ? raw.learned_profile.trim()
    : undefined;

  // v0.4: roles list (string[]). Supports several spellings:
  //   roles:
  //     - planner
  //   roles: planner,executor,reviewer
  //   roles: []     # explicit single-agent mode
  //
  // v0.5.1: roles can also be a nested map for per-role adapter overrides:
  //   roles:
  //     planner:
  //       adapter: anthropic
  //     executor:
  //       adapter: cli-bridge
  //       binary: claude
  //       tier: free
  //     reviewer:
  //       adapter: anthropic
  // The map keys become the roles list (ordering preserved); the values are
  // surfaced through role_adapters for the runner to consume.
  let roles: string[] | undefined;
  let role_adapters: Record<string, Record<string, unknown>> | undefined;
  if (Array.isArray(raw.roles)) {
    roles = raw.roles
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
  } else if (raw.roles && typeof raw.roles === "object") {
    const obj = raw.roles as Record<string, unknown>;
    const ids: string[] = [];
    const map: Record<string, Record<string, unknown>> = {};
    for (const [id, val] of Object.entries(obj)) {
      ids.push(id);
      if (val && typeof val === "object" && !Array.isArray(val)) {
        map[id] = val as Record<string, unknown>;
      }
    }
    if (ids.length > 0) {
      roles = ids;
      if (Object.keys(map).length > 0) role_adapters = map;
    }
  } else if (typeof raw.roles === "string") {
    const trimmed = raw.roles.trim();
    if (trimmed === "[]") {
      roles = [];
    } else {
      const items = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0) roles = items;
    }
  }

  // v0.5.1: separate `role_adapters:` block also accepted. Merged with any
  // map-form `roles:` data; sibling field wins on overlap (explicit override).
  if (raw.role_adapters && typeof raw.role_adapters === "object" && !Array.isArray(raw.role_adapters)) {
    const sep = raw.role_adapters as Record<string, unknown>;
    for (const [id, val] of Object.entries(sep)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        if (!role_adapters) role_adapters = {};
        role_adapters[id] = val as Record<string, unknown>;
      }
    }
  }

  // v0.4: budgets nested map.
  let budgets: BriefFrontmatter["budgets"];
  if (raw.budgets && typeof raw.budgets === "object" && !Array.isArray(raw.budgets)) {
    const b = raw.budgets as Record<string, unknown>;
    budgets = {};
    const num = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) {
        const n = Number(v.trim());
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      }
      return undefined;
    };
    const mt = num(b.max_tokens);
    const mw = num(b.max_wall_clock_minutes);
    const mtc = num(b.max_tool_calls_per_subtask);
    const mr = num(b.max_retries_per_subtask);
    if (mt !== undefined) budgets.max_tokens = mt;
    if (mw !== undefined) budgets.max_wall_clock_minutes = mw;
    if (mtc !== undefined) budgets.max_tool_calls_per_subtask = mtc;
    if (mr !== undefined) budgets.max_retries_per_subtask = mr;
    if (Object.keys(budgets).length === 0) budgets = undefined;
  }

  return {
    project,
    ...(brief_id ? { brief_id } : {}),
    ...(deadline ? { deadline } : {}),
    scope_locked,
    ...(mode ? { mode } : {}),
    authorized_costs,
    ...(workdir ? { workdir } : {}),
    ...(mcp_servers ? { mcp_servers } : {}),
    ...(inherit_memory ? { inherit_memory } : {}),
    ...(learned_profile ? { learned_profile } : {}),
    ...(cli ? { cli } : {}),
    ...(roles ? { roles } : {}),
    ...(role_adapters ? { role_adapters: normalizeRoleAdapters(role_adapters) } : {}),
    ...(budgets ? { budgets } : {}),
  };
}

// v0.5.1: shape each role_adapters entry into a RoleAdapterConfig. `adapter`
// is required at construction time but we don't enforce that until the runner
// fills in the default; validator surfaces missing-adapter as a clear error.
function normalizeRoleAdapters(
  raw: Record<string, Record<string, unknown>>,
): Record<string, import("./types.js").RoleAdapterConfig> {
  const out: Record<string, import("./types.js").RoleAdapterConfig> = {};
  for (const [id, val] of Object.entries(raw)) {
    const adapter = typeof val.adapter === "string" ? val.adapter : "";
    const cfg: import("./types.js").RoleAdapterConfig = { adapter };
    if (typeof val.model === "string") cfg.model = val.model;
    for (const [k, v] of Object.entries(val)) {
      if (k === "adapter" || k === "model") continue;
      cfg[k] = v;
    }
    out[id] = cfg;
  }
  return out;
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
