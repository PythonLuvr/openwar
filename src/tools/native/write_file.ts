// write_file native tool. Requires filesystem_write.
// Atomic via tmp + rename for overwrite; append uses appendFile.
// Creates parent directories if missing.

import { writeFile, appendFile, rename, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from "../types.js";
import { resolvePathInWorkdir, PathEscapeError } from "../../sandbox/workdir.js";
import { isAborted, cancelledResult } from "./_cancellation.js";

export const WRITE_FILE_DEFINITION: ToolDefinition = {
  name: "write_file",
  description:
    "Write UTF-8 content to a file inside the workdir. Overwrites by default; pass append=true to append. " +
    "Atomic via tmp+rename for overwrite. Creates parent directories if missing.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workdir." },
      content: { type: "string", description: "UTF-8 content to write." },
      append: { type: "boolean", description: "Append instead of overwrite. Default false." },
    },
    required: ["path", "content"],
  },
  origin: "native",
  authorization_categories: ["filesystem_write"],
};

interface WriteFileArgs {
  path: string;
  content: string;
  append?: boolean;
}

function parseArgs(call: ToolCall): WriteFileArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.path !== "string") return { error: "path must be a string" };
  if (typeof a.content !== "string") return { error: "content must be a string" };
  if (a.append !== undefined && typeof a.append !== "boolean") {
    return { error: "append must be a boolean if provided" };
  }
  return { path: a.path, content: a.content, append: a.append as boolean | undefined };
}

async function ensureParents(path: string): Promise<boolean> {
  const parent = dirname(path);
  try {
    await stat(parent);
    return false; // already exists
  } catch {
    await mkdir(parent, { recursive: true });
    return true;
  }
}

async function atomicWrite(
  path: string,
  content: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const tmp = `${path}.openwar-tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", signal });
    if (isAborted(signal)) {
      await unlink(tmp).catch(() => {});
      const err = new Error("aborted");
      (err as NodeJS.ErrnoException).name = "AbortError";
      throw err;
    }
    await rename(tmp, path);
  } catch (err) {
    // Cleanup orphan tmp on any failure path. unlink errors are swallowed
    // (the tmp may never have been created, or perms revoked since).
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export const writeFileExecutor: ToolExecutor = async (
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolResult> => {
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
  if (isAborted(ctx.signal)) return cancelledResult(call, "", start);
  try {
    const resolved = resolvePathInWorkdir(ctx.workdir, parsed.path);
    const createdParents = await ensureParents(resolved);
    if (isAborted(ctx.signal)) return cancelledResult(call, "", start);
    if (parsed.append) {
      // @types/node 20.x omits `signal` from the appendFile options shape, but
      // Node 20+ honors it at runtime. Cast through the supported overload.
      await appendFile(resolved, parsed.content, {
        encoding: "utf8",
        signal: ctx.signal,
      } as Parameters<typeof appendFile>[2]);
    } else {
      await atomicWrite(resolved, parsed.content, ctx.signal);
    }
    const bytes = Buffer.byteLength(parsed.content, "utf8");
    return {
      call_id: call.id,
      success: true,
      content: `Wrote ${bytes} bytes to ${basename(resolved)}${createdParents ? " (created parent dirs)" : ""}.`,
      meta: { duration_ms: Date.now() - start, bytes },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).name === "AbortError" || isAborted(ctx.signal)) {
      return cancelledResult(call, "", start);
    }
    if (err instanceof PathEscapeError) {
      return {
        call_id: call.id,
        success: false,
        content: err.message,
        error: { code: err.code, message: err.message },
      };
    }
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    const message = (err as Error).message;
    return {
      call_id: call.id,
      success: false,
      content: `Failed to write ${parsed.path}: ${message}`,
      error: { code, message },
    };
  }
};
