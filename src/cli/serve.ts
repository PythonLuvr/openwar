// v0.13.0: openwar serve subcommand entry point.
//
// Parses the serve-specific flags, resolves the upstream adapter, starts
// the HTTP server, prints a startup banner with the curl example (Phase 0
// Q5 ruling), and waits for SIGINT to gracefully shut down.

import { makeAdapter, type AdapterId } from "../adapters/index.js";
import type { AdapterConfig } from "../types.js";
import { startServer } from "../serve/server.js";
import type { ServeOptions } from "../serve/types.js";
import { runtimeVersion } from "../version.js";

export interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

// Default authorized_costs for synthesized briefs in the proxy. Per the
// brief: conservative (filesystem_read only). Operators expand via the
// --authorized-costs CLI flag.
const DEFAULT_AUTHORIZED_COSTS = ["filesystem_read"];

// Default port: 1234. LM Studio convention; friendly to existing
// OpenAI-compat client habits. Phase 0 Q10 ruling.
const DEFAULT_PORT = 1234;

// Default bind: 127.0.0.1. Binding to 0.0.0.0 requires explicit operator
// intent and emits a startup warning.
const DEFAULT_BIND = "127.0.0.1";

// Default max-concurrent: 4. Excess returns 429 per Phase 0 Q7.
const DEFAULT_MAX_CONCURRENT = 4;

// Auto-detect upstream adapter when --upstream-adapter is not specified.
// Mirrors `openwar chat`'s precedence so the proxy behaves predictably
// for operators already comfortable with chat's BYOK auto-detection.
const UPSTREAM_AUTODETECT: Array<{ envVar: string; adapter: AdapterId }> = [
  { envVar: "ANTHROPIC_API_KEY", adapter: "anthropic" },
  { envVar: "OPENAI_API_KEY", adapter: "openai" },
  { envVar: "GEMINI_API_KEY", adapter: "gemini" },
  { envVar: "GOOGLE_API_KEY", adapter: "gemini" },
  { envVar: "XAI_API_KEY", adapter: "grok" },
  { envVar: "OPENAI_COMPAT_API_KEY", adapter: "openai-compat" },
];

export async function runServeCommand(parsed: ParsedFlags): Promise<number> {
  const opts = resolveServeOptions(parsed);
  if (opts instanceof Error) {
    process.stderr.write(`openwar serve: ${opts.message}\n`);
    return 2;
  }

  // Resolve upstream adapter.
  const adapterId = opts.upstreamAdapter ?? autoDetectUpstreamAdapter();
  if (!adapterId) {
    process.stderr.write(
      "openwar serve: no upstream adapter configured. Pass --upstream-adapter or set one of:\n  " +
        UPSTREAM_AUTODETECT.map((u) => u.envVar).join(", ") + "\n",
    );
    return 2;
  }
  const adapterConfig: AdapterConfig = { id: adapterId };
  if (opts.upstreamModel) adapterConfig.model = opts.upstreamModel;
  const adapter = makeAdapter(adapterConfig);
  if (!adapter.isConfigured()) {
    process.stderr.write(
      `openwar serve: upstream adapter "${adapterId}" is not configured. Check its API-key env var.\n`,
    );
    return 2;
  }

  // Auth precondition: refuse to start without --auth-token UNLESS
  // --no-auth is explicit. Localhost-default plus auth-by-default is
  // the security stance per the brief.
  if (!opts.noAuth && !opts.authToken) {
    process.stderr.write(
      "openwar serve: refusing to start without authentication.\n" +
        "  Set --auth-token <token> to require a bearer token, OR\n" +
        "  Pass --no-auth to disable auth (warned every startup; safe ONLY on a\n" +
        "  trusted localhost with no other users on the machine).\n",
    );
    return 2;
  }

  // Bind warning: 0.0.0.0 means listening on every interface, including
  // the network. Explicit warn so the operator can't claim surprise.
  if (opts.bind === "0.0.0.0") {
    process.stderr.write(
      "WARNING: --bind 0.0.0.0 exposes the proxy on every network interface.\n" +
        "         Make sure your firewall, TLS termination, and auth posture\n" +
        "         are configured for that surface.\n",
    );
  }
  if (opts.noAuth) {
    process.stderr.write(
      "WARNING: --no-auth disables bearer-token authentication.\n" +
        "         Use ONLY on a trusted localhost with no other users.\n",
    );
  }

  // cli-bridge upstream warning per Phase 0 Q4 ruling. Each request
  // spawns a fresh CLI child; concurrency multiplies cold-start latency
  // and memory.
  if (adapterId === "cli-bridge") {
    process.stderr.write(
      "WARNING: cli-bridge as upstream spawns one CLI child per request.\n" +
        "         Each request adds 2-5s of cold-start latency. Concurrent\n" +
        "         requests scale memory by ~400MB per Claude Code instance.\n" +
        "         Consider --max-concurrent 1 for cli-bridge upstream.\n",
    );
  }

  // Start the server.
  const handle = await startServer({
    options: opts,
    upstream: adapter,
    openwarVersion: runtimeVersion(),
  });

  // Startup banner. Phase 0 Q5: print the curl command needed to test
  // the server. Also surface the authorized_costs expansion hint per
  // Phase 0 first-time-UX callout.
  const url = `http://${handle.address.host}:${handle.address.port}`;
  process.stderr.write(
    `\nopenwar serve v${runtimeVersion()} listening on ${url}\n` +
      `  upstream: ${adapterId} (${adapter.model})\n` +
      `  authorized_costs: ${opts.authorizedCosts.join(", ")}\n` +
      `  (Default authorized_costs is filesystem_read only. Agentic clients\n` +
      `   typically need --authorized-costs filesystem_read,filesystem_write,shell_exec\n` +
      `   to do useful work. Expand explicitly per your trust model.)\n\n` +
      `Test it:\n` +
      `  curl -X POST ${url}/v1/chat/completions \\\n` +
      `    -H "Authorization: Bearer ${opts.noAuth ? "(no auth)" : "<your-token>"}" \\\n` +
      `    -H "Content-Type: application/json" \\\n` +
      `    -d '{"model": "openwar", "messages": [{"role":"user","content":"hi"}]}'\n\n` +
      `Inspect a completed request:\n` +
      `  openwar inspect <X-OpenWar-Trace-Id-from-response-header>\n\n`,
  );

  // Wait for SIGINT to drain. The server's close() handles graceful
  // shutdown; we set up the signal handler here and await its trigger.
  return await new Promise<number>((resolve) => {
    let shuttingDown = false;
    const onSigint = (): void => {
      if (shuttingDown) {
        // Second Ctrl-C: force-exit. Pattern mirrors the chat REPL's
        // escalation behavior from v0.11.1.
        process.stderr.write("openwar serve: forced exit on second SIGINT.\n");
        process.exit(130);
      }
      shuttingDown = true;
      process.stderr.write("\nopenwar serve: draining in-flight requests (5s max)...\n");
      void handle.close({ drainMs: 5000 }).then(() => {
        process.stderr.write("openwar serve: stopped.\n");
        resolve(0);
      });
    };
    process.on("SIGINT", onSigint);
  });
}

