// v0.10.0 plan presenter: plain-English authorization phrasing, explicit
// Not-authorized list, proceed prompt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { presentPlan, AUTH_DESCRIPTIONS } from "../../src/chat/plan.js";
import { compileBriefFromChat, type ConversationBuffer } from "../../src/chat/compile.js";
import type { ProposePlanIntent } from "../../src/chat/intent.js";

const EMPTY: ConversationBuffer = { turns: [] };
const baseOpts = { projectSlug: "demo", briefId: "2026-05-18-p1", workdir: "/work" };

function proposeWith(actions: Array<[string, string]>, plan = "Step 1.\nStep 2."): ProposePlanIntent {
  return {
    intent: "propose_plan",
    plan_text: plan,
    draft_brief: {
      deliverables: ["one thing"],
      intended_actions: actions.map(([d, c]) => ({ description: d, category: c })),
    },
  };
}

test("AUTH_DESCRIPTIONS covers every category in the static auth set", () => {
  // Each auth category MUST have a plain-language description so the plan
  // presenter never leaks technical names to users.
  const required = ["filesystem_read", "filesystem_write", "filesystem_delete", "shell_exec", "http_fetch", "paid_api_call", "git_write", "git_push", "deploy", "external_message"];
  for (const cat of required) {
    assert.ok(AUTH_DESCRIPTIONS[cat], `missing AUTH_DESCRIPTIONS entry for ${cat}`);
  }
});

test("AUTH_DESCRIPTIONS for destructive categories surface the consequence", () => {
  assert.match(AUTH_DESCRIPTIONS.git_push!, /publish|repo/);
  assert.match(AUTH_DESCRIPTIONS.deploy!, /deploy|live/);
  assert.match(AUTH_DESCRIPTIONS.external_message!, /send messages|outside this session/);
  assert.match(AUTH_DESCRIPTIONS.paid_api_call!, /costs money|paid/);
});

test("presentPlan: includes Plan / Authorized / Not authorized sections", () => {
  const proposal = proposeWith([
    ["read files", "filesystem_read"],
    ["write files", "filesystem_write"],
    ["git push", "git_push"],
  ]);
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({ brief: r.brief, proposal, refused_categories: r.refused_categories });
  assert.match(out, /^Plan:/m);
  assert.match(out, /^Authorized:/m);
  assert.match(out, /^Not authorized:/m);
  assert.match(out, /Proceed\? \(yes \/ no \/ change something\)/);
});

test("presentPlan: Authorized section uses plain-language descriptions, not category names", () => {
  const proposal = proposeWith([["read", "filesystem_read"], ["write", "filesystem_write"]]);
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({ brief: r.brief, proposal, refused_categories: r.refused_categories });
  // Plain-language strings present.
  assert.match(out, /read and write files in this directory/);
  // Raw category names NOT present in the Authorized section heading body.
  const authSection = out.split(/^Authorized:/m)[1]!.split(/^Not authorized:/m)[0]!;
  assert.equal(/filesystem_write/.test(authSection), false, "raw category name should not appear in plain-language section");
});

test("presentPlan: Not authorized lists refused categories with consequence sentences", () => {
  const proposal = proposeWith([
    ["read", "filesystem_read"],
    ["push", "git_push"],
    ["deploy", "deploy"],
  ]);
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({ brief: r.brief, proposal, refused_categories: r.refused_categories });
  assert.match(out, /publish changes to your repository/);
  assert.match(out, /deploy to a live environment/);
  // Reassuring sentence about asking later.
  assert.match(out, /I'll ask you in plain English first/);
});

test("presentPlan: empty refused list still prints the section with reassuring text", () => {
  const proposal = proposeWith([["read", "filesystem_read"], ["write", "filesystem_write"]]);
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({ brief: r.brief, proposal, refused_categories: r.refused_categories });
  assert.match(out, /everything the agent intends to do is in the authorized list/);
});

test("presentPlan: includes learned profile summary when supplied", () => {
  const proposal = proposeWith([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({
    brief: r.brief,
    proposal,
    refused_categories: r.refused_categories,
    learnedProfileSummary: "Learned profile loaded for demo: 2 detector adjustments, 1 phase budget.",
  });
  assert.match(out, /Learned profile loaded for demo/);
});

test("presentPlan: includes memory summary when supplied", () => {
  const proposal = proposeWith([["read", "filesystem_read"]]);
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({
    brief: r.brief,
    proposal,
    refused_categories: r.refused_categories,
    memorySummary: "Project memory: 3 prior decisions.",
  });
  assert.match(out, /Project memory: 3 prior decisions/);
});

test("presentPlan: surfaces explicit out-of-scope items from the draft", () => {
  const proposal: ProposePlanIntent = {
    intent: "propose_plan",
    plan_text: "do x",
    draft_brief: {
      deliverables: ["thing"],
      intended_actions: [{ description: "read", category: "filesystem_read" }],
      out_of_scope: ["touching the database", "modifying CI"],
    },
  };
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({ brief: r.brief, proposal, refused_categories: r.refused_categories });
  assert.match(out, /Explicitly out of scope:/);
  assert.match(out, /touching the database/);
  assert.match(out, /modifying CI/);
});

test("presentPlan: bulletizes plan text consistently regardless of agent formatting", () => {
  const proposal: ProposePlanIntent = {
    intent: "propose_plan",
    plan_text: "Step one\n- Step two\n* Step three",
    draft_brief: {
      deliverables: ["thing"],
      intended_actions: [{ description: "read", category: "filesystem_read" }],
    },
  };
  const r = compileBriefFromChat(EMPTY, proposal, baseOpts);
  assert.ok(r.ok);
  if (!r.ok) return;
  const out = presentPlan({ brief: r.brief, proposal, refused_categories: r.refused_categories });
  // Each non-empty plan line should start with a "- " bullet.
  const planSection = out.split("Plan:")[1]!.split("Authorized:")[0]!;
  const planLines = planSection.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const line of planLines) {
    assert.match(line, /^[-*]\s/, `expected bullet on plan line, got: ${line}`);
  }
});
