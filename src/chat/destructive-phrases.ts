// v0.10.0: plain-language consequence templates for destructive prompts.
//
// When the runtime's destructive detector fires mid-execution, the chat
// renderer translates the technical action into a "what will happen"
// sentence that a non-developer can answer "yes" or "no" to without
// understanding the command underneath.
//
// Templates are keyed by the destructive subtype the detector identifies
// (action field on DestructiveDetection). Each entry has two pieces:
//
//   intent:      a verb-phrase describing what the agent is about to do
//   consequence: a "this means..." sentence the user needs to weigh
//
// Adding a subtype requires adding a template here. The renderer falls back
// to a generic phrasing for unknown subtypes; tests pin every shipped
// subtype so missing templates fail CI.

export interface DestructivePhrase {
  intent: string;
  consequence: string;
}

export const DESTRUCTIVE_PHRASES: Record<string, DestructivePhrase> = {
  filesystem_delete: {
    intent: "delete files",
    consequence: "That will permanently remove these files; this is hard to undo without a backup.",
  },
  git_history_rewrite: {
    intent: "rewrite git history",
    consequence: "That will alter the commit history. Anyone who pulled the old history will need to reset.",
  },
  git_push: {
    intent: "publish this change to your repository",
    consequence: "That will push your local commit to the remote. Anyone with access to the repo will see it.",
  },
  deploy: {
    intent: "deploy to a live environment",
    consequence: "That will update what users actually see when they visit the live site.",
  },
  external_message: {
    intent: "send a message outside this session",
    consequence: "That will send the message via the named channel (Slack, email, etc.). It cannot be silently recalled.",
  },
  paid_api: {
    intent: "call a paid API",
    consequence: "That will use credits or money on your account.",
  },
  package_change: {
    intent: "change project dependencies",
    consequence: "That will modify the package list other contributors rely on.",
  },
  ci_modify: {
    intent: "modify CI / CD configuration",
    consequence: "That will change how the project builds, tests, or deploys for everyone.",
  },
  process_kill: {
    intent: "stop a running process or service",
    consequence: "That will terminate the named process; anyone depending on it loses access.",
  },
};

export function phraseFor(subtype: string): DestructivePhrase {
  const known = DESTRUCTIVE_PHRASES[subtype];
  if (known) return known;
  return {
    intent: `take a destructive action (${subtype})`,
    consequence: "That action cannot be auto-authorized; please confirm explicitly.",
  };
}

// Render the prompt the renderer surfaces to the user. The chat session
// manager waits for the user's response (yes/no) and routes it back to the
// runtime's existing Phase 3 gate.
export function destructivePromptText(subtype: string): string {
  const p = phraseFor(subtype);
  return `I need to authorize a destructive action: ${p.intent}. ${p.consequence} Confirm? (yes / no)`;
}
