import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { applyPatchExecutor, APPLY_PATCH_DEFINITION, parseUnifiedDiff } from "../../src/tools/native/apply_patch.js";
import { freshWorkdir, cleanupWorkdir, makeCtx, makeCall } from "./helpers.js";

test("apply_patch definition: filesystem_write", () => {
  assert.deepEqual(APPLY_PATCH_DEFINITION.authorization_categories, ["filesystem_write"]);
});

test("parseUnifiedDiff parses a single-file diff", () => {
  const diff =
`--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 hello
-world
+earth
`;
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.oldPath, "x.txt");
  assert.equal(files[0]!.newPath, "x.txt");
  assert.equal(files[0]!.hunks.length, 1);
});

test("parseUnifiedDiff handles multi-file diff", () => {
  const diff =
`--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+A
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-b
+B
`;
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 2);
});

test("apply_patch applies a hunk to existing file", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "x.txt"), "hello\nworld\n");
    const diff =
`--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 hello
-world
+earth
`;
    const r = await applyPatchExecutor(makeCall("apply_patch", { diff }), makeCtx(wd));
    assert.equal(r.success, true);
    assert.equal(await readFile(join(wd, "x.txt"), "utf8"), "hello\nearth\n");
  } finally { await cleanupWorkdir(wd); }
});

test("apply_patch creates a new file from empty diff", async () => {
  const wd = await freshWorkdir();
  try {
    const diff =
`--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
    const r = await applyPatchExecutor(makeCall("apply_patch", { diff }), makeCtx(wd));
    assert.equal(r.success, true);
    assert.equal(await readFile(join(wd, "new.txt"), "utf8"), "hello\nworld\n");
  } finally { await cleanupWorkdir(wd); }
});

test("apply_patch rolls back when any hunk fails", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "x.txt"), "hello\nworld\n");
    await writeFile(join(wd, "y.txt"), "foo\nbar\n");
    const diff =
`--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
 hello
-world
+earth
--- a/y.txt
+++ b/y.txt
@@ -1,2 +1,2 @@
 foo
-WRONG_CONTEXT
+bar
`;
    const r = await applyPatchExecutor(makeCall("apply_patch", { diff }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "HUNK_FAILED");
    // x.txt should be unchanged because y.txt failed before any write.
    assert.equal(await readFile(join(wd, "x.txt"), "utf8"), "hello\nworld\n");
  } finally { await cleanupWorkdir(wd); }
});

test("apply_patch rejects path escape in newPath", async () => {
  const wd = await freshWorkdir();
  try {
    const diff =
`--- a/x
+++ b/../escape.txt
@@ -0,0 +1 @@
+evil
`;
    const r = await applyPatchExecutor(makeCall("apply_patch", { diff }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PATH_ESCAPE");
  } finally { await cleanupWorkdir(wd); }
});

test("apply_patch rejects malformed diff", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await applyPatchExecutor(makeCall("apply_patch", { diff: "not a diff" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PARSE_ERROR");
  } finally { await cleanupWorkdir(wd); }
});

test("apply_patch rejects empty diff", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await applyPatchExecutor(makeCall("apply_patch", { diff: "" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "INVALID_ARGS");
  } finally { await cleanupWorkdir(wd); }
});
