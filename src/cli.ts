import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { run } from "./runner.js";
import { parseBrief, validateBrief, generateBriefId } from "./brief.js";
import { listAdapters, makeAdapter } from "./adapters/index.js";
import { listSessions, readSession } from "./state/persist.js";
import { readTranscript } from "./state/transcript.js";
import { createTerminalIO, styles } from "./io.js";
import type { AdapterConfig, ExecutionMode } from "./types.js";

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

Usage:
  openwar run <brief.md> [--adapter <id>] [--model <name>] [--mode gated|auto]
                         [--resume] [--ephemeral]
  openwar resume <brief_id>
  openwar list
  openwar inspect <brief_id> [--transcript]
  openwar validate <brief.md>
  openwar adapters
  openwar version
  openwar --help

Adapters:
  anthropic | openai | gemini | grok | openai-compat | mock

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
    w(`\nMessages: ${session.messages.length} (use --transcript to print full transcript)\n`);
  }
  return 0;
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

