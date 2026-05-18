// v0.10.0: phase event renderer.
//
// Translates runtime trace events into chat output the user sees. Mechanical
// translation; one function per event type. Tool-call debouncing applied to
// avoid spamming the user when the runtime fires several tool calls per
// second.
//
// The renderer is stateful in one narrow way: it tracks the last "doing X..."
// line it printed, so a burst of tool calls within DEBOUNCE_MS shows a
// single working indicator instead of one line per call.

import type { TraceEvent } from "../state/trace.js";
import type { Phase } from "../types.js";
import { destructivePromptText } from "./destructive-phrases.js";

export interface RenderOptions {
  // Sink for chat output. Production wires this to the readline session;
  // tests use a string buffer.
  write: (line: string) => void;
  // Optional debounce window. Defaults to 800ms.
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 800;

export class PhaseEventRenderer {
  private readonly write: (line: string) => void;
  private readonly debounceMs: number;
  private lastToolCallAt = 0;
  private lastToolCallShown = "";

  constructor(opts: RenderOptions) {
    this.write = opts.write;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  // Returns a string if a destructive prompt fires (the session manager
  // needs to block on user input). Otherwise returns null and writes to
  // the sink directly.
  render(ev: TraceEvent): { destructivePrompt: { subtype: string; text: string } } | null {
    switch (ev.type) {
      case "phase_enter":
        return this.renderPhaseEnter(ev.phase);
      case "phase_exit":
        // Silent; phase_enter on the next phase tells the story.
        return null;
      case "tool_call":
        this.renderToolCall(ev);
        return null;
      case "tool_result":
        if (!ev.success) this.write(`  (tool ${ev.call_id} failed)\n`);
        return null;
      case "auth_check_fired":
        if (ev.decision === "deny") {
          this.write(`  I can't ${describeTool(ev.tool)} without permission: ${ev.reason}\n`);
        }
        return null;
      case "detector_fired":
        return this.renderDetector(ev);
      case "error":
        this.write(`something went wrong: ${ev.error}. Want me to retry or stop?\n`);
        return null;
      // v0.9.1 learned-profile events are silent here; the plan presenter
      // already showed the operator-facing summary at session start.
      case "learned_profile_applied":
      case "learned_sensitivity_consulted":
      case "learned_budget_consulted":
        return null;
      // Everything else (mcp lifecycle, settings merge, role_invoke, etc.)
      // is silent in the chat surface. The trace file captures it for audit.
      default:
        return null;
    }
  }

  private renderPhaseEnter(phase: Phase): null {
    switch (phase) {
      case "intake":
        // Silent. Plan presenter already showed the user what's about to happen.
        return null;
      case "execute":
        this.write("working...\n");
        return null;
      case "blocker":
        // Detector_fired blocker will fire alongside; render there.
        return null;
      case "destructive":
        // Same; detector_fired destructive carries the subtype.
        return null;
      case "completion":
        this.write("\n");
        return null;
      case "done":
        // The summarize_result intent renders the actual summary text.
        return null;
    }
    return null;
  }

  private renderToolCall(ev: Extract<TraceEvent, { type: "tool_call" }>): void {
    const now = Date.now();
    const desc = describeTool(ev.name);
    // Debounce: if we just printed a "doing X..." line in the same desc,
    // skip. If a different tool, print regardless (the user wants to see
    // the change).
    if (now - this.lastToolCallAt < this.debounceMs && desc === this.lastToolCallShown) return;
    this.write(`  doing: ${desc}...\n`);
    this.lastToolCallAt = now;
    this.lastToolCallShown = desc;
  }

  private renderDetector(ev: Extract<TraceEvent, { type: "detector_fired" }>): { destructivePrompt: { subtype: string; text: string } } | null {
    switch (ev.detector) {
      case "blocker": {
        const reason = (ev.payload && typeof ev.payload === "object" && "reason" in ev.payload
          ? String((ev.payload as { reason?: unknown }).reason ?? "unspecified")
          : "unspecified");
        this.write(`I hit a blocker: ${reason}. Want me to try a different approach?\n`);
        return null;
      }
      case "destructive": {
        const subtype = (ev.payload && typeof ev.payload === "object" && "action" in ev.payload
          ? String((ev.payload as { action?: unknown }).action ?? "unknown")
          : "unknown");
        const text = destructivePromptText(subtype);
        this.write(`${text}\n`);
        return { destructivePrompt: { subtype, text } };
      }
      case "banned_phrases":
      case "phase_marker":
      case "confirmation":
      case "completion":
        // These don't surface in the chat layer. The summarize_result intent
        // handles completion-side communication.
        return null;
      default:
        return null;
    }
  }
}

// Plain-language tool descriptions. Centralized so the chat layer never
// leaks internal tool names like `read_file` or `apply_patch` to the user.
const TOOL_DESCRIPTIONS: Record<string, string> = {
  read_file: "reading a file",
  write_file: "writing a file",
  list_dir: "listing files",
  shell_exec: "running a shell command",
  http_fetch: "fetching from the web",
  apply_patch: "applying a patch",
  read_project_memory: "reading project memory",
  write_project_memory: "writing to project memory",
  list_project_memory: "listing project memory",
};

export function describeTool(name: string): string {
  // Strip MCP namespace prefix if present so the user sees "reading a file"
  // not "openwar:reading a file".
  const bareName = name.includes(":") ? name.split(":").slice(-1)[0]! : name;
  return TOOL_DESCRIPTIONS[bareName] ?? `running ${bareName}`;
}