// Build ServeOptions from the parsed CLI flags. Returns an Error
// (sentinel; not thrown) for invalid combinations so the caller can
// print a clean message and return exit code 2 without a stack trace.
function resolveServeOptions(parsed: ParsedFlags): ServeOptions | Error {
  const f = parsed.flags;
  const openaiCompat = f["openai-compat"] === true;
  if (!openaiCompat) {
    return new Error("missing --openai-compat. v0.13.0 ships only the OpenAI-compatible serve mode.");
  }
  const port = typeof f["port"] === "string" ? Number(f["port"]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return new Error(`invalid --port "${String(f["port"])}". Must be 1-65535.`);
  }
  const bind = typeof f["bind"] === "string" ? f["bind"] : DEFAULT_BIND;
  const upstreamAdapter = typeof f["upstream-adapter"] === "string" ? f["upstream-adapter"] : null;
  const upstreamModel = typeof f["upstream-model"] === "string" ? f["upstream-model"] : null;
  const authToken = typeof f["auth-token"] === "string" ? f["auth-token"] : null;
  const noAuth = f["no-auth"] === true;
  const workdir = typeof f["workdir"] === "string" ? f["workdir"] : process.cwd();
  const authorizedCosts = parseAuthorizedCosts(f["authorized-costs"]);
  const maxConcurrent = typeof f["max-concurrent"] === "string"
    ? Number(f["max-concurrent"])
    : DEFAULT_MAX_CONCURRENT;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    return new Error(`invalid --max-concurrent "${String(f["max-concurrent"])}". Must be a positive integer.`);
  }
  const logRequests = f["log-requests"] === true;

  return {
    openaiCompat,
    bind,
    port,
    authToken,
    noAuth,
    upstreamAdapter,
    upstreamModel,
    workdir,
    authorizedCosts,
    maxConcurrent,
    logRequests,
  };
}

function parseAuthorizedCosts(value: string | boolean | undefined): string[] {
  if (typeof value !== "string" || value.length === 0) return [...DEFAULT_AUTHORIZED_COSTS];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function autoDetectUpstreamAdapter(): AdapterId | null {
  const env = process.env;
  for (const { envVar, adapter } of UPSTREAM_AUTODETECT) {
    if (env[envVar] && env[envVar]!.length > 0) return adapter;
  }
  return null;
}

// Help text for the serve subcommand. Exported for the top-level cli.ts
// help printer to include.
export const SERVE_HELP = `
openwar serve --openai-compat [flags]
  Expose OpenWar's runtime as an OpenAI Chat Completions HTTP server.
  Any tool that speaks OpenAI's Chat Completions API can point at the
  server and consume OpenWar's discipline layer with zero changes on
  its end.

Flags:
  --openai-compat            (required) enable the OpenAI Chat Completions mode
  --port <n>                 bind port (default 1234, LM Studio convention)
  --bind <host>              bind host (default 127.0.0.1)
  --upstream-adapter <id>    upstream adapter (anthropic, openai, gemini, grok,
                             openai-compat, cli-bridge). Defaults to auto-detect
                             via standard BYOK env-var precedence.
  --upstream-model <name>    default upstream model. Substitutes the client's
                             requested model when it does not match.
  --auth-token <token>       required bearer token (Authorization: Bearer <token>)
  --no-auth                  disable bearer-token auth (warns every startup)
  --workdir <path>           cwd for the synthesized brief (default: current cwd)
  --authorized-costs <list>  comma-separated authorized_costs for synthesized
                             briefs (default: filesystem_read only). Expand
                             explicitly for agentic clients.
  --max-concurrent <n>       in-flight request cap (default 4; excess returns 429)
  --log-requests             print one line per request to stderr

See docs/openai-proxy.md for the full surface, integration examples, and the
threat model.
`.trim();
