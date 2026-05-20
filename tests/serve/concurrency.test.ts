// v0.13.0: openwar serve max-concurrent gate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ConcurrencyGate, rateLimitedResponse } from "../../src/serve/concurrency.js";

test("ConcurrencyGate: tryAcquire returns a release fn under capacity", () => {
  const g = new ConcurrencyGate(2);
  const r1 = g.tryAcquire();
  const r2 = g.tryAcquire();
  assert.ok(r1 && r2);
  assert.equal(g.current, 2);
});

test("ConcurrencyGate: tryAcquire returns null when at capacity", () => {
  const g = new ConcurrencyGate(1);
  g.tryAcquire();
  assert.equal(g.tryAcquire(), null);
});

test("ConcurrencyGate: release frees the slot for the next caller", () => {
  const g = new ConcurrencyGate(1);
  const r1 = g.tryAcquire()!;
  assert.equal(g.tryAcquire(), null);
  r1();
  assert.equal(g.current, 0);
  const r2 = g.tryAcquire();
  assert.ok(r2);
});

test("ConcurrencyGate: release is idempotent (double-release does not under-count)", () => {
  const g = new ConcurrencyGate(2);
  const r = g.tryAcquire()!;
  r();
  r();
  assert.equal(g.current, 0);
});

test("rateLimitedResponse: status 429, OpenAI rate_limit_error shape, openwar_max_concurrent code", () => {
  const r = rateLimitedResponse();
  assert.equal(r.status, 429);
  assert.equal(r.body.error.type, "rate_limit_error");
  assert.equal(r.body.error.code, "openwar_max_concurrent");
  assert.match(r.body.error.message, /max-concurrent/);
});
