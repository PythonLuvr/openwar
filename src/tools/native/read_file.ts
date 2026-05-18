// read_file native tool. Default-allowed (filesystem_read is in DEFAULT_ALLOWED).
// Reads UTF-8 text inside the session workdir, capped at max_bytes.

import { readFile, stat } from "node:fs/promises";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from "../types.js";
import { resolveAndRealpathInWorkdir, PathEscapeError } from "../../sandbox/workdir.js";
import { isAborted, cancelledResult } from "./_cancellation.js";

const DEFAULT_MAX_BYTES = 1_000_000;

export const READ_FILE_DEFINITION: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file. Path is relative to the session workdir (or absolute inside it). " +
    "Returns the file contents and a truncated flag when the file exceeded max_bytes.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workdir, or absolute inside workdir.",
      },
      max_bytes: {
        type: "number",
        description: "Maximum bytes to read. Defaults to 1000000 (1 MB).",
      },
    },
    required: ["path"],
  },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

interface ReadFileArgs {
  path: string;
  max_bytes?: number;
}

function parseArgs(call: ToolCall): ReadFileArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.path !== "string") return { error: "path must be a string" };
  if (a.max_bytes !== undefined && (typeof a.max_bytes !== "number" || a.max_bytes < 0)) {
    return { error: "max_bytes must be a non-negative number" };
  }
  return { path: a.path, max_bytes: a.max_bytes as number | undefined };
}

export const readFileExecutor: ToolExecutor = async (
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
  const maxBytes = parsed.max_bytes ?? DEFAULT_MAX_BYTES;
  const start = Date.now();
  if (isAborted(ctx.signal)) return cancelledResult(call, "", start);
  try {
    const resolved = await resolveAndRealpathInWorkdir(ctx.workdir, parsed.path);
    if (isAborted(ctx.signal)) return cancelledResult(call, "", start);
    const st = await stat(resolved);
    if (st.isDirectory()) {
      return {
        call_id: call.id,
        success: false,
        content: `${parsed.path} is a directory; use list_dir.`,
        error: { code: "EISDIR", message: "path is a directory" },
      };
    }
    const buf = await readFile(resolved, { signal: ctx.signal });
    const truncated = buf.length > maxBytes;
    const content = truncated ? buf.subarray(0, maxBytes).toString("utf8") : buf.toString("utf8");
    return {
      call_id: call.id,
      success: true,
      content,
      meta: { duration_ms: Date.now() - start, bytes: content.length, truncated },
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
      content: `Failed to read ${parsed.path}: ${message}`,
      error: { code, message },
    };
  }
};
