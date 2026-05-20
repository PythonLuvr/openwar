// SandboxContext. Carried by every tool execution. Holds the workdir,
// timeout defaults, output caps, and HTTP allowlist. Tools take this as
// an argument and cannot construct one themselves: the constructor is
// private and the factory is named with a leading underscore to mark it
// as runtime-internal.

import type { HostAllowlist } from "./host-allowlist.js";
import type { RunnerIO } from "../types.js";
import type { GrantLedger } from "../runtime/grants.js";

// v0.12.0: minimal tracer surface so native tools that need to emit
// trace events (currently just request_permission) can do so without
// importing the Tracer class (avoids src/sandbox <-> src/state import
// cycles). The runner wires this to the real Tracer.emit.
export interface SandboxTracerHook {
  emit(event: unknown): void;
}

export interface SandboxContextFields {
  // Absolute path. Every filesystem-touching tool resolves paths against this.
  workdir: string;
  // Default timeout for any tool execution. Tools may override per call.
  defaultTimeoutMs: number;
  // Hard cap on per-stream output (stdout, stderr, http body).
  defaultMaxOutputBytes: number;
  // Loaded from ~/.openwar/http-allow.json. null = unrestricted (file absent).
  httpAllowlist: HostAllowlist | null;
  // Whether shell_exec is permitted in this session. Independent of the
  // authorization check; this is a hard kill switch (--no-shell CLI flag).
  shellEnabled: boolean;
  // v0.6: brief.project, populated by the runner. Scopes per-project memory
  // reads/writes. Optional so tool tests can construct minimal contexts.
  project_slug?: string;
  // v0.6: brief_id, populated by the runner. Stamped onto memory writes for
  // provenance.
  brief_id?: string;
  // v0.11.1: per-tool-call abort signal. The runtime creates a fresh
  // AbortController for every tool dispatch and passes its signal here.
  // Native tools honor it (shell_exec SIGTERM/SIGKILL, http_fetch fetch abort,
  // apply_patch rollback, ...). Custom tool authors must thread it through
  // their own implementations to participate in cancellation. Absent in
  // bare contexts (tests that construct a minimal sandbox); tools must treat
  // an undefined signal as "no cancellation possible".
  signal?: AbortSignal;
  // v0.12.0: optional operator I/O surface. Populated by the runner so the
  // `request_permission` native tool can prompt the operator. Existing
  // tools ignore this field; custom tools that need operator interaction
  // can read it. Absent in bare contexts (tests / headless runs that
  // construct a minimal sandbox).
  io?: RunnerIO;
  // v0.12.0: optional per-session grant ledger. Populated by the runner
  // so the `request_permission` tool can register new grants and the
  // Phase 3 dispatcher can consume matching ones. Existing tools ignore.
  grantLedger?: GrantLedger;
  // v0.12.0: optional trace-event hook. The request_permission tool uses
  // this to emit permission_requested / permission_granted /
  // permission_denied events. Other tools ignore. Absent in minimal
  // sandboxes; tool falls back to the structured tool-result alone.
  tracer?: SandboxTracerHook;
}

export class SandboxContext {
  readonly workdir: string;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxOutputBytes: number;
  readonly httpAllowlist: HostAllowlist | null;
  readonly shellEnabled: boolean;
  readonly project_slug?: string;
  readonly brief_id?: string;
  readonly signal?: AbortSignal;
  readonly io?: RunnerIO;
  readonly grantLedger?: GrantLedger;
  readonly tracer?: SandboxTracerHook;

  private constructor(fields: SandboxContextFields) {
    this.workdir = fields.workdir;
    this.defaultTimeoutMs = fields.defaultTimeoutMs;
    this.defaultMaxOutputBytes = fields.defaultMaxOutputBytes;
    this.httpAllowlist = fields.httpAllowlist;
    this.shellEnabled = fields.shellEnabled;
    if (fields.project_slug) this.project_slug = fields.project_slug;
    if (fields.brief_id) this.brief_id = fields.brief_id;
    if (fields.signal) this.signal = fields.signal;
    if (fields.io) this.io = fields.io;
    if (fields.grantLedger) this.grantLedger = fields.grantLedger;
    if (fields.tracer) this.tracer = fields.tracer;
    Object.freeze(this);
  }

  // Runtime-internal factory. Not re-exported from src/index.ts. Tools that
  // call this are reaching into sandbox internals on purpose; the convention
  // is "if you find yourself importing _create, you are no longer a tool."
  static _create(fields: SandboxContextFields): SandboxContext {
    return new SandboxContext(fields);
  }

  // v0.11.1: produce a sibling context that carries the given AbortSignal.
  // Used by the runtime to attach a per-call cancellation signal without
  // mutating the frozen original. Runtime-internal; not re-exported.
  _withSignal(signal: AbortSignal): SandboxContext {
    return new SandboxContext({
      workdir: this.workdir,
      defaultTimeoutMs: this.defaultTimeoutMs,
      defaultMaxOutputBytes: this.defaultMaxOutputBytes,
      httpAllowlist: this.httpAllowlist,
      shellEnabled: this.shellEnabled,
      project_slug: this.project_slug,
      brief_id: this.brief_id,
      signal,
      ...(this.io ? { io: this.io } : {}),
      ...(this.grantLedger ? { grantLedger: this.grantLedger } : {}),
      ...(this.tracer ? { tracer: this.tracer } : {}),
    });
  }
}

// v0.11.1: shared error code for tool results that returned because the
// runtime fired ctx.signal mid-execution. Distinct from TIMEOUT (per-tool
// hard deadline) and ABORTED (subprocess-level termination signals).
export const TOOL_CANCELLED_ERROR_CODE = "CANCELLED";

// v0.11.1: shared marker text included in cancelled tool results so the
// model and the trace recognize the same shape across all native tools.
export const TOOL_CANCELLED_MESSAGE = "Tool call cancelled by operator.";
