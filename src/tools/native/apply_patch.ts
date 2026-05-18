// apply_patch native tool. Requires filesystem_write.
// Hand-rolled unified-diff parser + applier. Atomic via tmp+rename per file.
// Rolls back the whole patch on any hunk failure.
//
// Supports:
//   - Standard unified diff format ("--- a/path", "+++ b/path", "@@ -l,c +l,c @@")
//   - Multi-file patches in a single diff
//   - Context lines (" "), additions ("+"), deletions ("-")
//   - "\\ No newline at end of file" markers
//
// Does NOT support:
//   - Binary diffs
//   - Rename/copy headers (treat as a write to the +++ path)
//   - Git extended headers beyond the standard ---/+++ pair

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { ToolDefinition, ToolCall, ToolResult, ToolExecutionContext, ToolExecutor } from "../types.js";
import { resolvePathInWorkdir, PathEscapeError } from "../../sandbox/workdir.js";
import { isAborted, cancelledResult } from "./_cancellation.js";

export const APPLY_PATCH_DEFINITION: ToolDefinition = {
  name: "apply_patch",
  description:
    "Apply a unified-diff patch to one or more files inside the workdir. Atomic per file; rolls back the entire patch if any hunk fails.",
  input_schema: {
    type: "object",
    properties: {
      diff: { type: "string", description: "Unified-diff text. May cover multiple files." },
    },
    required: ["diff"],
  },
  origin: "native",
  authorization_categories: ["filesystem_write"],
};

interface ApplyPatchArgs {
  diff: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // each prefixed with ' ', '+', '-', or '\\'
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

function parseArgs(call: ToolCall): ApplyPatchArgs | { error: string } {
  if (typeof call.arguments !== "object" || call.arguments === null) {
    return { error: "arguments must be an object" };
  }
  const a = call.arguments as Record<string, unknown>;
  if (typeof a.diff !== "string" || a.diff.length === 0) return { error: "diff must be a non-empty string" };
  return { diff: a.diff };
}

function stripPrefix(p: string): string {
  // Strip "a/" or "b/" git prefixes.
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split(/\r?\n/);
  const files: FilePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("--- ")) {
      const oldPath = stripPrefix(line.slice(4).split("\t")[0]!.trim());
      i++;
      const plusLine = lines[i];
      if (plusLine === undefined || !plusLine.startsWith("+++ ")) {
        throw new Error(`malformed diff at line ${i + 1}: expected '+++ ' after '--- '`);
      }
      const newPath = stripPrefix(plusLine.slice(4).split("\t")[0]!.trim());
      i++;
      const hunks: Hunk[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("@@")) {
        const hunkHeader = lines[i] ?? "";
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader);
        if (!m) throw new Error(`malformed hunk header at line ${i + 1}: ${hunkHeader}`);
        const hunk: Hunk = {
          oldStart: Number(m[1]),
          oldCount: m[2] === undefined ? 1 : Number(m[2]),
          newStart: Number(m[3]),
          newCount: m[4] === undefined ? 1 : Number(m[4]),
          lines: [],
        };
        i++;
        while (i < lines.length) {
          const cur = lines[i] ?? "";
          if (cur.startsWith("@@") || cur.startsWith("--- ") || cur.startsWith("diff ")) break;
          const c = cur.charAt(0);
          if (c === " " || c === "+" || c === "-" || c === "\\") {
            hunk.lines.push(cur);
          } else if (cur === "" && i === lines.length - 1) {
            // trailing newline; ignore
          } else if (cur === "") {
            // empty line in diff: treat as a context space line
            hunk.lines.push(" ");
          } else {
            // unexpected line; stop hunk
            break;
          }
          i++;
        }
        hunks.push(hunk);
      }
      files.push({ oldPath, newPath, hunks });
    } else {
      i++;
    }
  }
  if (files.length === 0) {
    throw new Error("no file patches found in diff");
  }
  return files;
}

