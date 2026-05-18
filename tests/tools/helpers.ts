// Shared test helpers for native-tool tests.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SandboxContext } from "../../src/sandbox/types.js";
import type { ToolCall } from "../../src/tools/types.js";

export async function freshWorkdir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "openwar-tool-test-"));
}

export async function cleanupWorkdir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function makeCtx(workdir: string, overrides: Partial<{
  defaultTimeoutMs: number;
  defaultMaxOutputBytes: number;
  shellEnabled: boolean;
  signal: AbortSignal;
}> = {}): SandboxContext {
  return SandboxContext._create({
    workdir,
    defaultTimeoutMs: overrides.defaultTimeoutMs ?? 5000,
    defaultMaxOutputBytes: overrides.defaultMaxOutputBytes ?? 1_000_000,
    httpAllowlist: null,
    shellEnabled: overrides.shellEnabled ?? true,
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  });
}

export function makeCall(name: string, args: unknown): ToolCall {
  return { id: `call_${randomUUID()}`, name, arguments: args };
}
