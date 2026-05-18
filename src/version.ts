// v0.8: shared runtime version lookup. The CLI has its own resolver tuned to
// the bin layout; this one is for runtime code (tracer header, dashboard,
// error banners) and walks up from the compiled dist/ to find package.json.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: string | null = null;

export function runtimeVersion(): string {
  if (cached !== null) return cached;
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@pythonluvr/openwar" || pkg.name === "openwar") {
          cached = pkg.version ?? "0.0.0";
          return cached;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fallthrough */
  }
  cached = "0.0.0";
  return cached;
}