// Apply a single hunk to the input lines. Returns the new lines or throws.
function applyHunk(input: string[], hunk: Hunk): string[] {
  // Build the expected pre-image and the post-image from the hunk.
  const preImage: string[] = [];
  const postImage: string[] = [];
  for (const ln of hunk.lines) {
    if (ln.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = ln.charAt(0);
    const text = ln.slice(1);
    if (tag === " ") {
      preImage.push(text);
      postImage.push(text);
    } else if (tag === "-") {
      preImage.push(text);
    } else if (tag === "+") {
      postImage.push(text);
    }
  }

  // Match the pre-image at oldStart (1-based) in the input.
  const start = hunk.oldStart - 1;
  for (let k = 0; k < preImage.length; k++) {
    if (input[start + k] !== preImage[k]) {
      throw new Error(
        `hunk at @@ -${hunk.oldStart} did not match. Expected at line ${start + k + 1}: "${preImage[k]}", got: "${input[start + k] ?? "<eof>"}"`,
      );
    }
  }
  return [...input.slice(0, start), ...postImage, ...input.slice(start + preImage.length)];
}

async function atomicWrite(
  path: string,
  content: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
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
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// v0.10.1: roll one file back to a captured pre-image. If pre-image is null,
// the file did not exist before the patch and we delete it. Used by the
// cancellation rollback path so a half-applied multi-file patch leaves the
// tree in its pre-call state. Best-effort: a fs error during rollback is
// surfaced in the cancellation message but does not throw.
async function rollbackFile(
  path: string,
  preImage: string | null,
): Promise<string | null> {
  try {
    if (preImage === null) {
      // File did not exist pre-patch. Remove the written file if it landed.
      try { await unlink(path); } catch { /* may not exist */ }
      return null;
    }
    await writeFile(path, preImage, "utf8");
    return null;
  } catch (err) {
    return `${path}: ${(err as Error).message}`;
  }
}

export const applyPatchExecutor: ToolExecutor = async (
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
  let files: FilePatch[];
  try {
    files = parseUnifiedDiff(parsed.diff);
  } catch (err) {
    return {
      call_id: call.id,
      success: false,
      content: (err as Error).message,
      error: { code: "PARSE_ERROR", message: (err as Error).message },
    };
  }

  // First pass: compute the new content for every file in memory. Capture
  // pre-images alongside (null when the file did not exist) so the second
  // pass can roll back on cancellation. If any hunk fails, abort without
  // writing.
  const planned: { path: string; content: string; preImage: string | null }[] = [];
  let hunksApplied = 0;
  for (const fp of files) {
    if (isAborted(ctx.signal)) return cancelledResult(call, "", start);
    let resolved: string;
    try {
      resolved = resolvePathInWorkdir(ctx.workdir, fp.newPath);
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
    let preImage: string | null = null;
    try {
      preImage = await readFile(resolved, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") preImage = null;
      else throw err;
    }
    const current = preImage ?? "";
    const inputLines = current === "" ? [] : current.split(/\r?\n/);
    // Common quirk: split on \n leaves an empty trailing element when input ends with newline.
    const hadTrailingNewline = current.endsWith("\n");
    if (hadTrailingNewline && inputLines[inputLines.length - 1] === "") inputLines.pop();
    let working = inputLines;
    for (const h of fp.hunks) {
      try {
        working = applyHunk(working, h);
        hunksApplied++;
      } catch (err) {
        return {
          call_id: call.id,
          success: false,
          content: `Patch failed at ${fp.newPath}: ${(err as Error).message}`,
          error: { code: "HUNK_FAILED", message: (err as Error).message },
        };
      }
    }
    const outContent = working.join("\n") + (hadTrailingNewline || working.length > 0 ? "\n" : "");
    planned.push({ path: resolved, content: outContent, preImage });
  }

  // Second pass: write everything. v0.10.1 rolls back on cancellation: if
  // ctx.signal fires after some files have been written, restore those
  // files from their captured pre-images so the tree is back to its
  // pre-call state. If any write fails (not cancellation), the partial
  // state is visible but per-file atomic rename prevented corrupted
  // contents.
  const written: typeof planned = [];
  for (const p of planned) {
    if (isAborted(ctx.signal)) {
      // Cancellation before this file's write. Roll back any earlier
      // writes from this run.
      const errors: string[] = [];
      for (const w of written.reverse()) {
        const e = await rollbackFile(w.path, w.preImage);
        if (e) errors.push(e);
      }
      const note = errors.length > 0
        ? `Rolled back ${written.length} file(s) with ${errors.length} rollback error(s): ${errors.join("; ")}`
        : `Rolled back ${written.length} file(s) cleanly.`;
      return cancelledResult(call, note, start);
    }
    try {
      await atomicWrite(p.path, p.content, ctx.signal);
      written.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).name === "AbortError" || isAborted(ctx.signal)) {
        const errors: string[] = [];
        for (const w of written.reverse()) {
          const e = await rollbackFile(w.path, w.preImage);
          if (e) errors.push(e);
        }
        const note = errors.length > 0
          ? `Rolled back ${written.length} file(s) with ${errors.length} rollback error(s): ${errors.join("; ")}`
          : `Rolled back ${written.length} file(s) cleanly.`;
        return cancelledResult(call, note, start);
      }
      return {
        call_id: call.id,
        success: false,
        content: `Write failed at ${p.path}: ${(err as Error).message}`,
        error: { code: "WRITE_FAILED", message: (err as Error).message },
      };
    }
  }

  return {
    call_id: call.id,
    success: true,
    content: `Applied ${hunksApplied} hunks across ${planned.length} file(s).`,
    meta: { duration_ms: Date.now() - start },
  };
};
