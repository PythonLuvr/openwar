// v0.10.0: project memory + learned profile context injection.
//
// At chat session start (and on resume), the session manager can surface
// prior project context to the conversation agent so it can reference past
// decisions naturally. Two sources:
//
//   1. Project memory (~/.openwar/projects/<slug>/{decisions,knowledge,
//      constraints}.jsonl). We read the most recent entries and turn each
//      into a one-line note.
//
//   2. Learned profile (~/.openwar/projects/<slug>/learned.json). We
//      surface a one-line summary ("Learned profile loaded: N detector
//      adjustments, M phase budgets") to the conversation agent, and the
//      runtime will apply the profile at execution time when the compiled
//      brief has `learned_profile: <slug>` set.
//
// Pure read-only helpers; no side effects.

import { readMemory } from "../state/memory.js";
import { loadLearnedProfile, type LearnedProfile } from "../state/learned-profile.js";

export interface ContextForChat {
  notes: string[];
  // The loaded learned profile, when present. The session manager threads
  // this into the compiled brief's frontmatter (learned_profile: <slug>)
  // so the runtime applies it at execution time.
  learnedProfile: LearnedProfile | null;
  // Operator-readable summary for the plan presenter.
  memorySummary: string | null;
  learnedSummary: string | null;
}

export interface LoadContextOptions {
  slug: string;
  // Cap on total memory entries surfaced (across all three categories).
  // Defaults to 6 (2 per category) so the system prompt stays compact.
  memoryEntryCap?: number;
}

export async function loadContextForChat(opts: LoadContextOptions): Promise<ContextForChat> {
  const cap = opts.memoryEntryCap ?? 6;
  const perCategory = Math.max(1, Math.floor(cap / 3));
  const notes: string[] = [];
  let memorySummary: string | null = null;
  let totalMemory = 0;
  let counts: { decisions: number; knowledge: number; constraints: number } = { decisions: 0, knowledge: 0, constraints: 0 };

  try {
    const dec = await readMemory(opts.slug, { category: "decisions", limit: perCategory });
    const know = await readMemory(opts.slug, { category: "knowledge", limit: perCategory });
    const cons = await readMemory(opts.slug, { category: "constraints", limit: perCategory });
    counts = { decisions: dec.entries.length, knowledge: know.entries.length, constraints: cons.entries.length };
    totalMemory = dec.entries.length + know.entries.length + cons.entries.length;
    for (const e of dec.entries) {
      notes.push(`decision: ${(e as { summary?: string }).summary ?? "(no summary)"}`);
    }
    for (const e of cons.entries) {
      notes.push(`constraint: ${(e as { rule?: string }).rule ?? "(no rule)"}`);
    }
    for (const e of know.entries) {
      const c = (e as { content?: string }).content ?? "";
      notes.push(`knowledge: ${c.slice(0, 100).replace(/\s+/g, " ")}`);
    }
    if (totalMemory > 0) {
      memorySummary = `Project memory: ${counts.decisions} prior decision(s), ${counts.constraints} constraint(s), ${counts.knowledge} knowledge note(s).`;
    }
  } catch {
    // Memory is best-effort. A read failure shouldn't block the chat session.
  }

  let learnedProfile: LearnedProfile | null = null;
  let learnedSummary: string | null = null;
  try {
    learnedProfile = loadLearnedProfile(opts.slug);
    if (learnedProfile) {
      const detectorOverrides = Object.values(learnedProfile.detector_overrides).filter(
        (o) => o.sensitivity !== "default",
      ).length;
      const budgets = Object.keys(learnedProfile.phase_budgets).length;
      const dead = Object.values(learnedProfile.tool_usage).filter((t) => t.dead).length;
      learnedSummary = `Learned profile loaded for ${opts.slug}: ${detectorOverrides} detector adjustment(s), ${budgets} phase budget(s), ${dead} dead-tool callout(s).`;
      notes.push(learnedSummary);
    }
  } catch {
    // Learned profile load errors surface in runner-side warnings; the
    // chat layer doesn't block on them.
  }

  return { notes, learnedProfile, memorySummary, learnedSummary };
}
