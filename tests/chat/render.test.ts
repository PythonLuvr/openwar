// v0.10.0 phase event renderer: trace events translate to chat output;
// destructive prompts include consequence; tool-call debouncing under bursts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PhaseEventRenderer, describeTool } from "../../src/chat/render.js";
import { DESTRUCTIVE_PHRASES, phraseFor, destructivePromptText } from "../../src/chat/destructive-phrases.js";
import type { TraceEvent } from "../../src/state/trace.js";

function capture(): { write: (s: string) => void; output: () => string } {
  let buf = "";
  return { write: (s: string) => { buf += s; }, output: () => buf };
}

// -----------------------------------------------------------------------
// describeTool

test("describeTool: plain-language for known native tools", () => {
  assert.equal(describeTool("read_file"), "reading a file");
  assert.equal(describeTool("write_file"), "writing a file");
  assert.equal(describeTool("shell_exec"), "running a shell command");
});

test("describeTool: strips MCP namespace prefix", () => {
  assert.equal(describeTool("openwar:read_file"), "reading a file");
  assert.equal(describeTool("filesystem:list"), "running list");
});

test("describeTool: unknown tool falls back to generic 'running X'", () => {
  assert.equal(describeTool("some_custom_tool"), "running some_custom_tool");
});

// -----------------------------------------------------------------------
// Destructive phrases

test("DESTRUCTIVE_PHRASES: covers every subtype the runtime's destructive detector emits", () => {
  // Subtypes from src/detectors/destructive.ts RULES list.
  const required = ["filesystem_delete", "git_history_rewrite", "git_push", "deploy", "external_message", "paid_api", "package_change", "ci_modify", "process_kill"];
  for (const subtype of required) {
    assert.ok(DESTRUCTIVE_PHRASES[subtype], `missing destructive phrase for ${subtype}`);
    assert.ok(DESTRUCTIVE_PHRASES[subtype]!.intent.length > 0);
    assert.ok(DESTRUCTIVE_PHRASES[subtype]!.consequence.length > 0);
  }
});

test("phraseFor: unknown subtype falls back without crashing", () => {
  const p = phraseFor("totally_made_up");
  assert.match(p.intent, /destructive action/);
  assert.match(p.consequence, /confirm explicitly/);
});

test("destructivePromptText: includes intent + consequence + yes/no confirm", () => {
  const text = destructivePromptText("git_push");
  assert.match(text, /publish this change to your repository/);
  assert.match(text, /push your local commit to the remote/);
  assert.match(text, /Confirm\? \(yes \/ no\)/);
});

// -----------------------------------------------------------------------
// PhaseEventRenderer

test("render phase_enter execute -> 'working...'", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "phase_enter", phase: "execute", at: "t" });
  assert.match(c.output(), /working\.\.\./);
});

test("render phase_enter intake -> silent (plan presenter already showed it)", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "phase_enter", phase: "intake", at: "t" });
  assert.equal(c.output(), "");
});

test("render tool_call -> 'doing: <plain English>...'", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "tool_call", call_id: "c1", name: "read_file", args: {}, auth_decision: "allow", at: "t" });
  assert.match(c.output(), /doing: reading a file\.\.\./);
});

test("render tool_call: debounces repeats of the same tool within debounceMs", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write, debounceMs: 1000 });
  const ev: TraceEvent = { type: "tool_call", call_id: "c1", name: "read_file", args: {}, auth_decision: "allow", at: "t" };
  r.render(ev);
  r.render(ev);
  r.render(ev);
  // Only one "doing: reading a file..." line.
  const matches = c.output().match(/doing: reading a file/g) ?? [];
  assert.equal(matches.length, 1);
});

test("render tool_call: switching tools forces a new line even under debounce", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write, debounceMs: 60_000 });
  r.render({ type: "tool_call", call_id: "c1", name: "read_file", args: {}, auth_decision: "allow", at: "t" });
  r.render({ type: "tool_call", call_id: "c2", name: "write_file", args: {}, auth_decision: "allow", at: "t" });
  assert.match(c.output(), /doing: reading a file/);
  assert.match(c.output(), /doing: writing a file/);
});

test("render detector_fired destructive returns the destructive prompt for the session manager", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  const ret = r.render({
    type: "detector_fired",
    detector: "destructive",
    payload: { action: "git_push", destructive: true, authorized: false },
    at: "t",
  });
  assert.ok(ret);
  assert.equal(ret?.destructivePrompt.subtype, "git_push");
  assert.match(ret?.destructivePrompt.text ?? "", /publish this change/);
  // The text is also written to the user-facing sink.
  assert.match(c.output(), /publish this change/);
});

test("render detector_fired blocker -> 'I hit a blocker' question", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({
    type: "detector_fired",
    detector: "blocker",
    payload: { reason: "missing credentials", blocked: true },
    at: "t",
  });
  assert.match(c.output(), /I hit a blocker: missing credentials/);
  assert.match(c.output(), /try a different approach/);
});

test("render detector_fired banned_phrases / phase_marker / completion -> silent", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "detector_fired", detector: "banned_phrases", payload: { count: 1, phrases: ["x"] }, at: "t" });
  r.render({ type: "detector_fired", detector: "phase_marker", payload: { declared: ["execute"] }, at: "t" });
  r.render({ type: "detector_fired", detector: "completion", payload: { complete: true }, at: "t" });
  assert.equal(c.output(), "");
});

test("render error event surfaces with retry/stop question", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "error", error: "disk full", phase: "execute", at: "t" });
  assert.match(c.output(), /something went wrong: disk full/);
  assert.match(c.output(), /retry or stop/);
});

test("render auth_check_fired allow -> silent", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "auth_check_fired", layer: "openwar", tool: "read_file", decision: "allow", reason: "ok", at: "t" });
  assert.equal(c.output(), "");
});

test("render auth_check_fired deny surfaces the missing permission", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "auth_check_fired", layer: "openwar", tool: "shell_exec", decision: "deny", reason: "missing: shell_exec", at: "t" });
  assert.match(c.output(), /running a shell command without permission/);
});

test("render learned_* events are silent in chat surface (audit only via trace)", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "learned_profile_applied", at: "t", slug: "x", schema_version: 1, applied: { detectors: 0, phase_budgets: 0, tool_callouts: 0 } });
  r.render({ type: "learned_sensitivity_consulted", at: "t", detector: "blocker", sensitivity: "loose", fired: false });
  r.render({ type: "learned_budget_consulted", at: "t", phase: "execute", recommended: 14, active: 14, source: "learned" });
  assert.equal(c.output(), "");
});

test("render MCP lifecycle events are silent in chat surface", () => {
  const c = capture();
  const r = new PhaseEventRenderer({ write: c.write });
  r.render({ type: "mcp_server_started", transport: "stdio", tool_count: 9, at: "t" });
  r.render({ type: "settings_merge_attempted", binary: "Claude Code", settings_path: "/x", at: "t" });
  assert.equal(c.output(), "");
});
