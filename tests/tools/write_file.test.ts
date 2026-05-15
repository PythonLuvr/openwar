import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileExecutor, WRITE_FILE_DEFINITION } from "../../src/tools/native/write_file.js";
import { freshWorkdir, cleanupWorkdir, makeCtx, makeCall } from "./helpers.js";

test("write_file definition: filesystem_write", () => {
  assert.deepEqual(WRITE_FILE_DEFINITION.authorization_categories, ["filesystem_write"]);
});

test("write_file creates a new file", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await writeFileExecutor(makeCall("write_file", { path: "out.txt", content: "ok" }), makeCtx(wd));
    assert.equal(r.success, true);
    assert.equal(await readFile(join(wd, "out.txt"), "utf8"), "ok");
  } finally { await cleanupWorkdir(wd); }
});

test("write_file overwrites by default", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFileExecutor(makeCall("write_file", { path: "x.txt", content: "first" }), makeCtx(wd));
    await writeFileExecutor(makeCall("write_file", { path: "x.txt", content: "second" }), makeCtx(wd));
    assert.equal(await readFile(join(wd, "x.txt"), "utf8"), "second");
  } finally { await cleanupWorkdir(wd); }
});

test("write_file appends when append=true", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFileExecutor(makeCall("write_file", { path: "x.txt", content: "a" }), makeCtx(wd));
    await writeFileExecutor(makeCall("write_file", { path: "x.txt", content: "b", append: true }), makeCtx(wd));
    assert.equal(await readFile(join(wd, "x.txt"), "utf8"), "ab");
  } finally { await cleanupWorkdir(wd); }
});

test("write_file creates parent directories", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await writeFileExecutor(makeCall("write_file", { path: "a/b/c.txt", content: "deep" }), makeCtx(wd));
    assert.equal(r.success, true);
    const st = await stat(join(wd, "a", "b"));
    assert.equal(st.isDirectory(), true);
    assert.equal(await readFile(join(wd, "a", "b", "c.txt"), "utf8"), "deep");
  } finally { await cleanupWorkdir(wd); }
});

test("write_file rejects path escape", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await writeFileExecutor(makeCall("write_file", { path: "../leak.txt", content: "x" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PATH_ESCAPE");
  } finally { await cleanupWorkdir(wd); }
});

test("write_file rejects non-string content", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await writeFileExecutor(makeCall("write_file", { path: "x", content: 42 }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});

test("write_file rejects non-boolean append", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await writeFileExecutor(makeCall("write_file", { path: "x", content: "y", append: "yes" }), makeCtx(wd));
    assert.equal(r.success, false);
  } finally { await cleanupWorkdir(wd); }
});
