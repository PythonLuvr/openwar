// CLI-bridge adapter (v0.11).
//
// v0.5-0.10 carried 330 lines of subprocess-spawn + Windows quirks + stdio
// plumbing inline. As of v0.11 that machinery lives in @pythonluvr/squire;
// this file is the thin wrapper that:
//
//   - serializes OpenWar's Message list into a single stdin prompt,
//   - constructs a Squire instance with the same env / cwd / timeout knobs,
//   - subscribes to Squire's event stream and translates each event into
//     OpenWar's StreamEvent contract,
//   - preserves the v0.7 `addExtraArgs` hook the MCP wiring uses to inject
//     `--mcp-config <path>` at runtime.
//
// Public behavior at OpenWar's surface is unchanged: same events, same
// error shapes, same Windows quirks (Squire owns those now).
//
// Authorization: every invocation of a cli-bridge adapter still requires
// `shell_exec` in the brief's authorized_costs. The runtime enforces this
// at the boundary; the adapter trusts that it's only constructed for an
// authorized run.

import { Squire, type SquireEvent, type SquireOptions } from "@pythonluvr/squire";
import type { AgentAdapter, SendMessageOptions, StreamEvent, AdapterConfig, Message } from "../types.js";

export type AdapterTier = "free" | "paid";

export interface CliBridgeOptions {
  binary: string;
  args?: string[];
  timeout_ms?: number;
  working_dir?: string;
  env?: Record<string, string>;
  framework_prefix?: boolean;
  tier?: AdapterTier;
}

const DEFAULT_TIMEOUT_MS = 600_000;

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

  // v0.7: runner-side hook to append args before the prompt. The MCP wiring
  // calls this to inject `--mcp-config <path>` (and future bridged-CLI
  // registry entries' args) without having to know about them at
  // AdapterConfig construction time. Appends to the existing args array;
  // never mutates earlier entries.
  addExtraArgs(args: string[]): void {
    if (args.length === 0) return;
    this.options.args = [...this.options.args, ...args];
  }

  isConfigured(): boolean {
    return typeof this.options.binary === "string" && this.options.binary.length > 0;
  }

  async *sendMessage(opts: SendMessageOptions): AsyncIterable<StreamEvent> {
    const prompt = serializeMessages(opts.system, opts.messages, this.options.framework_prefix);

    const squireOpts: SquireOptions = {
      binary: this.options.binary,
      args: [...this.options.args],
      timeoutMs: this.options.timeout_ms,
    };
    if (this.options.working_dir) squireOpts.cwd = this.options.working_dir;
    if (this.options.env) squireOpts.env = this.options.env;

    const squire = new Squire(squireOpts);

    // Buffered event queue with an async cursor. Mirrors the prior cli-bridge
    // implementation's iterator drain loop, just sourcing from Squire's
    // EventEmitter instead of raw stdout chunks.
    const queue: SquireEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let exited = false;

    const wakeNext = (): void => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    squire.on("event", (event: SquireEvent) => {
      queue.push(event);
      wakeNext();
    });
    squire.once("exit", () => {
      exited = true;
      wakeNext();
    });

    // Start the child. start() resolves when the lifecycle ends; we drain
    // events in parallel and finish when the queue is empty AND exited.
    const startPromise = squire.start(prompt, opts.signal ? { signal: opts.signal } : {});

    try {
      while (true) {
        while (queue.length > 0) {
          const e = queue.shift()!;
          const out = translateEvent(e, this.options.binary);
          if (out) yield out;
          if (out && out.type === "done") return;
          if (out && out.type === "error") return;
        }
        if (exited) break;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    } finally {
      // Make sure the start promise settles even if the consumer breaks out
      // of iteration early. Squire owns child cleanup.
      await startPromise.catch(() => undefined);
    }
  }
}

function translateEvent(event: SquireEvent, binary: string): StreamEvent | null {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", delta: event.delta };
    case "message_stop":
      return { type: "done", message: event.assembled };
    case "error": {
      // Preserve the prefix the prior cli-bridge implementation prepended so
      // error logs and tests remain grep-compatible across versions.
      let msg = event.error.message;
      if (msg.startsWith("Squire")) {
        msg = msg.replace(/^Squire\(([^)]+)\):/, "cli-bridge ($1):");
      } else if (!msg.startsWith(`cli-bridge (${binary})`)) {
        msg = `cli-bridge (${binary}): ${msg}`;
      }
      // The v0.5-v0.10 implementation prepended "spawn failed:" before raw
      // ENOENT / EACCES messages. Preserve that for the spawn reason so the
      // operator-visible wording is unchanged.
      if (event.reason === "spawn" && !/spawn failed/i.test(msg)) {
        msg = msg.replace(/^(cli-bridge \([^)]+\): )/, "$1spawn failed: ");
      }
      return { type: "error", error: new Error(msg) };
    }
    case "stdout":
    case "stderr":
    case "message_start":
      return null;
    case "tool_call":
      // v0.12.1: Squire vendor-aware adapters surface tool invocations
      // happening INSIDE the bridged CLI's own run. Translate camelCase
      // Squire fields to snake_case OpenWar fields and tag the binary.
      return {
        type: "bridged_tool_call",
        call_id: event.id,
        tool_name: event.name,
        arguments: event.input,
        binary,
      };
    case "tool_result":
      return {
        type: "bridged_tool_result",
        call_id: event.id,
        result: event.output,
        is_error: event.isError === true,
        binary,
      };
    case "thinking_delta":
      return {
        type: "bridged_thinking_delta",
        delta: event.delta,
        binary,
      };
    case "usage":
      // All four token fields are optional on the Squire side because not
      // every vendor surfaces every counter. We pass through what we get.
      return {
        type: "bridged_usage",
        binary,
        ...(typeof event.inputTokens === "number" ? { input_tokens: event.inputTokens } : {}),
        ...(typeof event.outputTokens === "number" ? { output_tokens: event.outputTokens } : {}),
        ...(typeof event.cacheReadTokens === "number" ? { cache_read_tokens: event.cacheReadTokens } : {}),
        ...(typeof event.cacheWriteTokens === "number" ? { cache_write_tokens: event.cacheWriteTokens } : {}),
      };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

export function isCliBridgeConfig(config: AdapterConfig): boolean {
  return config.id === "cli-bridge";
}
