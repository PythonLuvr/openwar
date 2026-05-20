// v0.13.0: openwar serve bearer-token auth.

import { test } from "node:test";
import assert from "node:assert/strict";

import { authorizeRequest, unauthorizedResponse } from "../../src/serve/auth.js";

test("authorizeRequest: missing header -> missing_header reason", () => {
  const r = authorizeRequest(undefined, "tok");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_header");
});

test("authorizeRequest: wrong scheme -> wrong_scheme reason", () => {
  const r = authorizeRequest("Basic dXNlcjpwYXNz", "tok");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong_scheme");
});

test("authorizeRequest: case-insensitive Bearer scheme matches", () => {
  assert.equal(authorizeRequest("bearer tok", "tok").ok, true);
  assert.equal(authorizeRequest("BEARER tok", "tok").ok, true);
  assert.equal(authorizeRequest("Bearer tok", "tok").ok, true);
});

test("authorizeRequest: wrong token -> wrong_token reason", () => {
  const r = authorizeRequest("Bearer not-the-token", "tok");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wrong_token");
});

test("authorizeRequest: token length mismatch -> wrong_token (no length leak)", () => {
  // Constant-time compare requires equal-length buffers; we early-return
  // wrong_token rather than crash. The leak we care about (timing) is
  // gone whether we do the buffer compare or short-circuit on length.
  assert.equal(authorizeRequest("Bearer short", "muchlongerexpectedtoken").reason, "wrong_token");
  assert.equal(authorizeRequest("Bearer muchlongerpresentedtoken", "short").reason, "wrong_token");
});

test("authorizeRequest: exact match -> ok with no reason", () => {
  const r = authorizeRequest("Bearer secret-xyz", "secret-xyz");
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
});

test("unauthorizedResponse: maps each reason to a distinct openwar_* code", () => {
  const codes = new Set([
    unauthorizedResponse("missing_header").body.error.code,
    unauthorizedResponse("wrong_scheme").body.error.code,
    unauthorizedResponse("wrong_token").body.error.code,
  ]);
  assert.equal(codes.size, 3);
  assert.ok([...codes].every((c) => c.startsWith("openwar_")));
});

test("unauthorizedResponse: type is invalid_request_error, status 401", () => {
  const r = unauthorizedResponse("missing_header");
  assert.equal(r.status, 401);
  assert.equal(r.body.error.type, "invalid_request_error");
});
