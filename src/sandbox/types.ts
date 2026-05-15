// SandboxContext. Carried by every tool execution. Holds the workdir,
// timeout defaults, output caps, and HTTP allowlist. Tools take this as
// an argument and cannot construct one themselves: the constructor is
// private and the factory is named with a leading underscore to mark it
// as runtime-internal.

import type { HostAllowlist } from "./host-allowlist.js";

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
}

export class SandboxContext {
  readonly workdir: string;
  readonly defaultTimeoutMs: number;
  readonly defaultMaxOutputBytes: number;
  readonly httpAllowlist: HostAllowlist | null;
  readonly shellEnabled: boolean;

  private constructor(fields: SandboxContextFields) {
    this.workdir = fields.workdir;
    this.defaultTimeoutMs = fields.defaultTimeoutMs;
    this.defaultMaxOutputBytes = fields.defaultMaxOutputBytes;
    this.httpAllowlist = fields.httpAllowlist;
    this.shellEnabled = fields.shellEnabled;
    Object.freeze(this);
  }

  // Runtime-internal factory. Not re-exported from src/index.ts. Tools that
  // call this are reaching into sandbox internals on purpose; the convention
  // is "if you find yourself importing _create, you are no longer a tool."
  static _create(fields: SandboxContextFields): SandboxContext {
    return new SandboxContext(fields);
  }
}
