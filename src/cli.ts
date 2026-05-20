import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { run } from "./runner.js";
import { parseBrief, validateBrief, generateBriefId } from "./brief.js";
import { listAdapters, makeAdapter } from "./adapters/index.js";
import { listSessions, readSession } from "./state/persist.js";
import { readTranscript } from "./state/transcript.js";
import { createTerminalIO, styles } from "./io.js";
import type { AdapterConfig, ExecutionMode } from "./types.js";
import { listNativeDefinitions } from "./tools/native/index.js";
import { loadGlobalMcpConfig, splitCommand, MCPClient, StdioTransport } from "./mcp/index.js";
import { readTrace } from "./state/trace.js";
import * as inspect from "./cli/inspect.js";
import { runReplay } from "./cli/replay.js";
import { runHistory, formatHistoryReport } from "./cli/history.js";
import { runChatCommand, ChatStartupError } from "./cli/chat.js";
import { buildHistoryReport } from "./state/history-report.js";
import { runLearn } from "./cli/learn.js";
import { formatLearnedView } from "./cli/inspect-learned.js";
import { loadLearnedProfile, LearnedProfileSchemaError } from "./state/learned-profile.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function getPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
        return pkg.version ?? "0.0.0";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fallthrough */
  }
  return "0.0.0";
}

function printHelp(): void {
  const v = getPackageVersion();
  const out = `openwar v${v}

Quickstart:
  openwar chat              Start a conversation (recommended for first-time use)
  openwar run brief.md      Run a hand-authored brief

Usage:
  openwar chat [--resume <chat_id>|last] [--adapter <id>] [--model <name>]
              [--exec-adapter <id>] [--exec-binary <path>] [--project <slug>]
              [--no-save]
  openwar run <brief.md> [--adapter <id>] [--model <name>] [--mode gated|auto]
                         [--workdir <path>] [--no-shell]
                         [--mcp-server name=command] [--resume] [--ephemeral]
                         [--roles planner,executor,reviewer[,critic]]
                         [--max-tokens N] [--max-minutes N] [--single]
                         [--cli-binary <path>] [--cli-arg a,b,c]
                         [--cli-timeout-ms N] [--cli-no-framework]
                         [--cli-tier free|paid]
  openwar resume <brief_id>
  openwar list
  openwar inspect <brief_id> [--transcript]
  openwar inspect <brief_id> --trace [--tail N | --full]
  openwar inspect <brief_id> --timing
  openwar inspect <brief_id> --cost [--dollar-per-1k <rate>]
  openwar inspect <brief_id> --detectors
  openwar inspect <brief_id> --tools
  openwar inspect <brief_id> --mcp
  openwar inspect <brief_id> --permissions
  openwar inspect <brief_id> --history                   # project history for this brief's slug
  openwar replay <brief_id>
  openwar dashboard [--port <n>]
  openwar history <project_slug> [--since <ISO>] [--min-samples N] [--json]
  openwar learn <project_slug> [--apply] [--reset] [--since <ISO>]
                               [--min-samples N] [--emit-frontmatter]
  openwar inspect <brief_id> --learned
  openwar validate <brief.md>
  openwar plan <brief.md> [--adapter <id>] [--model <name>]
  openwar roles
  openwar adapters
  openwar tools
  openwar mcp list
  openwar mcp add <name> <command...>
  openwar mcp remove <name>
  openwar mcp test <name>
  openwar memory list <project> [--category decisions|knowledge|constraints]
  openwar memory show <project> <entry_id>
  openwar memory remove <project> <entry_id>
  openwar mcp-serve --workdir <path> --authorized-costs <list>
                    [--project <slug>] [--brief-id <id>]
                    [--tool-log-path <path>] [--no-shell]
  openwar version
  openwar --help

Adapters:
  anthropic | openai | gemini | grok | openai-compat | cli-bridge | mock

Adapter env vars (BYOK):
  ANTHROPIC_API_KEY        Anthropic Claude
  OPENAI_API_KEY           OpenAI
  GEMINI_API_KEY           Google Gemini (or GOOGLE_API_KEY)
  XAI_API_KEY              xAI Grok
  OPENAI_COMPAT_API_KEY    OpenAI-compatible (OpenRouter, Groq, Together, Ollama, ...)

Defaults: adapter=anthropic, model=adapter-specific. Mode defaults from brief
frontmatter; if absent, runtime prompts.
`;
  process.stdout.write(out);
}

