#!/usr/bin/env node
// Mock CLI fixture for the cli-bridge adapter tests. Reads a prompt from
// stdin and emits configurable output. Behavior controlled via env vars:
//
//   MOCK_CLI_OUTPUT       - string to emit on stdout (default: "ok")
//   MOCK_CLI_OUTPUT_CHUNKS - 1 to emit char-by-char (forces multiple deltas)
//   MOCK_CLI_STDERR       - string to emit on stderr (default: "")
//   MOCK_CLI_SLEEP_MS     - sleep before emitting output (default: 0)
//   MOCK_CLI_EXIT_CODE    - process exit code (default: 0)
//   MOCK_CLI_ECHO_STDIN   - 1 to mirror stdin content in stdout (default: 0)
//   MOCK_CLI_ECHO_ARGS    - 1 to print argv on stderr before normal output
//
// Tests use this so they don't need Claude Code, Gemini CLI, etc installed.

import { setTimeout as sleep } from "node:timers/promises";

const env = process.env;
const output = env.MOCK_CLI_OUTPUT ?? "ok";
const chunks = env.MOCK_CLI_OUTPUT_CHUNKS === "1";
const stderr = env.MOCK_CLI_STDERR ?? "";
const sleepMs = Number(env.MOCK_CLI_SLEEP_MS ?? "0");
const exitCode = Number(env.MOCK_CLI_EXIT_CODE ?? "0");
const echoStdin = env.MOCK_CLI_ECHO_STDIN === "1";
const echoArgs = env.MOCK_CLI_ECHO_ARGS === "1";

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

if (echoArgs) process.stderr.write(`argv=${JSON.stringify(process.argv.slice(2))}\n`);
if (sleepMs > 0) await sleep(sleepMs);
if (stderr) process.stderr.write(stderr);

const final = echoStdin ? `${output}\n--stdin--\n${stdin}` : output;
if (chunks) {
  for (const ch of final) {
    process.stdout.write(ch);
    await sleep(1);
  }
} else {
  process.stdout.write(final);
}

process.exit(exitCode);
