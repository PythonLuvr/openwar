#!/usr/bin/env node
// Cross-platform test discovery. Walks tests/ recursively and passes every
// *.test.ts file to node --test. Avoids shell-glob portability issues
// between bash, zsh, cmd.exe, and PowerShell.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function findTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findTests(path, out);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const tests = findTests(join(repoRoot, "tests")).sort();
if (tests.length === 0) {
  console.error("no test files found under tests/");
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const args = ["--import", "tsx", "--test", ...extraArgs, ...tests];
const child = spawn(process.execPath, args, { stdio: "inherit", cwd: repoRoot });
child.on("exit", code => process.exit(code ?? 1));
child.on("error", err => { console.error(err); process.exit(1); });