async function commandRun(parsed: ParsedFlags): Promise<number> {
  const briefPath = parsed.positional[1];
  if (!briefPath) {
    process.stderr.write("openwar run: missing <brief.md> argument\n");
    return 2;
  }
  const adapterId = (parsed.flags["adapter"] as string | undefined) ?? "anthropic";
  const config: AdapterConfig = { id: adapterId };
  if (typeof parsed.flags["model"] === "string") config.model = parsed.flags["model"];
  if (typeof parsed.flags["base-url"] === "string") config.baseUrl = parsed.flags["base-url"];

  // v0.5: cli-bridge adapter flags. --cli-binary is required when --adapter is
  // cli-bridge unless the brief frontmatter supplies a cli.binary instead.
  // --cli-arg accepts a comma-separated list (escape commas via the brief
  // frontmatter's cli.args array if you need literal commas in an argument).
  if (adapterId === "cli-bridge") {
    const extra: Record<string, unknown> = {};
    if (typeof parsed.flags["cli-binary"] === "string") extra.binary = parsed.flags["cli-binary"];
    if (typeof parsed.flags["cli-arg"] === "string") {
      extra.args = parsed.flags["cli-arg"]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (typeof parsed.flags["cli-timeout-ms"] === "string") {
      const n = Number(parsed.flags["cli-timeout-ms"]);
      if (Number.isFinite(n) && n > 0) extra.timeout_ms = n;
    }
    if (parsed.flags["cli-no-framework"] === true) extra.framework_prefix = false;
    if (parsed.flags["cli-tier"] === "free" || parsed.flags["cli-tier"] === "paid") {
      extra.tier = parsed.flags["cli-tier"];
    }
    config.extra = extra;
  }

  let adapter;
  try {
    adapter = makeAdapter(config);
  } catch (err) {
    process.stderr.write(`openwar: ${(err as Error).message}\n`);
    return 2;
  }
  if (!adapter.isConfigured()) {
    process.stderr.write(
      `openwar: adapter "${adapter.id}" not configured (missing API key env var).\n`,
    );
    return 2;
  }

  const mode =
    parsed.flags["mode"] === "auto" || parsed.flags["mode"] === "gated"
      ? (parsed.flags["mode"] as ExecutionMode)
      : undefined;

  const resume = parsed.flags["resume"] === true;
  const ephemeral = parsed.flags["ephemeral"] === true;
  const workdir = typeof parsed.flags["workdir"] === "string" ? parsed.flags["workdir"] : undefined;
  const disableShell = parsed.flags["no-shell"] === true;
  const mcpServers = parseMcpServerFlags(parsed.flags["mcp-server"]);

  // v0.4 multi-agent flags.
  let runtimeRoles: string[] | undefined;
  if (parsed.flags["single"] === true) {
    runtimeRoles = [];
  } else if (typeof parsed.flags["roles"] === "string") {
    runtimeRoles = parsed.flags["roles"]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const runtimeBudgets: Record<string, number> = {};
  if (typeof parsed.flags["max-tokens"] === "string") {
    const n = Number(parsed.flags["max-tokens"]);
    if (Number.isFinite(n) && n > 0) runtimeBudgets.max_tokens = n;
  }
  if (typeof parsed.flags["max-minutes"] === "string") {
    const n = Number(parsed.flags["max-minutes"]);
    if (Number.isFinite(n) && n > 0) runtimeBudgets.max_wall_clock_minutes = n;
  }

  const io = createTerminalIO();
  io.write(
    `${styles.dim(
      `openwar v${getPackageVersion()}  adapter=${adapter.id}  model=${adapter.model}`,
    )}\n`,
  );

  try {
    const result = await run({
      briefPath: resolve(briefPath),
      adapter,
      io,
      resume,
      ephemeral,
      ...(mode ? { mode } : {}),
      ...(workdir ? { workdir } : {}),
      ...(disableShell ? { disableShell } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
      ...(runtimeRoles !== undefined ? { runtimeRoles } : {}),
      ...(Object.keys(runtimeBudgets).length > 0 ? { runtimeBudgets } : {}),
    });
    io.write(
      `\n${styles.dim(
        `session=${result.session_id} final_phase=${result.final_phase} completed=${result.completed}` +
          (result.halted ? ` halted=${result.halt_reason ?? "true"}` : ""),
      )}\n`,
    );
    return result.completed ? 0 : 1;
  } catch (err) {
    process.stderr.write(`\nopenwar run failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function commandResume(parsed: ParsedFlags): Promise<number> {
  const briefId = parsed.positional[1];
  if (!briefId) {
    process.stderr.write("openwar resume: missing <brief_id> argument\n");
    return 2;
  }
  const session = readSession(briefId);
  if (!session) {
    process.stderr.write(`openwar resume: no session found for "${briefId}"\n`);
    return 1;
  }
  // Replace the brief path argv slot with the in-session brief, then re-enter
  // commandRun with the same flag set + --resume.
  // Easiest path: write brief raw to a temp arg-less call: use briefSource instead.
  const adapterId = (parsed.flags["adapter"] as string | undefined) ?? "anthropic";
  const config: AdapterConfig = { id: adapterId };
  if (typeof parsed.flags["model"] === "string") config.model = parsed.flags["model"];
  const adapter = makeAdapter(config);
  if (!adapter.isConfigured()) {
    process.stderr.write(
      `openwar: adapter "${adapter.id}" not configured (missing API key env var).\n`,
    );
    return 2;
  }
  const io = createTerminalIO();
  try {
    const result = await run({
      briefSource: session.brief.raw,
      adapter,
      io,
      resume: true,
      sessionId: session.meta.brief_id,
    });
    return result.completed ? 0 : 1;
  } catch (err) {
    process.stderr.write(`\nopenwar resume failed: ${(err as Error).message}\n`);
    return 1;
  }
}

function commandList(): number {
  const sessions = listSessions();
  if (sessions.length === 0) {
    process.stdout.write("No sessions yet.\n");
    return 0;
  }
  const w = process.stdout.write.bind(process.stdout);
  w(`${"brief_id".padEnd(28)}  ${"project".padEnd(20)}  ${"phase".padEnd(12)}  updated_at\n`);
  w(`${"-".repeat(28)}  ${"-".repeat(20)}  ${"-".repeat(12)}  -----------\n`);
  for (const s of sessions) {
    w(
      `${s.brief_id.padEnd(28)}  ${s.project.padEnd(20).slice(0, 20)}  ${s.phase.padEnd(12)}  ${s.updated_at}\n`,
    );
  }
  return 0;
}

function commandInspect(parsed: ParsedFlags): number {
  const briefId = parsed.positional[1];
  if (!briefId) {
    process.stderr.write("openwar inspect: missing <brief_id>\n");
    return 2;
  }
  const session = readSession(briefId);
  if (!session) {
    process.stderr.write(`openwar inspect: no session found for "${briefId}"\n`);
    return 1;
  }
  const w = process.stdout.write.bind(process.stdout);

  // v0.8: focused inspect modes. Each flag prints ONLY its view; only the
  // bare `openwar inspect <id>` (no mode flag) prints the legacy summary.
  const mode = resolveInspectMode(parsed.flags);
  if (mode) return commandInspectMode(briefId, mode, parsed.flags);

  w(`Brief:      ${session.meta.brief_id}\n`);
  w(`Project:    ${session.meta.project}\n`);
  w(`Started:    ${session.meta.started_at}\n`);
  w(`Updated:    ${session.meta.updated_at}\n`);
  w(`Phase:      ${session.meta.phase}\n`);
  w(`Mode:       ${session.meta.mode ?? "(unset)"}\n`);
  w(`Approvals:  ${session.meta.destructive_approvals.length}\n`);
  for (const a of session.meta.destructive_approvals) {
    w(`  ${a.at}  ${a.approved ? "APPROVED" : "DENIED"}  ${a.action}\n`);
  }
  w(`Transitions:\n`);
  for (const t of session.meta.transitions) {
    w(`  ${t.at}  ${t.from} -> ${t.to}  (${t.reason})\n`);
  }

  if (parsed.flags["transcript"] === true) {
    w(`\nTranscript:\n`);
    const entries = readTranscript(briefId);
    for (const e of entries) {
      w(`\n[${e.message.role}] ${e.message.at}\n`);
      w(e.message.content.trim() + "\n");
    }
  } else {
    w(`\nMessages: ${session.messages.length} (use --transcript to print full transcript, or --trace/--timing/--cost/--detectors/--tools/--mcp/--permissions for focused views)\n`);
  }
  return 0;
}

type InspectMode = "trace" | "timing" | "cost" | "detectors" | "tools" | "mcp" | "history" | "learned" | "permissions";

function resolveInspectMode(flags: Record<string, string | boolean>): InspectMode | null {
  if (flags["trace"] === true) return "trace";
  if (flags["timing"] === true) return "timing";
  if (flags["cost"] === true) return "cost";
  if (flags["detectors"] === true) return "detectors";
  if (flags["tools"] === true) return "tools";
  if (flags["mcp"] === true) return "mcp";
  if (flags["history"] === true) return "history";
  if (flags["learned"] === true) return "learned";
  if (flags["permissions"] === true) return "permissions";
  return null;
}

function commandInspectMode(briefId: string, mode: InspectMode, flags: Record<string, string | boolean>): number {
  const w = process.stdout.write.bind(process.stdout);
  // v0.9.0: --history is project-scoped. Look up the session's project slug
  // and render the full history report for that project.
  if (mode === "history") {
    const session = readSession(briefId);
    if (!session) {
      process.stderr.write(`openwar inspect: no session found for "${briefId}"\n`);
      return 1;
    }
    const { report, traceless_brief_ids } = buildHistoryReport({ slug: session.meta.project });
    w(formatHistoryReport(report, { traceless_brief_ids }));
    return 0;
  }
  // v0.9.1: --learned shows the learned profile for the brief's project slug
  // plus consultation history from the brief's trace events.
  if (mode === "learned") {
    const session = readSession(briefId);
    if (!session) {
      process.stderr.write(`openwar inspect: no session found for "${briefId}"\n`);
      return 1;
    }
    let profile;
    try {
      profile = loadLearnedProfile(session.meta.project);
    } catch (err) {
      if (err instanceof LearnedProfileSchemaError) {
        w(`learned profile is invalid: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    const traceRead = readTrace(briefId);
    w(formatLearnedView({
      briefId,
      slug: session.meta.project,
      profile,
      events: traceRead.events,
    }));
    void flags;
    return 0;
  }
  const { events, empty, corrupted_lines } = readTrace(briefId);
  if (empty) {
    w(`No trace events for "${briefId}". Sessions written before v0.8 only have a transcript; run with the latest openwar to capture traces.\n`);
    return 0;
  }
  if (corrupted_lines.length > 0) {
    w(`(${corrupted_lines.length} corrupted trace line(s) skipped: ${corrupted_lines.join(", ")})\n`);
  }
  switch (mode) {
    case "trace": {
      const tail = typeof flags["tail"] === "string" ? Number(flags["tail"]) : undefined;
      const full = flags["full"] === true;
      const traceOpts: Parameters<typeof inspect.formatTrace>[1] = {};
      if (typeof tail === "number" && Number.isFinite(tail)) traceOpts.tail = tail;
      if (full) traceOpts.full = true;
      w(inspect.formatTrace(events, traceOpts) + "\n");
      return 0;
    }
    case "timing":
      w(inspect.formatTiming(events) + "\n");
      return 0;
    case "cost": {
      const rate = typeof flags["dollar-per-1k"] === "string" ? Number(flags["dollar-per-1k"]) : undefined;
      const costOpts: Parameters<typeof inspect.formatCost>[1] = {};
      if (typeof rate === "number" && Number.isFinite(rate)) costOpts.dollar_per_1k_tokens = rate;
      w(inspect.formatCost(events, costOpts) + "\n");
      return 0;
    }
    case "detectors":
      w(inspect.formatDetectors(events) + "\n");
      return 0;
    case "tools":
      w(inspect.formatTools(events) + "\n");
      return 0;
    case "mcp":
      w(inspect.formatMcp(events) + "\n");
      return 0;
    case "permissions":
      w(inspect.formatPermissions(events) + "\n");
      return 0;
  }
}


function commandValidate(parsed: ParsedFlags): number {
  const path = parsed.positional[1];
  if (!path) {
    process.stderr.write("openwar validate: missing <brief.md>\n");
    return 2;
  }
  try {
    const brief = parseBrief(resolve(path));
    const result = validateBrief(brief);
    const w = process.stdout.write.bind(process.stdout);
    w(`Project:   ${brief.frontmatter.project || "(missing)"}\n`);
    w(`Brief id:  ${brief.frontmatter.brief_id ?? "(auto-generate: " + generateBriefId() + ")"}\n`);
    w(`Mode:      ${brief.frontmatter.mode ?? "(prompted)"}\n`);
    w(`Locked:    ${brief.frontmatter.scope_locked}\n`);
    w(`Costs:     ${brief.frontmatter.authorized_costs.join(", ") || "(none authorized)"}\n`);
    w(`Valid:     ${result.valid}\n`);
    for (const issue of result.issues) {
      w(`  [${issue.severity}] ${issue.field}: ${issue.message}\n`);
    }
    return result.valid ? 0 : 1;
  } catch (err) {
    process.stderr.write(`openwar validate: ${(err as Error).message}\n`);
    return 1;
  }
}

function commandAdapters(): number {
  const rows = listAdapters();
  const w = process.stdout.write.bind(process.stdout);
  w(`${"id".padEnd(16)}  ${"name".padEnd(28)}  configured\n`);
  w(`${"-".repeat(16)}  ${"-".repeat(28)}  ----------\n`);
  for (const r of rows) {
    w(`${r.id.padEnd(16)}  ${r.name.padEnd(28)}  ${r.configured ? "yes" : "no"}\n`);
  }
  return 0;
}

function commandTools(): number {
  const defs = listNativeDefinitions();
  const w = process.stdout.write.bind(process.stdout);
  w(`Native tools (${defs.length}):\n\n`);
  for (const d of defs) {
    w(`  ${d.name.padEnd(14)}  cat: ${d.authorization_categories.join(", ")}\n`);
    w(`  ${" ".repeat(14)}  ${d.description}\n\n`);
  }
  return 0;
}

// v0.4: list registered orchestration roles.
async function commandRoles(): Promise<number> {
  const { listRoles } = await import("./roles/registry.js");
  const defs = listRoles();
  const w = process.stdout.write.bind(process.stdout);
  w(`Registered roles (${defs.length}):\n\n`);
  for (const d of defs) {
    const scope = d.tool_categories.length === 0
      ? d.allow_read_file ? "read_file only" : "no tools"
      : d.tool_categories.join(", ");
    w(`  ${d.id.padEnd(10)}  tool scope: ${scope}\n`);
    w(`  ${" ".repeat(10)}  ${d.description}\n\n`);
  }
  return 0;
}

// v0.4: planner dry-run. Loads the brief, invokes only the planner role,
// prints the resulting plan handoff, and exits. No execution side effects.
async function commandPlan(parsed: ParsedFlags): Promise<number> {
  const briefPath = parsed.positional[1];
  if (!briefPath) {
    process.stderr.write("openwar plan: missing <brief.md> argument\n");
    return 2;
  }
  const adapterId = (parsed.flags["adapter"] as string | undefined) ?? "anthropic";
  const config: AdapterConfig = { id: adapterId };
  if (typeof parsed.flags["model"] === "string") config.model = parsed.flags["model"];
  if (typeof parsed.flags["base-url"] === "string") config.baseUrl = parsed.flags["base-url"];

  let adapter;
  try {
    adapter = makeAdapter(config);
  } catch (err) {
    process.stderr.write(`openwar plan: ${(err as Error).message}\n`);
    return 2;
  }
  if (!adapter.isConfigured()) {
    process.stderr.write(
      `openwar plan: adapter "${adapter.id}" not configured (missing API key env var).\n`,
    );
    return 2;
  }

  const { parsePlanFromText, scopeWarningsForPlan } = await import("./coordinator/plan-parser.js");
  const { buildSystemPrompt } = await import("./roles/prompt-overlay.js");
  const { getRole } = await import("./roles/registry.js");
  const { loadFrameworkDoc } = await import("./framework.js");
  const planner = getRole("planner");
  if (!planner) {
    process.stderr.write("openwar plan: planner role not registered.\n");
    return 1;
  }
  const framework = loadFrameworkDoc();
  const brief = parseBrief(resolve(briefPath));
  const system = buildSystemPrompt({
    framework,
    brief,
    role: planner,
    extra: "This is a dry-run plan request. Do not execute. Just produce the plan handoff.",
  });
  const userTurn = "Decompose this brief into linear sub-tasks. End with the fenced JSON plan handoff.";

  const io = createTerminalIO();
  io.write(`${styles.dim(`openwar plan v${getPackageVersion()}  adapter=${adapter.id}  model=${adapter.model}`)}\n`);
  io.banner("planner (dry-run)");
  let assembled = "";
  for await (const ev of adapter.sendMessage({
    system,
    messages: [{
      role: "user",
      content: userTurn,
      at: new Date().toISOString(),
    }],
  })) {
    if (ev.type === "text_delta") {
      io.write(ev.delta);
      assembled += ev.delta;
    } else if (ev.type === "done") {
      io.write("\n");
      if (ev.message && ev.message.length >= assembled.length) assembled = ev.message;
      break;
    } else if (ev.type === "error") {
      process.stderr.write(`\nopenwar plan: ${ev.error.message}\n`);
      return 1;
    }
  }
  const parsedPlan = parsePlanFromText(assembled);
  if (!parsedPlan.ok) {
    process.stderr.write(`\nopenwar plan: planner output invalid (${parsedPlan.reason}): ${parsedPlan.message}\n`);
    return 1;
  }
  io.banner("Plan summary");
  const w = process.stdout.write.bind(process.stdout);
  w(`Rationale: ${parsedPlan.plan.rationale || "(none)"}\n\n`);
  w(`Sub-tasks (${parsedPlan.plan.subtasks.length}):\n`);
  for (const st of parsedPlan.plan.subtasks) {
    w(`  ${st.order + 1}. ${st.title}\n`);
    w(`     id: ${st.id}\n`);
    w(`     instruction: ${st.instruction}\n`);
    w(`     acceptance: ${st.acceptance_criteria.length}\n`);
  }
  const warns = scopeWarningsForPlan(parsedPlan.plan, brief);
  if (warns.length > 0) {
    w(`\nScope warnings (non-blocking):\n`);
    for (const wnote of warns) w(`  ${wnote.subtask_id}: ${wnote.category} (match: ${wnote.match})\n`);
  }
  return 0;
}

function parseMcpServerFlags(value: string | boolean | undefined): { name: string; command: string }[] {
  if (typeof value !== "string") return [];
  // One or more --mcp-server name=command. The parser keeps only the last value
  // when repeated; for multiple, callers use comma-separated entries.
  const parts = value.split(",");
  const out: { name: string; command: string }[] = [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const command = part.slice(eq + 1).trim();
    if (name && command) out.push({ name, command });
  }
  return out;
}

function mcpConfigPath(): string {
  return join(homedir(), ".openwar", "mcp.json");
}

// v0.7: MCP server subprocess for cli-bridge MCP-server-mode. Spawned by the
// bridged CLI (Claude Code, etc) when the brief enables mcp_forward. Runs an
// MCP server on stdin/stdout that exposes OpenWar's native tools with the
// brief's authorized_costs as the auth gate. Logs every call to the JSONL
// at --tool-log-path so the parent runtime folds them into the transcript.
async function commandMcpServe(parsed: ParsedFlags): Promise<number> {
  const { runOpenwarMcpServer } = await import("./mcp/openwar-server-runtime.js");
  const workdir = typeof parsed.flags["workdir"] === "string" ? parsed.flags["workdir"] : process.cwd();
  const authorizedCostsRaw = typeof parsed.flags["authorized-costs"] === "string" ? parsed.flags["authorized-costs"] : "";
  const authorizedCosts = authorizedCostsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const project = typeof parsed.flags["project"] === "string" ? parsed.flags["project"] : undefined;
  const briefId = typeof parsed.flags["brief-id"] === "string" ? parsed.flags["brief-id"] : undefined;
  const toolLogPath = typeof parsed.flags["tool-log-path"] === "string" ? parsed.flags["tool-log-path"] : undefined;
  const shellEnabled = parsed.flags["no-shell"] !== true;
  const server = await runOpenwarMcpServer({
    workdir,
    authorizedCosts,
    shellEnabled,
    ...(project && { project_slug: project }),
    ...(briefId && { brief_id: briefId }),
    ...(toolLogPath && { toolLogPath }),
  });
  await server.closed;
  return 0;
}

// v0.6: out-of-session inspection and pruning of per-project memory.
async function commandMemory(parsed: ParsedFlags): Promise<number> {
  const { readMemory, removeMemoryEntry, MEMORY_CATEGORIES } =
    await import("./state/memory.js");
  type Cat = typeof MEMORY_CATEGORIES[number];
  const sub = parsed.positional[1];
  const w = process.stdout.write.bind(process.stdout);

  if (sub === "list") {
    const project = parsed.positional[2];
    if (!project) {
      process.stderr.write("openwar memory list: missing <project>\n");
      return 2;
    }
    const cats: Cat[] =
      typeof parsed.flags["category"] === "string" &&
      MEMORY_CATEGORIES.includes(parsed.flags["category"] as Cat)
        ? [parsed.flags["category"] as Cat]
        : [...MEMORY_CATEGORIES];
    for (const cat of cats) {
      const { entries, corrupted_lines } = await readMemory(project, { category: cat, limit: 0 });
      w(`\n=== ${cat} (${entries.length}${corrupted_lines.length ? `, ${corrupted_lines.length} corrupted` : ""}) ===\n`);
      for (const e of entries) {
        const head = `${e.id}  ${e.at}`;
        if (e.category === "decisions") w(`  ${head}  ${e.summary}\n`);
        else if (e.category === "knowledge") w(`  ${head}  ${e.content.slice(0, 80).replace(/\s+/g, " ")}\n`);
        else w(`  ${head}  ${e.rule}\n`);
      }
      if (corrupted_lines.length > 0) {
        w(`  (corrupted lines: ${corrupted_lines.join(", ")}; inspect ~/.openwar/projects/${project}/${cat}.jsonl)\n`);
      }
    }
    return 0;
  }

  if (sub === "show") {
    const project = parsed.positional[2];
    const entryId = parsed.positional[3];
    if (!project || !entryId) {
      process.stderr.write("openwar memory show: needs <project> <entry_id>\n");
      return 2;
    }
    for (const cat of MEMORY_CATEGORIES) {
      const { entries } = await readMemory(project, { category: cat, limit: 0 });
      const found = entries.find((e) => e.id === entryId);
      if (found) {
        w(JSON.stringify(found, null, 2) + "\n");
        return 0;
      }
    }
    process.stderr.write(`openwar memory show: entry "${entryId}" not found in project "${project}"\n`);
    return 1;
  }

  if (sub === "remove") {
    const project = parsed.positional[2];
    const entryId = parsed.positional[3];
    if (!project || !entryId) {
      process.stderr.write("openwar memory remove: needs <project> <entry_id>\n");
      return 2;
    }
    for (const cat of MEMORY_CATEGORIES) {
      const removed = await removeMemoryEntry(project, cat, entryId);
      if (removed) {
        w(`Removed ${entryId} from ${cat}.\n`);
        return 0;
      }
    }
    process.stderr.write(`openwar memory remove: entry "${entryId}" not found in project "${project}"\n`);
    return 1;
  }

  process.stderr.write(`openwar memory: unknown subcommand "${sub ?? ""}". See 'openwar --help'.\n`);
  return 2;
}

async function commandChat(parsed: ParsedFlags): Promise<number> {
  const opts: Parameters<typeof runChatCommand>[0] = {};
  if (typeof parsed.flags["resume"] === "string") opts.resume = parsed.flags["resume"];
  if (typeof parsed.flags["adapter"] === "string") opts.adapter = parsed.flags["adapter"];
  if (typeof parsed.flags["model"] === "string") opts.model = parsed.flags["model"];
  if (typeof parsed.flags["exec-adapter"] === "string") opts.execAdapter = parsed.flags["exec-adapter"];
  if (typeof parsed.flags["exec-binary"] === "string") opts.execBinary = parsed.flags["exec-binary"];
  if (typeof parsed.flags["project"] === "string") opts.project = parsed.flags["project"];
  if (parsed.flags["no-save"] === true) opts.noSave = true;
  try {
    return await runChatCommand(opts);
  } catch (err) {
    if (err instanceof ChatStartupError) {
      process.stderr.write(`openwar chat: ${err.message}\n`);
      return err.code === "NO_ADAPTER" || err.code === "INCOMPATIBLE_ADAPTER" ? 2 : 1;
    }
    throw err;
  }
}

function commandLearn(parsed: ParsedFlags): number {
  const slug = parsed.positional[1];
  if (!slug) {
    process.stderr.write("openwar learn: missing <project_slug>\n");
    return 2;
  }
  const opts: Parameters<typeof runLearn>[2] = {};
  if (parsed.flags["apply"] === true) opts.apply = true;
  if (parsed.flags["reset"] === true) opts.reset = true;
  if (typeof parsed.flags["since"] === "string") opts.since = parsed.flags["since"];
  if (typeof parsed.flags["min-samples"] === "string") {
    const n = Number(parsed.flags["min-samples"]);
    if (Number.isFinite(n) && n >= 5) opts.minSamples = n;
  }
  if (parsed.flags["emit-frontmatter"] === true) opts.emitFrontmatter = true;
  runLearn(slug, process.stdout.write.bind(process.stdout), opts);
  return 0;
}

function commandHistory(parsed: ParsedFlags): number {
  const slug = parsed.positional[1];
  if (!slug) {
    process.stderr.write("openwar history: missing <project_slug>\n");
    return 2;
  }
  const opts: Parameters<typeof runHistory>[2] = {};
  if (typeof parsed.flags["since"] === "string") opts.since = parsed.flags["since"];
  if (typeof parsed.flags["min-samples"] === "string") {
    const n = Number(parsed.flags["min-samples"]);
    if (Number.isFinite(n) && n >= 2) opts.minSamples = n;
  }
  if (parsed.flags["json"] === true) opts.json = true;
  const write = process.stdout.write.bind(process.stdout);
  runHistory(slug, write, opts);
  return 0;
}

function commandReplay(parsed: ParsedFlags): number {
  const briefId = parsed.positional[1];
  if (!briefId) {
    process.stderr.write("openwar replay: missing <brief_id>\n");
    return 2;
  }
  const result = runReplay({ briefId });
  // Exit non-zero when current detector code disagrees with recorded trace.
  // Useful as a regression gate in CI.
  if (result.drift_count > 0) return 1;
  return 0;
}

async function commandDashboard(parsed: ParsedFlags): Promise<number> {
  const portStr = typeof parsed.flags["port"] === "string" ? parsed.flags["port"] : "8780";
  const port = Number(portStr);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    process.stderr.write(`openwar dashboard: invalid --port "${portStr}"\n`);
    return 2;
  }
  const { startDashboard } = await import("./dashboard/server.js");
  const server = await startDashboard({ port });
  process.stdout.write(`openwar dashboard: http://127.0.0.1:${port}/\n`);
  process.stdout.write(`Press Ctrl+C to stop.\n`);
  // Keep the process alive until SIGINT.
  return new Promise<number>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function commandMcp(parsed: ParsedFlags): Promise<number> {
  const sub = parsed.positional[1];
  const w = process.stdout.write.bind(process.stdout);
  if (sub === "list" || sub === undefined) {
    const servers = await loadGlobalMcpConfig().catch(err => {
      process.stderr.write(`openwar mcp: ${(err as Error).message}\n`);
      return null;
    });
    if (servers === null) return 1;
    if (servers.length === 0) {
      w(`No MCP servers configured. Add one with: openwar mcp add <name> <command...>\n`);
      return 0;
    }
    for (const s of servers) {
      w(`${s.name.padEnd(20)}  ${s.command}\n`);
    }
    return 0;
  }
  if (sub === "add") {
    const name = parsed.positional[2];
    const command = parsed.positional.slice(3).join(" ");
    if (!name || !command) {
      process.stderr.write("openwar mcp add: needs <name> and <command...>\n");
      return 2;
    }
    const path = mcpConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    const existing = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as { servers?: { name: string; command: string }[] })
      : { servers: [] };
    const servers = (existing.servers ?? []).filter(s => s.name !== name);
    servers.push({ name, command });
    writeFileSync(path, JSON.stringify({ servers }, null, 2), "utf8");
    w(`Added "${name}" to ${path}\n`);
    return 0;
  }
  if (sub === "remove") {
    const name = parsed.positional[2];
    if (!name) {
      process.stderr.write("openwar mcp remove: needs <name>\n");
      return 2;
    }
    const path = mcpConfigPath();
    if (!existsSync(path)) {
      w(`No mcp.json yet. Nothing to remove.\n`);
      return 0;
    }
    const existing = JSON.parse(readFileSync(path, "utf8")) as { servers?: { name: string; command: string }[] };
    const before = (existing.servers ?? []).length;
    existing.servers = (existing.servers ?? []).filter(s => s.name !== name);
    writeFileSync(path, JSON.stringify(existing, null, 2), "utf8");
    w(`${before - existing.servers.length} entry/entries removed.\n`);
    return 0;
  }
  if (sub === "test") {
    const name = parsed.positional[2];
    if (!name) {
      process.stderr.write("openwar mcp test: needs <name>\n");
      return 2;
    }
    const servers = await loadGlobalMcpConfig().catch(() => []);
    const cfg = servers.find(s => s.name === name);
    if (!cfg) {
      process.stderr.write(`openwar mcp test: "${name}" not in config.\n`);
      return 1;
    }
    try {
      const { bin, args } = splitCommand(cfg.command);
      const transport = new StdioTransport({ command: bin, args, defaultTimeoutMs: 5000 });
      const client = new MCPClient({ transport });
      await client.connect();
      const tools = await client.listTools();
      const info = client.getServerInfo();
      w(`Connected to ${info?.name ?? cfg.name} (${info?.version ?? "?"})\n`);
      w(`Protocol OK. ${tools.length} tool(s):\n`);
      for (const t of tools) w(`  ${t.name}  ${t.description ?? ""}\n`);
      await client.disconnect();
      return 0;
    } catch (err) {
      process.stderr.write(`openwar mcp test: ${(err as Error).message}\n`);
      return 1;
    }
  }
  process.stderr.write(`openwar mcp: unknown subcommand "${sub}". See 'openwar --help'.\n`);
  return 2;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp();
    return 0;
  }
  if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(getPackageVersion() + "\n");
    return 0;
  }

  const parsed = parseArgv(argv);
  const cmd = parsed.positional[0];

  switch (cmd) {
    case "run":
      return commandRun(parsed);
    case "resume":
      return commandResume(parsed);
    case "list":
      return commandList();
    case "inspect":
      return commandInspect(parsed);
    case "validate":
      return commandValidate(parsed);
    case "adapters":
      return commandAdapters();
    case "tools":
      return commandTools();
    case "mcp":
      return await commandMcp(parsed);
    case "roles":
      return await commandRoles();
    case "plan":
      return await commandPlan(parsed);
    case "memory":
      return await commandMemory(parsed);
    case "mcp-serve":
      return await commandMcpServe(parsed);
    case "replay":
      return commandReplay(parsed);
    case "dashboard":
      return await commandDashboard(parsed);
    case "history":
      return commandHistory(parsed);
    case "learn":
      return commandLearn(parsed);
    case "chat":
      return await commandChat(parsed);
    default:
      process.stderr.write(`openwar: unknown command "${cmd}". See 'openwar --help'.\n`);
      return 2;
  }
}

// Module-level guard: only auto-run when executed via the bin shim.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`openwar: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}

