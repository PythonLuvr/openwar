// list_dir native tool. Default-allowed (filesystem_read).
// Lists entries with optional depth and glob filter. Skips noise dirs.

import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from "../types.js";
import { resolveAndRealpathInWorkdir, PathEscapeError } from "../../sandbox/workdir.js";
import { isAborted, cancelledResult, CancelledError } from "./_cancellation.js";

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".turbo",
  ".cache",
  "build",
]);

export const LIST_DIR_DEFINITION: ToolDefinition = {
  name: "list_dir",
  description:
    "List entries in a directory inside the workdir. Optional depth (default 1) and glob filter. " +
    "Skips .git, node_modules, dist, and patterns in .openwarignore.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to workdir." },
      depth: { type: "number", description: "Recursion depth. 1 = entries only. Pass a large number for full tree. Default 1." },
      glob: { type: "string", description: "Optional simple glob (* and ?) applied to entry names." },
    },
    required: ["path"],
  },
  origin: "native",
  authorization_categories: ["filesystem_read"],
};

interface ListDirArgs {
  path: string;
  depth?: number;
  glob?: string;
}

interface Entry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

function parseArgs(call: ToolCall): ListDirArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.path !== "string") return { error: "path must be a string" };
  if (a.depth !== undefined && (typeof a.depth !== "number" || a.depth < 1)) {
    return { error: "depth must be a positive number if provided" };
  }
  if (a.glob !== undefined && typeof a.glob !== "string") {
    return { error: "glob must be a string if provided" };
  }
  return { path: a.path, depth: a.depth as number | undefined, glob: a.glob as string | undefined };
}

// Convert a simple glob (* matches any chars except separator, ? matches one) to RegExp.
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (const ch of glob) {
    if (ch === "*") re += "[^/\\\\]*";
    else if (ch === "?") re += "[^/\\\\]";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re);
}

async function loadIgnore(workdir: string): Promise<string[]> {
  try {
    const txt = await readFile(join(workdir, ".openwarignore"), "utf8");
    return txt
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith("#"));
  } catch {
    return [];
  }
}

function shouldSkip(name: string, ignore: string[]): boolean {
  if (DEFAULT_SKIP_DIRS.has(name)) return true;
  for (const pat of ignore) {
    if (pat === name) return true;
    if (pat.includes("*") || pat.includes("?")) {
      if (globToRegExp(pat).test(name)) return true;
    }
  }
  return false;
}

async function walk(
  rootAbs: string,
  currentAbs: string,
  depth: number,
  maxDepth: number,
  glob: RegExp | null,
  ignore: string[],
  out: Entry[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (isAborted(signal)) throw new CancelledError();
  let entries;
  try {
    entries = await readdir(currentAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (isAborted(signal)) throw new CancelledError();
    if (shouldSkip(e.name, ignore)) continue;
    const abs = join(currentAbs, e.name);
    const rel = relative(rootAbs, abs);
    const displayName = rel === "" ? e.name : rel;
    if (e.isDirectory()) {
      if (!glob || glob.test(e.name)) {
        out.push({ name: displayName, type: "directory" });
      }
      if (depth < maxDepth) {
        await walk(rootAbs, abs, depth + 1, maxDepth, glob, ignore, out, signal);
      }
    } else if (e.isFile()) {
      if (!glob || glob.test(e.name)) {
        try {
          const st = await stat(abs);
          out.push({ name: displayName, type: "file", size: st.size });
        } catch {
          out.push({ name: displayName, type: "file" });
        }
      }
    }
  }
}

export const listDirExecutor: ToolExecutor = async (
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
    const resolved = await resolveAndRealpathInWorkdir(ctx.workdir, parsed.path);
    const st = await stat(resolved);
    if (!st.isDirectory()) {
      return {
        call_id: call.id,
        success: false,
        content: `${parsed.path} is not a directory`,
        error: { code: "ENOTDIR", message: "path is not a directory" },
      };
    }
    const maxDepth = parsed.depth ?? 1;
    const glob = parsed.glob ? globToRegExp(parsed.glob) : null;
    const ignore = await loadIgnore(ctx.workdir);
    const out: Entry[] = [];
    await walk(resolved, resolved, 1, maxDepth, glob, ignore, out, ctx.signal);
    return {
      call_id: call.id,
      success: true,
      content: JSON.stringify(out, null, 2),
      meta: { duration_ms: Date.now() - start, bytes: out.length },
    };
  } catch (err) {
    if (err instanceof CancelledError) {
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
      content: `Failed to list ${parsed.path}: ${message}`,
      error: { code, message },
    };
  }
};
