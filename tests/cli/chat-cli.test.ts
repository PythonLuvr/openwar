// v0.10.0 chat CLI entry: flag parsing, default adapter resolution,
// incompatible-adapter rejection, resume-not-found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConversationAdapter, resolveExecAdapter, inferProjectSlug, ChatStartupError, chatDefaultPaths, runChatCommand } from "../../src/cli/chat.js";

// Snapshot + restore env so we don't leak between tests.
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): T | Promise<T> {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    snapshot[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k]!;
  }
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.finally(() => {
        for (const k of Object.keys(snapshot)) {
          if (snapshot[k] === undefined) delete process.env[k];
          else process.env[k] = snapshot[k]!;
        }
      });
    }
    return r;
  } finally {
    // For sync paths only; the async path resets in the `finally` chain above.
    // (We over-restore here for the sync case; that's fine because env was
    // already snapshotted at entry.)
    for (const k of Object.keys(snapshot)) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k]!;
    }
  }
}

test("resolveConversationAdapter: hard-rejects cli-bridge with the install hint", () => {
  assert.throws(
    () => resolveConversationAdapter({ adapter: "cli-bridge" }),
    (err: unknown) => {
      assert.ok(err instanceof ChatStartupError);
      assert.equal((err as InstanceType<typeof ChatStartupError>).code, "INCOMPATIBLE_ADAPTER");
      assert.match((err as Error).message, /not compatible with 'openwar chat'/);
      assert.match((err as Error).message, /openwar run brief\.md --adapter cli-bridge/);
      return true;
    },
  );
});

test("resolveConversationAdapter: no BYOK env vars -> NO_ADAPTER with named precedence", () => {
  assert.throws(
    () => withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, XAI_API_KEY: undefined, OPENAI_COMPAT_API_KEY: undefined }, () => resolveConversationAdapter({})),
    (err: unknown) => {
      assert.ok(err instanceof ChatStartupError);
      assert.equal((err as InstanceType<typeof ChatStartupError>).code, "NO_ADAPTER");
      for (const env of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "OPENAI_COMPAT_API_KEY"]) {
        assert.match((err as Error).message, new RegExp(env));
      }
      assert.match((err as Error).message, /openwar run brief\.md --adapter cli-bridge/);
      return true;
    },
  );
});

test("resolveConversationAdapter: BYOK precedence is anthropic > openai > gemini > grok > openai-compat", () => {
  withEnv({
    ANTHROPIC_API_KEY: "x",
    OPENAI_API_KEY: "y",
    GEMINI_API_KEY: "z",
    XAI_API_KEY: "g",
    OPENAI_COMPAT_API_KEY: "h",
  }, () => {
    const choice = resolveConversationAdapter({});
    assert.equal(choice.adapter.id, "anthropic");
    assert.equal(choice.source, "env");
  });
});

test("resolveConversationAdapter: when only OPENAI_API_KEY set, picks openai", () => {
  withEnv({
    ANTHROPIC_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined,
    XAI_API_KEY: undefined, OPENAI_COMPAT_API_KEY: undefined,
    OPENAI_API_KEY: "x",
  }, () => {
    const choice = resolveConversationAdapter({});
    assert.equal(choice.adapter.id, "openai");
  });
});

test("resolveConversationAdapter: explicit --adapter wins over env", () => {
  withEnv({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }, () => {
    const choice = resolveConversationAdapter({ adapter: "openai" });
    assert.equal(choice.adapter.id, "openai");
    assert.equal(choice.source, "explicit");
  });
});

test("resolveExecAdapter: defaults to same as conversation", () => {
  withEnv({ ANTHROPIC_API_KEY: "x" }, () => {
    const conv = resolveConversationAdapter({});
    const exec = resolveExecAdapter({}, conv);
    assert.equal(exec.id, conv.adapter.id);
  });
});

test("resolveExecAdapter: --exec-adapter cli-bridge with --exec-binary lands as cli-bridge", () => {
  withEnv({ ANTHROPIC_API_KEY: "x" }, () => {
    const conv = resolveConversationAdapter({});
    const exec = resolveExecAdapter({ execAdapter: "cli-bridge", execBinary: "claude" }, conv);
    assert.equal(exec.id, "cli-bridge");
  });
});

test("inferProjectSlug: derives sanitized slug from directory basename", () => {
  assert.equal(inferProjectSlug("/some/path/my-project"), "my-project");
  assert.equal(inferProjectSlug("/some/path/My Project!"), "my-project");
  assert.equal(inferProjectSlug("/"), "default");
});

test("inferProjectSlug: trailing slashes do not produce empty slug", () => {
  // Both Windows and POSIX paths.
  assert.equal(inferProjectSlug("/some/path/proj/"), "proj");
  assert.equal(inferProjectSlug("D:\\some\\path\\repo"), "repo");
});

test("chatDefaultPaths: returns the three canonical paths under OPENWAR_HOME", () => {
  const orig = process.env.OPENWAR_HOME;
  process.env.OPENWAR_HOME = "/tmp/openwar-default-paths-test";
  try {
    const p = chatDefaultPaths();
    assert.ok(p.home.endsWith("openwar-default-paths-test"));
    assert.ok(p.chatsDir.endsWith("chats"));
    assert.ok(p.briefsDir.endsWith("briefs"));
  } finally {
    if (orig === undefined) delete process.env.OPENWAR_HOME;
    else process.env.OPENWAR_HOME = orig;
  }
});

test("runChatCommand: --resume last with no prior chats raises RESUME_NOT_FOUND", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "x", OPENWAR_CHATS_DIR: "/tmp/openwar-chats-empty-rrln" }, async () => {
    let thrown: unknown;
    try { await runChatCommand({ resume: "last" }); }
    catch (e) { thrown = e; }
    assert.ok(thrown instanceof ChatStartupError);
    assert.equal((thrown as InstanceType<typeof ChatStartupError>).code, "RESUME_NOT_FOUND");
  });
});
