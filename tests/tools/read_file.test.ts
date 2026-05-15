import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readFileExecutor, READ_FILE_DEFINITION } from "../../src/tools/native/read_file.js";
import { freshWorkdir, cleanupWorkdir, makeCtx, makeCall } from "./helpers.js";

test("read_file definition: filesystem_read only", () => {
  assert.deepEqual(READ_FILE_DEFINITION.authorization_categories, ["filesystem_read"]);
  assert.equal(READ_FILE_DEFINITION.origin, "native");
});

test("read_file reads UTF-8 content", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "ok.txt"), "hello world");
    const r = await readFileExecutor(makeCall("read_file", { path: "ok.txt" }), makeCtx(wd));
    assert.equal(r.success, true);
    assert.equal(r.content, "hello world");
    assert.equal(r.meta?.truncated, false);
  } finally { await cleanupWorkdir(wd); }
});

test("read_file truncates at max_bytes", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "big.txt"), "abcdefghij");
    const r = await readFileExecutor(makeCall("read_file", { path: "big.txt", max_bytes: 4 }), makeCtx(wd));
    assert.equal(r.success, true);
    assert.equal(r.content, "abcd");
    assert.equal(r.meta?.truncated, true);
  } finally { await cleanupWorkdir(wd); }
});

test("read_file rejects path escape", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await readFileExecutor(makeCall("read_file", { path: "../etc/passwd" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PATH_ESCAPE");
  } finally { await cleanupWorkdir(wd); }
});

test("read_file rejects null bytes", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await readFileExecutor(makeCall("read_file", { path: "ok\0.txt" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PATH_ESCAPE");
  } finally { await cleanupWorkdir(wd); }
});

test("read_file returns ENOENT for missing file", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await readFileExecutor(makeCall("read_file", { path: "missing.txt" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "ENOENT");
  } finally { await cleanupWorkdir(wd); }
});

test("read_file rejects directories with EISDIR", async () => {
  const wd = await freshWorkdir();
  try {
    await mkdir(join(wd, "sub"));
    const r = await readFileExecutor(makeCall("read_file", { path: "sub" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "EISDIR");
  } finally { await cleanupWorkdir(wd); }
});

test("read_file rejects invalid args", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await readFileExecutor(makeCall("read_file", { wrongField: 1 }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});

test("read_file rejects negative max_bytes", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await readFileExecutor(makeCall("read_file", { path: "x", max_bytes: -1 }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});

test("read_file handles non-object arguments", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await readFileExecutor(makeCall("read_file", null), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});
