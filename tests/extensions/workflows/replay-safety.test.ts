import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentCallKey } from "../../../extensions/workflows/journal.ts";
import {
  beginProcessReplayWorkspaceLease,
  createReplayFilesystemBoundary,
  createReplayIdentity,
  createReplayWorkspaceGuard,
  isReplaySafeAgentCall,
} from "../../../extensions/workflows/replay-safety.ts";

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
  // The read-only git tools are as side-effect-free as fd/rg and replay-safe.
  assert.equal(
    isReplaySafeAgentCall({
      tools: ["read", "git_show", "git_diff", "git_log"],
    }),
    true,
  );

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

function replayToolSource(name: string) {
  return name === "fd" || name === "rg"
    ? {
        path: "/fixture/extensions/file-search/index.ts",
        source: "fixture-package",
        scope: "user" as const,
        origin: "package" as const,
      }
    : name.startsWith("git_")
      ? {
          path: "/fixture/extensions/git-read/index.ts",
          source: "fixture-package",
          scope: "user" as const,
          origin: "package" as const,
        }
      : {
          path: `<builtin:${name}>`,
          source: "builtin",
          scope: "temporary" as const,
          origin: "top-level" as const,
        };
}

function filesystemTool(name: string, observe: (path: string) => string) {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    async execute(_toolCallId: string, params: { path?: string }) {
      return {
        content: [{ type: "text" as const, text: observe(params.path ?? ".") }],
        details: {},
      };
    },
  } satisfies ToolDefinition;
}

