import type { DestructiveDetection } from "../types.js";

// Detects whether a model turn announces intent to perform a destructive or
// out-of-directive action. The framework's hard rule is: such actions must be
// approved explicitly per session. We look for stated intent, not for fully-
// realized commands (the agent should be ASKING, not doing).
//
// Authorization is satisfied when the brief's authorized_costs list contains
// a token that matches the detected category (or "*" / "all").

interface Rule {
  // Verbs of intent: "I'll", "I am going to", "Next I'll", "I will".
  // Combined with the action pattern.
  category: string;
  action: RegExp;
  // Authorization tokens that pre-approve this category, in addition to "*".
  authorizes: string[];
}

const INTENT = /\b(?:i(?:'ll| will| am going to|'m going to| plan to)|next,?\s+i(?:'ll| will)|let me)\b/i;

const RULES: Rule[] = [
  {
    category: "filesystem_delete",
    action: /\b(?:rm\s+-rf|delete|remove|wipe|purge)\b[^.\n]{0,80}\b(?:file|folder|directory|repo|repository|database|table|branch|tag|commit|history|all)\b/i,
    authorizes: ["filesystem_delete", "delete", "destructive_fs"],
  },
  {
    category: "git_history_rewrite",
    action: /\b(?:force[\s\-]?push|rebase\s+(?:--root|onto)|git\s+reset\s+--hard|amend\s+(?:published|pushed)|filter[\s\-]?repo|filter[\s\-]?branch)\b/i,
    authorizes: ["git_history_rewrite", "git", "destructive_git"],
  },
  {
    category: "git_push",
    action: /\bgit\s+push\b/i,
    authorizes: ["git_push", "push", "publish"],
  },
  {
    category: "deploy",
    action: /\b(?:deploy(?:\s+to)?\s+(?:prod|production|staging|live)|kubectl\s+apply|helm\s+(?:install|upgrade)|terraform\s+apply|vercel\s+deploy|wrangler\s+deploy)\b/i,
    authorizes: ["deploy", "deploy_prod", "infra"],
  },
  {
    category: "external_message",
    action: /\b(?:send|post|comment|publish|tweet|dm)\b[^.\n]{0,80}\b(?:slack|discord|email|tweet|x|linkedin|threads|bluesky|sms|whatsapp|telegram|pr|issue)\b/i,
    authorizes: ["external_message", "messaging", "comms"],
  },
  {
    category: "paid_api",
    action: /\b(?:call|invoke|hit|generate|render|charge|spend|burn)\b[^.\n]{0,80}\b(?:gpt|claude|gemini|openai|anthropic|kling|higgsfield|elevenlabs|fal|replicate|stripe|api)\b/i,
    authorizes: ["paid_api", "api_calls", "generation_credits", "tokens"],
  },
  {
    category: "package_change",
    action: /\b(?:downgrade|uninstall|remove)\b[^.\n]{0,80}\b(?:dependency|package|library)\b/i,
    authorizes: ["package_change", "deps"],
  },
  {
    category: "ci_modify",
    action: /\b(?:modify|change|edit|disable|skip)\b[^.\n]{0,80}\b(?:ci|cd|github\s+actions|workflow|pipeline)\b/i,
    authorizes: ["ci_modify", "infra"],
  },
  {
    category: "process_kill",
    action: /\b(?:kill|terminate|stop)\b[^.\n]{0,80}\b(?:process|server|container|pm2|service|daemon)\b/i,
    authorizes: ["process_kill"],
  },
];

const WILDCARD_TOKENS = new Set(["*", "all", "any", "everything"]);

export function detectDestructive(
  output: string,
  authorized_costs: string[] = [],
): DestructiveDetection {
  const authSet = new Set(authorized_costs.map((s) => s.toLowerCase()));
  const hasWildcard = [...authSet].some((t) => WILDCARD_TOKENS.has(t));

  // Walk each sentence and look for intent + action co-occurrence.
  const sentences = splitSentences(output);
  for (const sentence of sentences) {
    if (isInCodeFenceOfFull(output, sentence)) continue;
    if (!INTENT.test(sentence)) continue;
    if (hasNegation(sentence)) continue;
    for (const rule of RULES) {
      if (rule.action.test(sentence)) {
        const authorized =
          hasWildcard || rule.authorizes.some((tok) => authSet.has(tok.toLowerCase()));
        return {
          destructive: true,
          action: rule.category,
          authorized,
          matched_pattern: rule.action.source,
        };
      }
    }
  }

  return { destructive: false, action: null, authorized: false };
}

const NEGATION = /\b(?:not|won't|will not|don't|do not|cannot|can't|never|no longer|instead of|avoid|refuse to|won['’]t)\b/i;

function hasNegation(sentence: string): boolean {
  return NEGATION.test(sentence);
}

function splitSentences(text: string): string[] {
  // Conservative split: line breaks and sentence-terminal punctuation.
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isInCodeFenceOfFull(full: string, fragment: string): boolean {
  const idx = full.indexOf(fragment);
  if (idx === -1) return false;
  const before = full.slice(0, idx);
  const fences = before.match(/```/g);
  return !!fences && fences.length % 2 === 1;
}
