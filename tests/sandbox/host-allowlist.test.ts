import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAllowlist,
  isHostAllowed,
  loadHostAllowlist,
  HostAllowlistError,
} from "../../src/sandbox/host-allowlist.js";

test("null allowlist permits any host", () => {
  assert.equal(isHostAllowed(null, "example.com"), true);
  assert.equal(isHostAllowed(null, "anything.else"), true);
});

test("exact host match is allowed, others denied", () => {
  const al = buildAllowlist(["example.com"]);
  assert.equal(isHostAllowed(al, "example.com"), true);
  assert.equal(isHostAllowed(al, "evil.com"), false);
});

test("exact match is case-insensitive on host and entry", () => {
  const al = buildAllowlist(["Example.COM"]);
  assert.equal(isHostAllowed(al, "EXAMPLE.com"), true);
  assert.equal(isHostAllowed(al, "example.com"), true);
});

test("wildcard *.domain.com matches subdomains", () => {
  const al = buildAllowlist(["*.example.com"]);
  assert.equal(isHostAllowed(al, "api.example.com"), true);
  assert.equal(isHostAllowed(al, "a.b.example.com"), true);
});

test("wildcard *.domain.com also matches the base domain", () => {
  const al = buildAllowlist(["*.example.com"]);
  assert.equal(isHostAllowed(al, "example.com"), true);
});

test("wildcard does not match unrelated suffixes", () => {
  const al = buildAllowlist(["*.example.com"]);
  assert.equal(isHostAllowed(al, "fakeexample.com"), false);
  assert.equal(isHostAllowed(al, "example.com.evil.com"), false);
});

test("empty entries are skipped, not errored", () => {
  const al = buildAllowlist(["", "example.com", "   "]);
  assert.equal(isHostAllowed(al, "example.com"), true);
});

test("buildAllowlist rejects non-string entries", () => {
  assert.throws(() => buildAllowlist([42]), HostAllowlistError);
  assert.throws(() => buildAllowlist([null]), HostAllowlistError);
  assert.throws(() => buildAllowlist([{}]), HostAllowlistError);
});

test("buildAllowlist rejects wildcard with empty base", () => {
  assert.throws(() => buildAllowlist(["*."]), HostAllowlistError);
});

test("loadHostAllowlist returns null when file is missing", async () => {
  const got = await loadHostAllowlist(join(tmpdir(), "openwar-nonexistent-" + Date.now()));
  assert.equal(got, null);
});

test("loadHostAllowlist parses a real file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-allowlist-"));
  try {
    const path = join(dir, "allow.json");
    await writeFile(path, JSON.stringify(["example.com", "*.api.dev"]));
    const al = await loadHostAllowlist(path);
    assert.ok(al);
    assert.equal(isHostAllowed(al, "example.com"), true);
    assert.equal(isHostAllowed(al, "v1.api.dev"), true);
    assert.equal(isHostAllowed(al, "evil.com"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadHostAllowlist throws HostAllowlistError on malformed JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-allowlist-"));
  try {
    const path = join(dir, "allow.json");
    await writeFile(path, "not json {");
    await assert.rejects(() => loadHostAllowlist(path), HostAllowlistError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadHostAllowlist throws HostAllowlistError when root is not an array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwar-allowlist-"));
  try {
    const path = join(dir, "allow.json");
    await writeFile(path, JSON.stringify({ hosts: ["x"] }));
    await assert.rejects(() => loadHostAllowlist(path), HostAllowlistError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
