// v0.10.0 brief compiler.
//
// Headline test: the conservative authorized_costs invariant. The compiler
// NEVER auto-grants destructive categories. Each destructive category gets
// an adversarial test that fails loud if anyone expands the auto-grant set.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileBriefFromChat,
  DESTRUCTIVE_NEVER_AUTOGRANT,
  SAFE_AUTOGRANT,
  renderRawBriefMarkdown,
  type ConversationBuffer,
} from "../../src/chat/compile.js";
import { parseBrief } from "../../src/brief.js";
import type { ProposePlanIntent } from "../../src/chat/intent.js";

const EMPTY_BUFFER: ConversationBuffer = { turns: [] };

function basicProposal(actions: Array<[string, string]>): ProposePlanIntent {
  return {
    intent: "propose_plan",
    plan_text: "Do the thing.",
    draft_brief: {
      deliverables: ["one deliverable"],
      intended_actions: actions.map(([description, category]) => ({ description, category })),
    },
  };
}

function basicOpts(overrides: Partial<Parameters<typeof compileBriefFromChat>[2]> = {}) {
  return {
    projectSlug: "demo",
    briefId: "2026-05-18-c1",
    workdir: "/work",
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// HEADLINE: Conservative authorized_costs invariant.

test("INVARIANT: destructive categories NEVER auto-grant (each category individually)", () => {
  const destructives = ["filesystem_delete", "shell_exec", "http_fetch", "paid_api_call", "git_write", "git_push", "deploy", "external_message"];
  for (const cat of destructives) {
    const proposal = basicProposal([["destructive action", cat]]);
    const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
    assert.ok(r.ok, `compile must succeed for category ${cat}`);
    if (!r.ok) continue;
    // Must NOT appear in authorized_costs.
    assert.equal(
      r.brief.frontmatter.authorized_costs.includes(cat),
      false,
      `INVARIANT VIOLATED: ${cat} was auto-granted; this is a P0 regression`,
    );
    // Must appear in refused_categories so the plan presenter surfaces it.
    assert.equal(r.refused_categories.includes(cat), true, `${cat} should be in refused_categories`);
  }
});

test("INVARIANT: DESTRUCTIVE_NEVER_AUTOGRANT set membership is locked", () => {
  // Pin the set so accidental shrinkage in a refactor fails CI.
  assert.equal(DESTRUCTIVE_NEVER_AUTOGRANT.size, 8);
  for (const c of ["filesystem_delete", "shell_exec", "http_fetch", "paid_api_call", "git_write", "git_push", "deploy", "external_message"]) {
    assert.equal(DESTRUCTIVE_NEVER_AUTOGRANT.has(c), true, `${c} must be in the never-autogrant set`);
  }
});

test("INVARIANT: SAFE_AUTOGRANT set is tiny on purpose", () => {
  // Only filesystem_read + filesystem_write. Expanding this is a load-bearing
  // change; if a future contributor adds a third, this test forces them to
  // confront the decision and update the test + CHANGELOG.
  assert.equal(SAFE_AUTOGRANT.size, 2);
  assert.equal(SAFE_AUTOGRANT.has("filesystem_read"), true);
  assert.equal(SAFE_AUTOGRANT.has("filesystem_write"), true);
});

test("compile: unknown category treated as destructive (safe default)", () => {
  const proposal = basicProposal([["something weird", "totally_made_up_category"]]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.brief.frontmatter.authorized_costs.includes("totally_made_up_category"), false);
  assert.equal(r.refused_categories.includes("totally_made_up_category"), true);
  // Explanation surfaces the unknown.
  assert.ok(r.explanations.some((e) => /Unknown category/.test(e)));
});

// -----------------------------------------------------------------------
// Happy path

test("compile: filesystem_read + filesystem_write granted; deliverables become objective + list", () => {
  const proposal: ProposePlanIntent = {
    intent: "propose_plan",
    plan_text: "Read index.html, add testimonials, show diff.",
    draft_brief: {
      deliverables: ["testimonials section in index.html"],
      intended_actions: [
        { description: "read files", category: "filesystem_read" },
        { description: "write files", category: "filesystem_write" },
      ],
    },
  };
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.brief.frontmatter.authorized_costs, ["filesystem_read", "filesystem_write"]);
  assert.equal(r.brief.frontmatter.scope_locked, true);
  assert.equal(r.brief.frontmatter.mode, "gated");
  assert.equal(r.brief.sections.objective, "testimonials section in index.html");
});

test("compile: mode defaults to gated (chat sessions never auto-execute past Phase 3)", () => {
  const proposal = basicProposal([["read files", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.brief.frontmatter.mode, "gated");
});

test("compile: filesystem_read always granted even without explicit action", () => {
  const proposal = basicProposal([]); // no intended actions
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.brief.frontmatter.authorized_costs.includes("filesystem_read"), true);
});

// -----------------------------------------------------------------------
// Missing fields

test("compile: empty deliverables fails with a clarifying question", () => {
  const proposal: ProposePlanIntent = {
    intent: "propose_plan",
    plan_text: "x",
    draft_brief: { deliverables: [], intended_actions: [] },
  };
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.missing.some((m) => m.field === "deliverables"));
  assert.ok(r.questions.some((q) => /produce/.test(q)));
});

test("compile: missing projectSlug fails with a question pointing at --project flag", () => {
  const proposal = basicProposal([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts({ projectSlug: "" }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.questions.some((q) => /--project/.test(q)));
});

// -----------------------------------------------------------------------
// Determinism

test("compile: deterministic - same buffer + proposal + options produces equal briefs", () => {
  const proposal = basicProposal([
    ["read files", "filesystem_read"],
    ["write files", "filesystem_write"],
    ["git push", "git_push"],
  ]);
  const opts = basicOpts();
  const a = compileBriefFromChat(EMPTY_BUFFER, proposal, opts);
  const b = compileBriefFromChat(EMPTY_BUFFER, proposal, opts);
  assert.deepEqual(a, b);
});

test("compile: authorized_costs are sorted (determinism)", () => {
  const proposal = basicProposal([
    ["write", "filesystem_write"],
    ["read", "filesystem_read"],
  ]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.brief.frontmatter.authorized_costs, ["filesystem_read", "filesystem_write"]);
});

// -----------------------------------------------------------------------
// Round-trip: rendered raw markdown must parse via openwar's existing brief
// parser. This is the saved-brief artifact invariant.

test("compile output: raw markdown round-trips through parseBrief", () => {
  const buffer: ConversationBuffer = {
    turns: [
      { role: "user", at: "t1", content: "add testimonials below features" },
      { role: "agent", at: "t2", content: "got it. here's the plan..." },
    ],
  };
  const proposal: ProposePlanIntent = {
    intent: "propose_plan",
    plan_text: "p",
    draft_brief: {
      deliverables: ["testimonials added"],
      constraints: ["match tailwind styling"],
      intended_actions: [
        { description: "read files", category: "filesystem_read" },
        { description: "write files", category: "filesystem_write" },
      ],
    },
  };
  const r = compileBriefFromChat(buffer, proposal, basicOpts({ chatId: "chat-abc-1234" }));
  assert.ok(r.ok);
  if (!r.ok) return;
  // Parse the rendered raw markdown.
  const reparsed = parseBrief(r.brief.raw);
  assert.equal(reparsed.frontmatter.project, "demo");
  assert.equal(reparsed.frontmatter.scope_locked, true);
  assert.equal(reparsed.frontmatter.mode, "gated");
  assert.deepEqual(reparsed.frontmatter.authorized_costs, ["filesystem_read", "filesystem_write"]);
});

test("rendered markdown: includes # Generated by openwar chat provenance when chatId provided", () => {
  const proposal = basicProposal([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts({ chatId: "chat-xyz-789" }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.brief.raw, /# Generated by openwar chat \(session: chat-xyz-789\)/);
});

test("rendered markdown: includes Source conversation section when buffer has turns", () => {
  const buffer: ConversationBuffer = {
    turns: [
      { role: "user", at: "t1", content: "do the thing" },
    ],
  };
  const proposal = basicProposal([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(buffer, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.brief.raw, /# Source conversation/);
  assert.match(r.brief.raw, /> \*\*user\*\*/);
  assert.match(r.brief.raw, /> do the thing/);
});

test("notes section includes Replay semantics disclosure", () => {
  const proposal = basicProposal([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.brief.sections.notes, /Replay semantics/);
  assert.match(r.brief.sections.notes, /If repo state has drifted/);
});

test("notes section surfaces refused categories when any are present", () => {
  const proposal = basicProposal([
    ["read", "filesystem_read"],
    ["push", "git_push"],
    ["deploy", "deploy"],
  ]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.brief.sections.notes, /Destructive actions.*Phase 3.*deploy.*git_push/);
});

// -----------------------------------------------------------------------
// Plain-render helper (covered indirectly above; this is the unit pass).

test("renderRawBriefMarkdown: produces parseable YAML frontmatter for empty buffer", () => {
  const proposal = basicProposal([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY_BUFFER, proposal, basicOpts());
  assert.ok(r.ok);
  if (!r.ok) return;
  const raw = renderRawBriefMarkdown(r.brief.frontmatter, r.brief.sections, EMPTY_BUFFER, basicOpts());
  assert.match(raw, /^---\n/);
  assert.match(raw, /\nproject: demo\n/);
  assert.match(raw, /\nauthorized_costs:\n  - filesystem_read\n/);
});
