#!/usr/bin/env node
// Fails if an em dash appears in any shipped markdown or TypeScript source.
// Excludes node_modules, dist, .openwar test fixtures, and this script itself.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const TARGETS = [".md", ".ts", ".mts", ".cts", ".mjs"];
const SKIP = new Set(["node_modules", "dist", ".git", ".openwar", "coverage"]);
// fileURLToPath handles both Windows (file:///C:/...) and unix (file:///home/...)
// URL shapes correctly; the prior manual leading-slash strip was Windows-only.
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TARGETS.some((ext) => entry.endsWith(ext))) continue;
    if (relative(ROOT, full) === SELF) continue;
    const text = readFileSync(full, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes("—")) {
        offenders.push(`${relative(ROOT, full)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
}

walk(ROOT);

if (offenders.length > 0) {
  process.stderr.write(`Em dash check FAILED. ${offenders.length} occurrence(s):\n`);
  for (const o of offenders) process.stderr.write("  " + o + "\n");
  process.exit(1);
} else {
  process.stdout.write("Em dash check passed.\n");
}
