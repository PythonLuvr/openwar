import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { listDirExecutor, LIST_DIR_DEFINITION } from "../../src/tools/native/list_dir.js";
import { freshWorkdir, cleanupWorkdir, makeCtx, makeCall } from "./helpers.js";

test("list_dir definition: filesystem_read", () => {
  assert.deepEqual(LIST_DIR_DEFINITION.authorization_categories, ["filesystem_read"]);
});

test("list_dir lists files and dirs", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "a.txt"), "a");
    await mkdir(join(wd, "sub"));
    const r = await listDirExecutor(makeCall("list_dir", { path: "." }), makeCtx(wd));
    assert.equal(r.success, true);
    const entries = JSON.parse(r.content) as { name: string; type: string }[];
    const names = entries.map(e => e.name).sort();
    assert.ok(names.includes("a.txt"));
    assert.ok(names.includes("sub"));
  } finally { await cleanupWorkdir(wd); }
});

test("list_dir skips node_modules / .git by default", async () => {
  const wd = await freshWorkdir();
  try {
    await mkdir(join(wd, "node_modules"));
    await mkdir(join(wd, ".git"));
    await writeFile(join(wd, "ok.txt"), "x");
    const r = await listDirExecutor(makeCall("list_dir", { path: "." }), makeCtx(wd));
    const entries = JSON.parse(r.content) as { name: string }[];
    const names = entries.map(e => e.name);
    assert.ok(!names.includes("node_modules"));
    assert.ok(!names.includes(".git"));
    assert.ok(names.includes("ok.txt"));
  } finally { await cleanupWorkdir(wd); }
});

test("list_dir recurses up to depth", async () => {
  const wd = await freshWorkdir();
  try {
    await mkdir(join(wd, "sub"));
    await writeFile(join(wd, "sub", "child.txt"), "x");
    const r = await listDirExecutor(makeCall("list_dir", { path: ".", depth: 2 }), makeCtx(wd));
    const entries = JSON.parse(r.content) as { name: string }[];
    const hasChild = entries.some(e => e.name.includes("child.txt"));
    assert.ok(hasChild);
  } finally { await cleanupWorkdir(wd); }
});

test("list_dir applies glob filter", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "a.ts"), "x");
    await writeFile(join(wd, "b.js"), "x");
    const r = await listDirExecutor(makeCall("list_dir", { path: ".", glob: "*.ts" }), makeCtx(wd));
    const entries = JSON.parse(r.content) as { name: string }[];
    const names = entries.map(e => e.name);
    assert.ok(names.includes("a.ts"));
    assert.ok(!names.includes("b.js"));
  } finally { await cleanupWorkdir(wd); }
});

test("list_dir respects .openwarignore", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, ".openwarignore"), "secret\n");
    await writeFile(join(wd, "secret"), "s");
    await writeFile(join(wd, "public"), "p");
    const r = await listDirExecutor(makeCall("list_dir", { path: "." }), makeCtx(wd));
    const entries = JSON.parse(r.content) as { name: string }[];
    const names = entries.map(e => e.name);
    assert.ok(!names.includes("secret"));
    assert.ok(names.includes("public"));
  } finally { await cleanupWorkdir(wd); }
});

test("list_dir rejects path escape", async () => {
  const wd = await freshWorkdir();
  try {
    const r = await listDirExecutor(makeCall("list_dir", { path: ".." }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "PATH_ESCAPE");
  } finally { await cleanupWorkdir(wd); }
});

test("list_dir rejects when path is a file (ENOTDIR)", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "f.txt"), "x");
    const r = await listDirExecutor(makeCall("list_dir", { path: "f.txt" }), makeCtx(wd));
    assert.equal(r.success, false);
    assert.equal(r.error?.code, "ENOTDIR");
  } finally { await cleanupWorkdir(wd); }
});
