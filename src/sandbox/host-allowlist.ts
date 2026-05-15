// HTTP host allowlist. When ~/.openwar/http-allow.json exists, http_fetch
// rejects any host not in the list before opening a socket. When the file
// is missing, the http tool is unrestricted (default behavior).
//
// File format: a JSON array of strings. Each entry is either an exact host
// or a wildcard like "*.example.com" (matches example.com AND any subdomain).
// Comparison is case-insensitive.

import { readFile } from "node:fs/promises";

export interface HostAllowlist {
  // Exact hosts. Lowercased.
  hosts: ReadonlySet<string>;
  // Subdomain suffixes (".example.com"). Match by .endsWith().
  wildcardSuffixes: readonly string[];
  // Base hosts for "*.example.com" entries (also allow example.com itself).
  wildcardBases: ReadonlySet<string>;
}

export class HostAllowlistError extends Error {
  readonly code = "HOST_ALLOWLIST_MALFORMED" as const;
  constructor(message: string) {
    super(message);
    this.name = "HostAllowlistError";
  }
}

// Load from a JSON file. Returns null when the file does not exist.
// Throws HostAllowlistError when the file exists but is malformed; callers
// should treat that as fail-closed (deny everything).
export async function loadHostAllowlist(path: string): Promise<HostAllowlist | null> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new HostAllowlistError(`invalid JSON in ${path}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new HostAllowlistError(`${path} must contain a JSON array of host strings`);
  }
  return buildAllowlist(parsed);
}

// Construct an allowlist from an array of strings. Exposed for tests and
// for callers that load the list from somewhere other than disk.
export function buildAllowlist(entries: unknown[]): HostAllowlist {
  const hosts = new Set<string>();
  const wildcardSuffixes: string[] = [];
  const wildcardBases = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new HostAllowlistError(`non-string entry in allowlist: ${JSON.stringify(entry)}`);
    }
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("*.")) {
      const base = trimmed.slice(2);
      if (base.length === 0) {
        throw new HostAllowlistError(`wildcard entry "${entry}" has no base host`);
      }
      wildcardSuffixes.push("." + base);
      wildcardBases.add(base);
    } else {
      hosts.add(trimmed);
    }
  }
  return { hosts, wildcardSuffixes, wildcardBases };
}

// Returns true when the hostname is permitted. A null allowlist (file
// missing) is permissive by design.
export function isHostAllowed(allowlist: HostAllowlist | null, hostname: string): boolean {
  if (!allowlist) return true;
  const host = hostname.toLowerCase();
  if (allowlist.hosts.has(host)) return true;
  if (allowlist.wildcardBases.has(host)) return true;
  for (const suffix of allowlist.wildcardSuffixes) {
    if (host.endsWith(suffix)) return true;
  }
  return false;
}
