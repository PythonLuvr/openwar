// v0.7.2: bridged-CLI permission auto-setup.
//
// Even with v0.7.1 MCP forwarding wired correctly, the bridged Claude Code
// halts at its own permission gate on the first MCP tool call:
//   Claude requested permissions to use mcp__openwar__openwar_<tool>, but
//   you haven't granted it yet.
// Claude Code treats external MCP tools as separate-trust by design. Neither
// --permission-mode bypassPermissions nor --allowedTools covers them. The
// only programmatic path is to write the grants into Claude Code's user
// settings file before spawn.
//
// This module owns that write. Scope is deliberately narrow: Claude Code
// only. Gemini CLI and Codex CLI may need similar handling later (v0.7.3+);
// abstract when there's a second case, not before.

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// v0.7 native tools as Claude Code sees them, after MCP namespace mangling.
// Server name "openwar" + tool name "openwar:<tool>" becomes the canonical
// mcp__openwar__openwar_<tool> permission pattern (colon -> underscore).
// v0.7.3 added list_project_memory; total exposed tool count = 9.
export const OPENWAR_MCP_TOOL_PATTERNS: readonly string[] = [
  "mcp__openwar__openwar_read_file",
  "mcp__openwar__openwar_write_file",
  "mcp__openwar__openwar_list_dir",
  "mcp__openwar__openwar_shell_exec",
  "mcp__openwar__openwar_http_fetch",
  "mcp__openwar__openwar_apply_patch",
  "mcp__openwar__openwar_read_project_memory",
  "mcp__openwar__openwar_write_project_memory",
  "mcp__openwar__openwar_list_project_memory",
];

// Real Claude Code settings file location, verified against a Claude Code
// install on Windows: ~/.claude/settings.json. Same path on macOS and Linux
// per Claude Code's documented user-scope settings layout.
export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export interface ClaudeSettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  // Anything else the operator has in their settings is preserved verbatim;
  // we only read + write the permissions.allow subtree.
  [key: string]: unknown;
}

export class ClaudeSettingsMergeError extends Error {
  readonly code: "PARSE" | "READ" | "WRITE";
  readonly path: string;
  constructor(code: "PARSE" | "READ" | "WRITE", path: string, message: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.name = "ClaudeSettingsMergeError";
  }
}

export interface MergeResult {
  // Path the merge wrote to (absolute).
  path: string;
  // Patterns that were added vs already present. Used for the runner's
  // banner: "added N new grants" or "all already authorized".
  added: string[];
  alreadyPresent: string[];
  // True when the settings file did not exist before this call.
  createdNew: boolean;
}

// Read the existing settings file (if any), add any missing patterns from
// `patternsToAdd` to permissions.allow, write atomically. Idempotent: a
// second call with the same patterns is a no-op on disk content.
//
// Throws ClaudeSettingsMergeError with a stable code on failure:
//   READ   IO failure reading the existing file (other than ENOENT, which
//          is the create-new path and not an error).
//   PARSE  Existing file is malformed JSON. Caller halts Phase 2 rather
//          than clobbering.
//   WRITE  IO failure during atomic write.
export async function mergeClaudeSettings(
  path: string,
  patternsToAdd: readonly string[],
): Promise<MergeResult> {
  let existing: ClaudeSettingsFile;
  let createdNew = false;
  if (existsSync(path)) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new ClaudeSettingsMergeError(
        "READ", path,
        `Cannot read Claude Code settings at ${path}: ${(err as Error).message}`,
      );
    }
    try {
      existing = JSON.parse(raw) as ClaudeSettingsFile;
      if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
        throw new Error("settings root must be a JSON object");
      }
    } catch (err) {
      throw new ClaudeSettingsMergeError(
        "PARSE", path,
        `Claude Code settings at ${path} is malformed JSON; refusing to clobber: ${(err as Error).message}`,
      );
    }
  } else {
    existing = {};
    createdNew = true;
  }

  // Read or initialize the permissions.allow array. Preserve everything else.
  const perms = (existing.permissions && typeof existing.permissions === "object" && !Array.isArray(existing.permissions))
    ? existing.permissions as ClaudeSettingsFile["permissions"]
    : {};
  const current = Array.isArray(perms!.allow) ? perms!.allow : [];
  const currentSet = new Set(current);

  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const pat of patternsToAdd) {
    if (currentSet.has(pat)) {
      alreadyPresent.push(pat);
    } else {
      added.push(pat);
      currentSet.add(pat);
    }
  }

  // Reassemble. Preserve original order; new entries appended at the end so
  // the operator can see what OpenWar added at a glance.
  const newAllow = [...current];
  for (const pat of added) newAllow.push(pat);

  const merged: ClaudeSettingsFile = {
    ...existing,
    permissions: {
      ...perms,
      allow: newAllow,
    },
  };

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.openwar-tmp-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the tmp file.
    try { await (await import("node:fs/promises")).unlink(tmp); } catch { /* swallow */ }
    throw new ClaudeSettingsMergeError(
      "WRITE", path,
      `Cannot write Claude Code settings at ${path}: ${(err as Error).message}`,
    );
  }

  return { path, added, alreadyPresent, createdNew };
}
