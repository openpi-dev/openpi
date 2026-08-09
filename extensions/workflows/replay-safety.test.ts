import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { agentCallKey } from "./journal.ts";
import {
  createReplayIdentity,
  createReplayWorkspaceGuard,
  isReplaySafeAgentCall,
} from "./replay-safety.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-workflow-replay-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Replay Test");
  git(cwd, "config", "user.email", "replay@example.test");
  writeFileSync(path.join(cwd, "tracked.txt"), "one\n");
  git(cwd, "add", "tracked.txt");
  git(cwd, "commit", "-qm", "fixture");
  return cwd;
}

function loader(resourcePath: string) {
  return {
    getAgentsFiles: () => ({
      agentsFiles: [{ path: resourcePath, content: "context" }],
    }),
    getAppendSystemPrompt: () => ["child prompt"],
    getExtensions: () => ({
      extensions: [{ resolvedPath: resourcePath }],
    }),
    getSkills: () => ({
      skills: [
        {
          name: "fixture",
          description: "Fixture skill",
          disableModelInvocation: false,
          filePath: resourcePath,
        },
      ],
    }),
    getSystemPrompt: () => "system prompt",
  } as Parameters<typeof createReplayIdentity>[1];
}

function replayKey(cwd: string, resourcePath: string, projectTrusted = true) {
  const identity = createReplayIdentity(
    cwd,
    loader(resourcePath),
    projectTrusted,
  );
  assert.ok(identity, "fixture must be fingerprintable");
  return agentCallKey("inspect", { execution: { replayIdentity: identity } });
}

test("only provably read-only agent calls are replay-safe", () => {
  assert.equal(
    isReplaySafeAgentCall({
      tools: ["read", "grep", "find", "ls", "fd", "rg"],
    }),
    true,
  );
  assert.equal(isReplaySafeAgentCall({ tools: ["read"] }), true);

  // No type/no allowlist inherits the normal unrestricted child capability set.
  assert.equal(isReplaySafeAgentCall({}), false);
  // The built-in implementer and explicit writable allowlists are never safe.
  assert.equal(
    isReplaySafeAgentCall({ tools: ["read", "bash", "edit", "write", "rg"] }),
    false,
  );
  for (const tool of ["bash", "edit", "write"]) {
    assert.equal(isReplaySafeAgentCall({ tools: ["read", tool] }), false);
  }
  // Unknown custom capabilities fail closed even when their name sounds safe.
  assert.equal(
    isReplaySafeAgentCall({ tools: ["read", "custom_search"] }),
    false,
  );
  assert.equal(
    isReplaySafeAgentCall({ tools: ["read"], isolation: "worktree" }),
    false,
  );
});

test("workspace guard rejects replay and journaling across unsafe overlap", () => {
  const guard = createReplayWorkspaceGuard();
  const reader = guard.begin(true);
  assert.equal(reader.canReplay, true);
  assert.equal(reader.canJournal(), true);

  const writer = guard.begin(false);
  assert.equal(
    reader.canJournal(),
    false,
    "an ABA write cannot be endpoint-hashed",
  );
  const overlappingReader = guard.begin(true);
  assert.equal(overlappingReader.canReplay, false);
  writer.end();
  assert.equal(overlappingReader.canJournal(), false);
  overlappingReader.end();
  reader.end();

  const laterReader = guard.begin(true);
  assert.equal(laterReader.canReplay, true);
  assert.equal(laterReader.canJournal(), true);
  laterReader.end();
  laterReader.end();
});

test("canonical cwd and repository state participate in replay identity", () => {
  const cwd = repository();
  try {
    const resourcePath = path.join(cwd, "resource.md");
    writeFileSync(resourcePath, "resource one\n");
    const original = replayKey(cwd, resourcePath);

    const alias = path.join(path.dirname(cwd), `${path.basename(cwd)}-alias`);
    symlinkSync(cwd, alias, "dir");
    try {
      assert.equal(
        replayKey(alias, path.join(alias, "resource.md")),
        original,
        "a symlink spelling of the same cwd must canonicalize",
      );
    } finally {
      rmSync(alias, { force: true });
    }

    const nested = path.join(cwd, "nested");
    mkdirSync(nested);
    assert.notEqual(replayKey(nested, resourcePath), original);

    writeFileSync(path.join(cwd, "tracked.txt"), "two\n");
    const dirtyTwo = replayKey(cwd, resourcePath);
    assert.notEqual(dirtyTwo, original);
    writeFileSync(path.join(cwd, "tracked.txt"), "three\n");
    assert.notEqual(
      replayKey(cwd, resourcePath),
      dirtyTwo,
      "tracked content must distinguish identical porcelain status entries",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("loaded resource content and trust participate in replay identity", () => {
  const cwd = repository();
  try {
    const resourcePath = path.join(cwd, "resource.md");
    writeFileSync(resourcePath, "resource one\n");
    const original = replayKey(cwd, resourcePath);

    writeFileSync(resourcePath, "resource two\n");
    assert.notEqual(replayKey(cwd, resourcePath), original);
    assert.notEqual(
      replayKey(cwd, resourcePath, false),
      replayKey(cwd, resourcePath),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ignored observable files disable replay rather than returning stale output", () => {
  const cwd = repository();
  try {
    const resourcePath = path.join(cwd, "resource.md");
    writeFileSync(resourcePath, "resource\n");
    writeFileSync(path.join(cwd, ".gitignore"), "secret.txt\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-qm", "ignore secret");
    writeFileSync(path.join(cwd, "secret.txt"), "one\n");
    assert.equal(
      createReplayIdentity(cwd, loader(resourcePath), true),
      undefined,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("tracked and untracked symlinks disable replay", () => {
  for (const tracked of [true, false]) {
    const cwd = repository();
    try {
      const resourcePath = path.join(cwd, "resource.md");
      writeFileSync(resourcePath, "resource\n");
      symlinkSync("tracked.txt", path.join(cwd, "observable-link"));
      if (tracked) {
        git(cwd, "add", "observable-link");
        git(cwd, "commit", "-qm", "track symlink");
      }
      assert.equal(
        createReplayIdentity(cwd, loader(resourcePath), true),
        undefined,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("fingerprint inability fails closed", () => {
  const cwd = repository();
  try {
    assert.equal(
      createReplayIdentity(cwd, loader(path.join(cwd, "missing.md")), true),
      undefined,
    );
    assert.equal(
      createReplayIdentity(
        path.join(cwd, "missing-directory"),
        loader("x"),
        true,
      ),
      undefined,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
