import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolves the canonical openwar.md framework doc bundled with the package.
// Walks up from the compiled module location (dist/) until a file named
// openwar.md is found. The package.json's `files` entry guarantees it ships.

let cached: string | null = null;

export function loadFrameworkDoc(): string {
  if (cached !== null) return cached;
  if (process.env.OPENWAR_FRAMEWORK_PATH) {
    cached = readFileSync(process.env.OPENWAR_FRAMEWORK_PATH, "utf8");
    return cached;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // Search up to 5 parent dirs for openwar.md.
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "openwar.md");
    try {
      cached = readFileSync(candidate, "utf8");
      return cached;
    } catch {
      // Try one level up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate openwar.md. Set OPENWAR_FRAMEWORK_PATH to override, or reinstall the package.",
  );
}
