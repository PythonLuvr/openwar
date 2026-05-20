// v0.10.0: slash commands.
//
// Minimal set. Power-user surface (non-devs don't need them; the chat
// conversation drives the same outcomes). Commands are dispatched by the
// session manager before user text reaches the conversation agent.

export const COMMAND_NAMES = [
  "/help",
  "/save",
  "/inspect",
  "/history",
  "/resume",
  "/abort",
  "/quit",
  // v0.12.0: PermissionBridge surface
  "/grants",
  "/revoke",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export interface ParsedCommand {
  name: CommandName;
  // Whitespace-separated args after the command name.
  args: string[];
  // True when the input started with `/`. False for plain user turns.
  isCommand: boolean;
}

// Recognized command? Returns null when the input is plain user text.
//
// Heuristic for "is this a slash command?": the input starts with `/`, the
// first token is a single word of lowercase letters (no slashes, dots,
// dashes), and either the entire input IS that token or it's followed by
// whitespace. This lets users naturally start messages with paths like
// `/index.html` or `/path/to/file` without triggering the command parser.
//
// Real slash commands look like `/help` or `/save my-name`. File paths like
// `/index.html, mid-page` or `/usr/local/bin` will NOT be treated as
// commands and route to the conversation agent as user text.
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  // Match a single-word slash command at the start. The first character
  // after `/` must be a letter; subsequent characters are letters only
  // (digits / dashes excluded since none of our commands use them today).
  const m = /^(\/[a-z]+)(?:\s+(.*))?$/i.exec(trimmed);
  if (!m) {
    // Looks like a path (e.g., `/index.html`, `/path/to/x`). Treat as text.
    return null;
  }
  const head = m[1]!.toLowerCase();
  const argStr = m[2] ?? "";
  const args = argStr.length > 0 ? argStr.split(/\s+/).filter(Boolean) : [];
  if (!isCommandName(head)) {
    // Unknown slash command (matches the single-word shape but not in our
    // set): route to /help with a sentinel arg.
    return { name: "/help", args: [`unknown: ${head}`], isCommand: true };
  }
  return { name: head as CommandName, args, isCommand: true };
}

function isCommandName(s: string): boolean {
  return (COMMAND_NAMES as readonly string[]).includes(s);
}

// Help text body, printed in response to /help or to unknown commands.
export const HELP_TEXT = `Commands:
  /help               show this help
  /save [name]        save the compiled brief to ~/.openwar/briefs/<name>.md (default: slugified first deliverable)
  /inspect            print the inspect summary for the most recent execution in this session
  /history            print the conversation so far
  /resume <chat_id>   switch to a different saved chat session (also: openwar chat --resume <id>)
  /abort              cancel any in-progress execution (polite; ends at the next phase boundary)
  /grants             list active permission grants from the current run (v0.12)
  /revoke <id>        revoke a permission grant by id; the agent will get re-prompted next time (v0.12)
  /quit               exit the session (chat log is saved automatically)

You don't need any of these. Just describe what you want and I'll handle the rest.`;

// Slugifier used by /save without an explicit name. Mirrors the convention
// the brief format already enforces on brief ids (alphanumeric / dash /
// underscore). Truncates aggressively so saved-brief filenames stay short.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "chat-brief";
}