test("replay filesystem boundary permits repo-local observers and rejects escaping paths", async () => {
  const cwd = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-replay-outside-"));
  try {
    const outsideFile = path.join(outside, "outside.txt");
    writeFileSync(outsideFile, "external one\n");
    const observations: string[] = [];
    const definitions = new Map(
      ["read", "grep", "find", "ls", "fd", "rg"].map((name) => {
        const definition = filesystemTool(name, (pathname) => {
          observations.push(pathname);
          return readFileSync(path.resolve(cwd, pathname), "utf8");
        });
        return [name, definition] as const;
      }),
    );
    const boundary = createReplayFilesystemBoundary({
      repositoryRoot: cwd,
      cwd,
    });
    boundary.apply({
      getAllTools: () =>
        [...definitions.keys()].map((name) => ({
          name,
          sourceInfo: replayToolSource(name),
        })),
      getToolDefinition: (name) => definitions.get(name),
    });

    for (const definition of definitions.values()) {
      const local = await definition.execute("local", {
        path: "tracked.txt",
      });
      assert.equal(local.content[0]?.type, "text");
      assert.equal(
        local.content[0]?.type === "text" ? local.content[0].text : "",
        "one\n",
      );

      for (const escapingPath of [
        outsideFile,
        path.relative(cwd, outsideFile),
        "~",
        "~/outside.txt",
        `@${outsideFile}`,
      ]) {
        await assert.rejects(
          definition.execute("escape", { path: escapingPath }),
          /Replay filesystem boundary blocked/,
        );
      }
    }

    assert.equal(
      observations.length,
      definitions.size,
      "blocked calls must never reach a filesystem observer",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("replay filesystem boundary fails closed for symlinks and uncertain paths", async () => {
  const cwd = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-replay-symlink-"));
  try {
    const outsideFile = path.join(outside, "outside.txt");
    writeFileSync(outsideFile, "external one\n");
    symlinkSync(outsideFile, path.join(cwd, "external-link"));
    let observations = 0;
    let violations = 0;
    const definition = filesystemTool("read", (pathname) => {
      observations++;
      return readFileSync(path.resolve(cwd, pathname), "utf8");
    });
    const boundary = createReplayFilesystemBoundary({
      repositoryRoot: cwd,
      cwd,
      onViolation: () => {
        violations++;
      },
    });
    boundary.apply({
      getAllTools: () => [
        { name: "read", sourceInfo: replayToolSource("read") },
      ],
      getToolDefinition: () => definition,
    });

    await assert.rejects(
      definition.execute("symlink", { path: "external-link" }),
      /Replay filesystem boundary blocked/,
    );
    await assert.rejects(
      definition.execute("missing", { path: "missing.txt" }),
      /Replay filesystem boundary blocked/,
    );
    writeFileSync(outsideFile, "external two\n");
    await assert.rejects(
      definition.execute("stale", { path: outsideFile }),
      /Replay filesystem boundary blocked/,
    );

    assert.equal(observations, 0);
    assert.equal(violations, 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("replay filesystem boundary rejects path swaps during async execution", async () => {
  for (const swap of ["rename", "symlink"] as const) {
    const cwd = repository();
    const outside = mkdtempSync(path.join(tmpdir(), "pi-replay-swap-"));
    try {
      const tracked = path.join(cwd, "tracked.txt");
      const replacement = path.join(cwd, "replacement.txt");
      const outsideFile = path.join(outside, "outside.txt");
      writeFileSync(replacement, "replacement\n");
      writeFileSync(outsideFile, "external\n");
      let violations = 0;
      const definition = filesystemTool("read", (pathname) => {
        const observed = readFileSync(path.resolve(cwd, pathname), "utf8");
        rmSync(tracked);
        if (swap === "rename") renameSync(replacement, tracked);
        else symlinkSync(outsideFile, tracked);
        return observed;
      });
      createReplayFilesystemBoundary({
        repositoryRoot: cwd,
        cwd,
        onViolation: () => {
          violations++;
        },
      }).apply({
        getAllTools: () => [
          { name: "read", sourceInfo: replayToolSource("read") },
        ],
        getToolDefinition: () => definition,
      });

      await assert.rejects(
        definition.execute("swap", { path: "tracked.txt" }),
        /Replay filesystem boundary blocked/,
      );
      assert.equal(violations, 1, `${swap} must make the call non-journalable`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("replay filesystem boundary rejects unknown observer implementations", async () => {
  const cwd = repository();
  try {
    let observations = 0;
    const definition = filesystemTool("read", () => {
      observations++;
      return "unsafe";
    });
    createReplayFilesystemBoundary({ repositoryRoot: cwd, cwd }).apply({
      getAllTools: () => [
        {
          name: "read",
          sourceInfo: {
            path: path.join(cwd, ".pi/extensions/read.ts"),
            source: "project",
            scope: "project",
            origin: "top-level",
          },
        },
      ],
      getToolDefinition: () => definition,
    });

    await assert.rejects(
      definition.execute("unknown", { path: "tracked.txt" }),
      /Replay filesystem boundary blocked/,
    );
    assert.equal(observations, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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

test("process-wide guard coordinates overlapping calls from different workflow runs", () => {
  const firstRunReader = beginProcessReplayWorkspaceLease(true);
  assert.equal(firstRunReader.canReplay, true);

  const secondRunWriter = beginProcessReplayWorkspaceLease(false);
  assert.equal(
    firstRunReader.canJournal(),
    false,
    "a writer in another run must invalidate the reader",
  );
  const thirdRunReader = beginProcessReplayWorkspaceLease(true);
  assert.equal(
    thirdRunReader.canReplay,
    false,
    "a reader in another run cannot replay across the writer",
  );

  secondRunWriter.end();
  assert.equal(thirdRunReader.canJournal(), false);
  thirdRunReader.end();
  firstRunReader.end();

  const laterRunReader = beginProcessReplayWorkspaceLease(true);
  assert.equal(laterRunReader.canReplay, true);
  assert.equal(laterRunReader.canJournal(), true);
  laterRunReader.end();
});

test("canonical cwd and repository state participate in replay identity", () => {
  const cwd = repository();
  try {
    const resourcePath = path.join(cwd, "resource.md");
    writeFileSync(resourcePath, "resource one\n");
    const originalIdentity = createReplayIdentity(
      cwd,
      loader(resourcePath),
      true,
    );
    assert.equal(originalIdentity?.version, 3);
    assert.equal(originalIdentity?.repositoryRoot, realpathSync(cwd));
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
