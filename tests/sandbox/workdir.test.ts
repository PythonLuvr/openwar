import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  PathEscapeError,
  resolvePathInWorkdir,
  resolveAndRealpathInWorkdir,
} from "../../src/sandbox/workdir.js";

async function freshWorkdir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "openwar-workdir-test-"));
}

test("resolvePathInWorkdir resolves a relative path inside the workdir", async () => {
  const wd = await freshWorkdir();
  try {
    const got = resolvePathInWorkdir(wd, "src/index.ts");
    assert.equal(got, resolve(wd, "src/index.ts"));
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir resolves '.' to the workdir itself", async () => {
  const wd = await freshWorkdir();
  try {
    const got = resolvePathInWorkdir(wd, ".");
    assert.equal(got, resolve(wd));
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir rejects '..' traversal", async () => {
  const wd = await freshWorkdir();
  try {
    assert.throws(() => resolvePathInWorkdir(wd, "../escape.txt"), PathEscapeError);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir rejects multi-segment '..' traversal", async () => {
  const wd = await freshWorkdir();
  try {
    assert.throws(() => resolvePathInWorkdir(wd, "src/../../etc/passwd"), PathEscapeError);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir rejects absolute paths outside the workdir", async () => {
  const wd = await freshWorkdir();
  try {
    const outside = platform() === "win32" ? "C:\\Windows\\system32" : "/etc/passwd";
    assert.throws(() => resolvePathInWorkdir(wd, outside), PathEscapeError);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir accepts absolute paths inside the workdir", async () => {
  const wd = await freshWorkdir();
  try {
    const inside = resolve(wd, "ok.txt");
    const got = resolvePathInWorkdir(wd, inside);
    assert.equal(got, inside);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir handles trailing separators", async () => {
  const wd = await freshWorkdir();
  try {
    const got = resolvePathInWorkdir(wd, "src" + sep);
    assert.equal(got, resolve(wd, "src"));
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("PathEscapeError surfaces attempted path and workdir", async () => {
  const wd = await freshWorkdir();
  try {
    try {
      resolvePathInWorkdir(wd, "../leak");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof PathEscapeError);
      assert.equal(err.attempted, "../leak");
      assert.equal(err.workdir, wd);
      assert.equal(err.code, "PATH_ESCAPE");
    }
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolveAndRealpathInWorkdir resolves an existing file inside the workdir", async () => {
  const wd = await freshWorkdir();
  try {
    await writeFile(join(wd, "ok.txt"), "hi");
    const got = await resolveAndRealpathInWorkdir(wd, "ok.txt");
    // Realpath may differ on macOS where tmpdir is symlinked. Just check the basename.
    assert.match(got, /ok\.txt$/);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolveAndRealpathInWorkdir returns candidate when file does not exist", async () => {
  const wd = await freshWorkdir();
  try {
    const got = await resolveAndRealpathInWorkdir(wd, "new-file.txt");
    assert.equal(got, resolve(wd, "new-file.txt"));
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolveAndRealpathInWorkdir rejects symlink escape", async () => {
  if (platform() === "win32") return; // symlink requires admin on most Windows setups
  const wd = await freshWorkdir();
  const outsideDir = await mkdtemp(join(tmpdir(), "openwar-outside-"));
  try {
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    await symlink(join(outsideDir, "secret.txt"), join(wd, "link"));
    await assert.rejects(
      () => resolveAndRealpathInWorkdir(wd, "link"),
      PathEscapeError,
    );
  } finally {
    await rm(wd, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("resolveAndRealpathInWorkdir accepts symlink pointing inside workdir", async () => {
  if (platform() === "win32") return;
  const wd = await freshWorkdir();
  try {
    await mkdir(join(wd, "real"));
    await writeFile(join(wd, "real", "data.txt"), "ok");
    await symlink(join(wd, "real"), join(wd, "link"));
    const got = await resolveAndRealpathInWorkdir(wd, "link/data.txt");
    assert.match(got, /data\.txt$/);
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});

test("resolvePathInWorkdir rejects null bytes in path", async () => {
  // Node throws on null bytes in path arguments; we ensure our function
  // surfaces the error (rather than masking it).
  const wd = await freshWorkdir();
  try {
    assert.throws(() => resolvePathInWorkdir(wd, "ok\0.txt"));
  } finally {
    await rm(wd, { recursive: true, force: true });
  }
});
