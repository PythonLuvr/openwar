// Workdir path resolution. Every filesystem-touching tool calls into this
// before opening, reading, writing, or listing anything. Tools never resolve
// paths themselves; they always go through resolvePathInWorkdir.
//
// Rejection rules:
//   1. Absolute paths outside the workdir.
//   2. Relative paths that resolve outside the workdir via ".." traversal.
//   3. Symlinks whose realpath escapes the workdir.

import { resolve, relative, isAbsolute, normalize, sep } from "node:path";
import { realpath } from "node:fs/promises";

export class PathEscapeError extends Error {
  readonly code = "PATH_ESCAPE" as const;
  constructor(
    public readonly attempted: string,
    public readonly workdir: string,
  ) {
    super(`path "${attempted}" escapes workdir "${workdir}"`);
    this.name = "PathEscapeError";
  }
}

// On Windows, path comparison is case-insensitive. relative() handles this
// correctly when both paths are absolute, but we double-check by examining
// whether the relative path starts with "..".
function escapesWorkdir(workdirAbs: string, resolvedAbs: string): boolean {
  const rel = relative(workdirAbs, resolvedAbs);
  if (rel === "") return false;
  if (rel.startsWith("..")) return true;
  if (isAbsolute(rel)) return true;
  // Defensive: a single "." segment can't escape, but a relative that
  // somehow contains a leading separator should be rejected.
  if (rel.startsWith(sep)) return true;
  return false;
}

// Synchronous, no filesystem access. Resolves the requested path against the
// workdir and rejects ".." traversal and absolute paths outside.
//
// Does NOT resolve symlinks; callers that need symlink protection use
// resolveAndRealpathInWorkdir.
export function resolvePathInWorkdir(workdir: string, requested: string): string {
  if (requested.indexOf("\0") !== -1) {
    throw new PathEscapeError(requested, workdir);
  }
  const workdirAbs = resolve(workdir);
  const resolved = isAbsolute(requested)
    ? normalize(requested)
    : resolve(workdirAbs, requested);
  if (escapesWorkdir(workdirAbs, resolved)) {
    throw new PathEscapeError(requested, workdir);
  }
  return resolved;
}

// Symlink-aware variant. Resolves the candidate path, then realpath's it
// (and the workdir) to defeat symlink-based escapes. Returns the realpath
// if the target exists; returns the non-realpath candidate (already inside
// the workdir) if the target does not exist yet (caller may be creating it).
export async function resolveAndRealpathInWorkdir(
  workdir: string,
  requested: string,
): Promise<string> {
  const candidate = resolvePathInWorkdir(workdir, requested);
  const workdirReal = await realpath(workdir).catch(() => resolve(workdir));
  try {
    const candidateReal = await realpath(candidate);
    if (escapesWorkdir(workdirReal, candidateReal)) {
      throw new PathEscapeError(requested, workdir);
    }
    return candidateReal;
  } catch (err) {
    if (err instanceof PathEscapeError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Target does not exist yet. The candidate already passed the
      // non-symlink check; let the caller create the file at that path.
      return candidate;
    }
    throw err;
  }
}
