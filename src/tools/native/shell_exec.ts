// shell_exec native tool. Requires shell_exec category.
// SIGTERM on timeout, SIGKILL after 2s if still alive. stdout/stderr capped.

import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from "../types.js";
import { resolvePathInWorkdir, PathEscapeError } from "../../sandbox/workdir.js";
import { capStream } from "../../sandbox/output-cap.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 2000;

export const SHELL_EXEC_DEFINITION: ToolDefinition = {
  name: "shell_exec",
  description:
    "Execute a shell command in the workdir. Captures stdout, stderr, exit code. Killed on timeout via SIGTERM, then SIGKILL. " +
    "Default timeout 30s, hard cap 300s. stdout and stderr capped at the session's output limit; truncated flag set when hit.",
  input_schema: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "Command to run. Passed to the configured shell." },
      cwd: { type: "string", description: "Working directory relative to workdir. Default: workdir root." },
      timeout_ms: { type: "number", description: "Override timeout. Default 30000, max 300000." },
      shell: { type: "string", description: "Override shell binary. Default: bash on unix, cmd.exe on Windows." },
    },
    required: ["cmd"],
  },
  origin: "native",
  authorization_categories: ["shell_exec"],
};

interface ShellExecArgs {
  cmd: string;
  cwd?: string;
  timeout_ms?: number;
  shell?: string;
}

function parseArgs(call: ToolCall): ShellExecArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.cmd !== "string" || a.cmd.length === 0) return { error: "cmd must be a non-empty string" };
  if (a.cwd !== undefined && typeof a.cwd !== "string") return { error: "cwd must be a string if provided" };
  if (a.timeout_ms !== undefined && (typeof a.timeout_ms !== "number" || a.timeout_ms <= 0)) {
    return { error: "timeout_ms must be a positive number if provided" };
  }
  if (a.shell !== undefined && typeof a.shell !== "string") return { error: "shell must be a string if provided" };
  return {
    cmd: a.cmd,
    cwd: a.cwd as string | undefined,
    timeout_ms: a.timeout_ms as number | undefined,
    shell: a.shell as string | undefined,
  };
}

function defaultShell(): string {
  return platform() === "win32" ? "cmd.exe" : "bash";
}

function shellArgs(shell: string, cmd: string): string[] {
  // Windows cmd uses /c; bash/sh use -c.
  if (shell.endsWith("cmd.exe") || shell === "cmd") return ["/c", cmd];
  return ["-c", cmd];
}

// Cross-platform kill. On Windows, child.kill targets only the shell process,
// not grandchildren. Use taskkill /T /F to terminate the whole tree.
function killChild(child: ChildProcess, severity: "soft" | "hard"): void {
  if (platform() === "win32" && child.pid !== undefined) {
    try {
      const args = severity === "hard" ? ["/T", "/F", "/PID", String(child.pid)] : ["/T", "/PID", String(child.pid)];
      spawn("taskkill", args, { stdio: "ignore" }).on("error", () => { /* swallow */ });
      return;
    } catch { /* fall through */ }
  }
  try {
    child.kill(severity === "hard" ? "SIGKILL" : "SIGTERM");
  } catch { /* swallow */ }
}

export const shellExecExecutor: ToolExecutor = async (
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> => {
  if (!ctx.shellEnabled) {
    return {
      call_id: call.id,
      success: false,
      content: "Shell execution is disabled for this session (--no-shell).",
      error: { code: "SHELL_DISABLED", message: "shell disabled" },
    };
  }
  const parsed = parseArgs(call);
  if ("error" in parsed) {
    return {
      call_id: call.id,
      success: false,
      content: parsed.error,
      error: { code: "INVALID_ARGS", message: parsed.error },
    };
  }
  const start = Date.now();
  const timeoutMs = Math.min(parsed.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let cwd: string;
  try {
    cwd = parsed.cwd ? resolvePathInWorkdir(ctx.workdir, parsed.cwd) : ctx.workdir;
  } catch (err) {
    if (err instanceof PathEscapeError) {
      return {
        call_id: call.id,
        success: false,
        content: err.message,
        error: { code: err.code, message: err.message },
      };
    }
    throw err;
  }

  const shell = parsed.shell ?? defaultShell();
  const args = shellArgs(shell, parsed.cmd);
  const maxOut = ctx.defaultMaxOutputBytes;

  return new Promise<ToolResult>((resolve) => {
    let child;
    try {
      child = spawn(shell, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({
        call_id: call.id,
        success: false,
        content: `Failed to spawn shell: ${(err as Error).message}`,
        error: { code: "SPAWN_FAILED", message: (err as Error).message },
      });
      return;
    }

    let killed = false;
    let killSignal: string | undefined;
    const sigtermTimer = setTimeout(() => {
      killed = true;
      killSignal = "SIGTERM";
      killChild(child, "soft");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killSignal = "SIGKILL";
          killChild(child, "hard");
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const stdoutPromise = capStream(child.stdout!, maxOut);
    const stderrPromise = capStream(child.stderr!, maxOut);

    child.on("close", async (code, signal) => {
      clearTimeout(sigtermTimer);
      const [outRes, errRes] = await Promise.all([stdoutPromise, stderrPromise]);
      const truncated = outRes.truncated || errRes.truncated;
      const exitCode = code ?? -1;
      const result = {
        stdout: outRes.content.toString("utf8"),
        stderr: errRes.content.toString("utf8"),
        exit_code: exitCode,
        signal: signal ?? killSignal,
        truncated,
      };
      const summary = killed
        ? `Killed after ${timeoutMs}ms timeout (${killSignal ?? "SIGTERM"}).`
        : `Exited with code ${exitCode}${truncated ? " (output truncated)" : ""}.`;
      resolve({
        call_id: call.id,
        success: !killed && exitCode === 0,
        content: `${summary}\n\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`,
        meta: {
          duration_ms: Date.now() - start,
          exit_code: result.exit_code,
          signal: result.signal ?? undefined,
          truncated,
          bytes: result.stdout.length + result.stderr.length,
        },
        ...(killed && { error: { code: "TIMEOUT", message: summary } }),
      });
    });

    child.on("error", (err) => {
      clearTimeout(sigtermTimer);
      resolve({
        call_id: call.id,
        success: false,
        content: `Shell error: ${err.message}`,
        error: { code: "SHELL_ERROR", message: err.message },
      });
    });
  });
};
