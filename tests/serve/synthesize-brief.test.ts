// v0.13.0: synthesize-brief: build an in-memory Brief from an OpenAI
// Chat Completions request.

import { test } from "node:test";
import assert from "node:assert/strict";

import { synthesizeBrief } from "../../src/serve/synthesize-brief.js";

test("synthesizeBrief: returns brief with mode=auto and scope_locked=true", () => {
  const r = synthesizeBrief({
    request: { model: "openwar", messages: [{ role: "user", content: "hi" }] },
    authorizedCosts: ["filesystem_read"],
    upstreamModel: null,
  });
  assert.equal(r.brief.frontmatter.mode, "auto");
  assert.equal(r.brief.frontmatter.scope_locked, true);
});

test("synthesizeBrief: requestId is proxy-<uuid> shaped", () => {
  const r = synthesizeBrief({
    request: { model: "openwar", messages: [{ role: "user", content: "x" }] },
    authorizedCosts: ["filesystem_read"],
    upstreamModel: null,
  });
  assert.match(r.requestId, /^proxy-[0-9a-f-]{36}$/);
});

test("synthesizeBrief: authorizedCosts copied into frontmatter (not shared by reference)", () => {
  const costs = ["filesystem_read", "filesystem_write"];
  const r = synthesizeBrief({
    request: { model: "openwar", messages: [{ role: "user", content: "x" }] },
    authorizedCosts: costs,
    upstreamModel: null,
  });
  assert.deepEqual(r.brief.frontmatter.authorized_costs, costs);
  // Mutating the input must not affect the brief.
  costs.push("shell_exec");
  assert.deepEqual(r.brief.frontmatter.authorized_costs, ["filesystem_read", "filesystem_write"]);
});

test("synthesizeBrief: model substitution recorded when upstreamModel differs", () => {
  const r = synthesizeBrief({
    request: { model: "gpt-4", messages: [{ role: "user", content: "x" }] },
    authorizedCosts: [],
    upstreamModel: "claude-opus-4-7",
  });
  assert.equal(r.modelSubstitutedFrom, "gpt-4");
});

test("synthesizeBrief: no substitution when upstreamModel matches request model", () => {
  const r = synthesizeBrief({
    request: { model: "claude-opus-4-7", messages: [{ role: "user", content: "x" }] },
    authorizedCosts: [],
    upstreamModel: "claude-opus-4-7",
  });
  assert.equal(r.modelSubstitutedFrom, null);
});

test("synthesizeBrief: no substitution when upstreamModel is null (operator did not configure)", () => {
  const r = synthesizeBrief({
    request: { model: "anything", messages: [{ role: "user", content: "x" }] },
    authorizedCosts: [],
    upstreamModel: null,
  });
  assert.equal(r.modelSubstitutedFrom, null);
});

test("synthesizeBrief: objective extracted from first user message", () => {
  const r = synthesizeBrief({
    request: {
      model: "openwar",
      messages: [
        { role: "system", content: "you are an assistant" },
        { role: "user", content: "rewrite my login.ts" },
      ],
    },
    authorizedCosts: [],
    upstreamModel: null,
  });
  assert.match(r.brief.sections.objective, /rewrite my login\.ts/);
});

test("synthesizeBrief: long objective truncated", () => {
  const longText = "a".repeat(700);
  const r = synthesizeBrief({
    request: { model: "openwar", messages: [{ role: "user", content: longText }] },
    authorizedCosts: [],
    upstreamModel: null,
  });
  assert.ok(r.brief.sections.objective.length <= 500);
  assert.match(r.brief.sections.objective, /\.\.\.$/);
});
