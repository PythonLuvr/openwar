// CLI-bridge adapter (v0.5).
//
// Treats a CLI binary as an agent. The runtime delegates by shelling out to
// the configured binary, capturing stdout, and feeding chunks back through
// the StreamEvent contract the same way an LLM API adapter would.
//
// Non-goals for v0.5 (documented in openwar.md):
//   - Native tool-call translation. CLIs use their own tools.
//   - MCP brokering. The CLI's MCP servers are its business.
//   - Session-state forwarding. Operator manages CLI sessions externally.
//
// Authorization: every invocation of a cli-bridge adapter requires
// `shell_exec` in the brief's authorized_costs (or in session_approved).
// The runtime enforces this at the boundary; the adapter itself trusts
// that it's only constructed for an authorized run.

import { spawn } from "node:child_process";
import type { AgentAdapter, SendMessageOptions, StreamEvent, AdapterConfig, Message } from "../types.js";

export type AdapterTier = "free" | "paid";

export interface CliBridgeOptions {
  // Path or PATH-resolvable binary. Required.
  binary: string;
  // Optional default args inserted before the prompt argv tail.
  args?: string[];
  // Hard timeout for a single sendMessage call. Default 10 min.
  timeout_ms?: number;
  // Optional working directory. Defaults to process.cwd().
  working_dir?: string;
  // Extra env to merge. Caller env wins on conflict.
  env?: Record<string, string>;
  // When true (default), the framework doc gets prepended to the prompt so
  // bridged CLIs that don't already implement OpenWar get the behavioral
  // overlay. When false, the system prompt is dropped and only the
  // conversation is sent (used when the CLI has OpenWar in its own config).
  framework_prefix?: boolean;
  // Tier label surfaced to the cost preview. Bridged CLIs are typically
  // "free" because they use a local subscription; set to "paid" if your
  // CLI bills per call.
  tier?: AdapterTier;
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

function serializeMessages(system: string, messages: Message[], framework_prefix: boolean): string {
  const parts: string[] = [];
  if (framework_prefix && system.trim().length > 0) {
    parts.push(system.trim());
    parts.push("");
    parts.push("---");
    parts.push("");
  }
  for (const m of messages) {
    parts.push(`${m.role}:`);
    parts.push(m.content);
    parts.push("");
  }
  return parts.join("\n");
}

// Narrow accessors against the loosely-typed extra bag.
function readString(extra: Record<string, unknown>, key: string): string | undefined {
  const v = extra[key];
  return typeof v === "string" ? v : undefined;
}
function readNumber(extra: Record<string, unknown>, key: string): number | undefined {
  const v = extra[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function readBoolean(extra: Record<string, unknown>, key: string): boolean | undefined {
  const v = extra[key];
  return typeof v === "boolean" ? v : undefined;
}
function readStringArray(extra: Record<string, unknown>, key: string): string[] | undefined {
  const v = extra[key];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}
function readStringMap(extra: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const v = extra[key];
  if (v === null || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export class CliBridgeAdapter implements AgentAdapter {
  readonly id = "cli-bridge";
  readonly name: string;
  readonly model: string;
  readonly tier: AdapterTier;
  private readonly options: Required<Omit<CliBridgeOptions, "env" | "working_dir">> & {
    env?: Record<string, string>;
    working_dir?: string;
  };

  constructor(config: AdapterConfig) {
    const extra = config.extra ?? {};
    const binary = readString(extra, "binary");
    if (!binary) {
      throw new Error(
        'cli-bridge adapter requires "binary" in adapter config (e.g. extra: { binary: "claude" })',
      );
    }
    const tier = readString(extra, "tier");
    const args = readStringArray(extra, "args");
    const timeout_ms = readNumber(extra, "timeout_ms");
    const framework_prefix = readBoolean(extra, "framework_prefix");
    const working_dir = readString(extra, "working_dir");
    const envOverride = readStringMap(extra, "env");

    this.options = {
      binary,
      args: args ? [...args] : [],
      timeout_ms: timeout_ms !== undefined && timeout_ms > 0 ? timeout_ms : DEFAULT_TIMEOUT_MS,
      framework_prefix: framework_prefix !== false,
      tier: tier === "paid" ? "paid" : "free",
    };
    if (working_dir) this.options.working_dir = working_dir;
    if (envOverride) this.options.env = envOverride;
    this.tier = this.options.tier;
    this.name = `CLI bridge (${this.options.binary})`;
    this.model = config.model ?? this.options.binary;
  }

  isConfigured(): boolean {
    // Adapter is "configured" if the binary string is set. Whether the
    // binary actually exists on PATH is verified at spawn time and surfaces
    // as a Phase 2 blocker if missing. Same model as the API adapters which
    // can't pre-verify keys without making a call.
    return typeof this.options.binary === "string" && this.options.binary.length > 0;
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    const prompt = serializeMessages(opts.system, opts.messages, this.options.framework_prefix);
    const argv = [...this.options.args];
    const env = { ...process.env, ...(this.options.env ?? {}) };

    // v0.6.2: Windows needs `shell: true` in two cases.
    //
    //   1. The binary explicitly ends in .cmd or .bat. Node's child_process
    //      cannot spawn those without a shell on Windows (documented).
    //   2. The binary has no extension at all (e.g. `--cli-binary claude`).
    //      That's the natural shape operators type to match the binary's
    //      name on PATH. Without shell mode, Windows CreateProcess does not
    //      walk PATHEXT, so npm-installed CLIs (which land as .cmd shims)
    //      fail with ENOENT. Shell mode lets cmd.exe do the PATHEXT walk.
    //
    // We do NOT unconditionally enable shell on Windows because the shell
    // re-parses argv and mangles any binary path containing a space
    // (the `C:\Program Files\nodejs\node.exe` case). Direct executables
    // with an extension (.exe, .com) keep shell: false; CreateProcess
    // handles them fine even when the path has spaces. POSIX is unaffected.
    const needsShell =
      process.platform === "win32" &&
      (/\.(cmd|bat)$/i.test(this.options.binary) ||
        !/\.[^./\\]+$/.test(this.options.binary));
    const child = spawn(this.options.binary, argv, {
      cwd: this.options.working_dir,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
    });

    let assembled = "";
    let stderrBuf = "";
    let timedOut = false;
    let spawnError: Error | null = null;

    // Watch for spawn errors (ENOENT, EACCES). These fire before any stdio
    // event and need their own handler. v0.5.1 fix: also resolve on close so
    // the await below cannot hang waiting for an error that never comes on a
    // clean exit. The "error" handler still wins if it ever fires.
    const spawnErrorPromise = new Promise<void>((resolve) => {
      child.on("error", (err) => {
        spawnError = err;
        resolve();
      });
      child.once("close", () => resolve());
    });

    // Hard timeout. SIGTERM first, escalate to SIGKILL after 5s grace.
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }, 5_000).unref();
    }, this.options.timeout_ms);
    timeoutHandle.unref();

    // Optional abort signal from the caller. Bridges to SIGTERM the same
    // way the timeout does, but skips the "timeout" reason on the final
    // error.
    if (opts.signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Pipe the prompt in via stdin.
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      // EPIPE if the child died before consuming stdin. Surface as the
      // final error after the exit handler fires.
      spawnError ??= err as Error;
    }

    // Async iterator over stdout chunks. Yields text_delta events.
    const chunks: { value: string }[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      assembled += text;
      chunks.push({ value: text });
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      done = true;
      clearTimeout(timeoutHandle);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    });

    // Drain stdout chunks while the process runs; once closed, emit the
    // final done or error event.
    while (true) {
      if (chunks.length > 0) {
        const next = chunks.shift()!;
        yield { type: "text_delta", delta: next.value };
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }

    // Process is closed. Decide outcome.
    await spawnErrorPromise.catch(() => undefined); // ensure spawnError settled if it ever fires

    if (spawnError) {
      yield {
        type: "error",
        error: new Error(
          `cli-bridge (${this.options.binary}): spawn failed: ${spawnError.message}`,
        ),
      };
      return;
    }

    if (timedOut) {
      yield {
        type: "error",
        error: new Error(
          `cli-bridge (${this.options.binary}): timed out after ${this.options.timeout_ms}ms`,
        ),
      };
      return;
    }

    if (exitCode !== 0) {
      const sig = exitSignal ? ` signal=${exitSignal}` : "";
      const tail = stderrBuf.trim().slice(-2000);
      yield {
        type: "error",
        error: new Error(
          `cli-bridge (${this.options.binary}): exit code ${exitCode}${sig}` +
            (tail ? `\nstderr: ${tail}` : ""),
        ),
      };
      return;
    }

    yield { type: "done", message: assembled };
  }
}

export function isCliBridgeConfig(config: AdapterConfig): boolean {
  return config.id === "cli-bridge";
}
