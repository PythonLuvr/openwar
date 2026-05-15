import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import type { RunnerIO } from "./types.js";

// ---------- Terminal IO ----------

// ANSI helpers. Disabled when NO_COLOR is set or stdout is not a TTY.
const enableColor = !process.env.NO_COLOR && output.isTTY;
const c = (code: string) => (s: string) => (enableColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const styles = {
  dim: c("2"),
  bold: c("1"),
  cyan: c("36"),
  yellow: c("33"),
  red: c("31"),
  green: c("32"),
  magenta: c("35"),
};

export function createTerminalIO(): RunnerIO {
  let rl: Interface | null = null;
  const getRl = () => {
    rl ??= createInterface({ input, output, terminal: output.isTTY });
    return rl;
  };

  return {
    write(text: string) {
      output.write(text);
    },
    banner(text: string) {
      const bar = "─".repeat(Math.min(72, Math.max(8, text.length + 4)));
      output.write(`\n${styles.cyan(bar)}\n${styles.bold(styles.cyan(text))}\n${styles.cyan(bar)}\n`);
    },
    warn(text: string) {
      stderr.write(`${styles.yellow("! " + text)}\n`);
    },
    async prompt(question: string) {
      const answer = await getRl().question(`${styles.magenta("> " + question + " ")}`);
      return answer.trim();
    },
    async confirm(question: string) {
      const answer = await getRl().question(`${styles.magenta("> " + question + " (y/N) ")}`);
      return /^(y|yes)$/i.test(answer.trim());
    },
  };
}

export function closeTerminalIO(io: RunnerIO): void {
  // The terminal IO owns its readline; trying to close another implementation
  // is a no-op. We detect by duck-typing.
  const maybeRl = (io as unknown as { _rl?: Interface })._rl;
  if (maybeRl) maybeRl.close();
}

// ---------- Headless IO ----------

// Drives the runner without any human in the loop. Operator inputs are
// supplied up-front. Useful for War Room and tests.
export interface ScriptedIOOptions {
  // Lines to feed each `prompt()` call in order.
  inputs?: string[];
  // Answer to each `confirm()` call in order. Missing entries default to false.
  confirmations?: boolean[];
  // Sink for `write` and `warn`. Defaults to in-memory buffers.
  onWrite?: (text: string) => void;
  onWarn?: (text: string) => void;
  onBanner?: (text: string) => void;
}

export function createScriptedIO(opts: ScriptedIOOptions = {}): RunnerIO & {
  output: string;
  warnings: string[];
  banners: string[];
} {
  const inputs = [...(opts.inputs ?? [])];
  const confirmations = [...(opts.confirmations ?? [])];
  let outBuf = "";
  const warnings: string[] = [];
  const banners: string[] = [];
  const io: RunnerIO & { output: string; warnings: string[]; banners: string[] } = {
    write(text: string) {
      outBuf += text;
      opts.onWrite?.(text);
    },
    banner(text: string) {
      banners.push(text);
      opts.onBanner?.(text);
    },
    warn(text: string) {
      warnings.push(text);
      opts.onWarn?.(text);
    },
    async prompt() {
      return inputs.shift() ?? "";
    },
    async confirm() {
      return confirmations.shift() ?? false;
    },
    get output() {
      return outBuf;
    },
    warnings,
    banners,
  };
  return io;
}
