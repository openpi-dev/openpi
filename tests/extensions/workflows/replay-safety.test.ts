import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
  repositoryFingerprint,
} from "../../../extensions/workflows/replay-safety.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function assertSameDirectory(actual: string, expected: string) {
  const actualStats = statSync(actual);
  const expectedStats = statSync(expected);
  assert.deepEqual(
    { dev: actualStats.dev, ino: actualStats.ino },
    { dev: expectedStats.dev, ino: expectedStats.ino },
  );
}

function createFileSymlinkOrSkip(
  t: { skip(message?: string): void },
  target: string,
  path: string,
) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      t.skip("Windows file symlinks require Developer Mode or elevation");
      return false;
    }
    throw error;
  }
}

function recordingGit(commands: string[][]) {
  // Mirrors boundedGit's spawn shape (fsmonitor disabled, 32 MiB cap, stderr
  // ignored); the production deadline is intentionally not reproduced — the
  // fixtures stay far below it.
  return (cwd: string, args: readonly string[]) => {
    commands.push([...args]);
    return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  };
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

test("replay filesystem boundary fails closed for symlinks and uncertain paths", async (t) => {
  const cwd = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-replay-symlink-"));
  try {
    const outsideFile = path.join(outside, "outside.txt");
    writeFileSync(outsideFile, "external one\n");
    if (
      !createFileSymlinkOrSkip(t, outsideFile, path.join(cwd, "external-link"))
    ) {
      return;
    }
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
    assert.ok(originalIdentity);
    assertSameDirectory(originalIdentity.repositoryRoot, realpathSync(cwd));
    const original = replayKey(cwd, resourcePath);

    const alias = path.join(path.dirname(cwd), `${path.basename(cwd)}-alias`);
    symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      assert.equal(
        replayKey(alias, path.join(alias, "resource.md")),
        original,
        "a symlink spelling of the same cwd must canonicalize",
      );
    } finally {
      rmSync(alias, { recursive: true, force: true });
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

test("tracked and untracked symlinks disable replay", (t) => {
  for (const tracked of [true, false]) {
    const cwd = repository();
    try {
      const resourcePath = path.join(cwd, "resource.md");
      writeFileSync(resourcePath, "resource\n");
      if (
        !createFileSymlinkOrSkip(
          t,
          "tracked.txt",
          path.join(cwd, "observable-link"),
        )
      ) {
        return;
      }
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

test("replay fingerprint never diffs a repository with ignored files", () => {
  const cwd = repository();
  try {
    writeFileSync(path.join(cwd, ".gitignore"), "secret.txt\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-qm", "ignore secret");
    writeFileSync(path.join(cwd, "secret.txt"), "one\n");
    const commands: string[][] = [];
    assert.throws(() => repositoryFingerprint(cwd, recordingGit(commands)));
    assert.equal(
      commands.some((command) => command[0] === "diff"),
      false,
      "an already-ignored repository must not pay for the worktree diff",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("post-diff gates catch disqualifiers created while the diff runs", () => {
  for (const disqualifier of [
    "ignored",
    "tracked-symlink",
    "gitlink",
  ] as const) {
    const cwd = repository();
    try {
      if (disqualifier === "ignored") {
        writeFileSync(path.join(cwd, ".gitignore"), "secret.txt\n");
        git(cwd, "add", ".gitignore");
        git(cwd, "commit", "-qm", "ignore secret");
      }
      const commands: string[][] = [];
      const recordedGit = recordingGit(commands);
      let injected = false;
      const runGit = (gitCwd: string, args: readonly string[]) => {
        if (!injected && args[0] === "diff") {
          injected = true;
          if (disqualifier === "ignored") {
            writeFileSync(path.join(cwd, "secret.txt"), "one\n");
          } else {
            const sha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
              cwd,
              encoding: "utf8",
              input:
                disqualifier === "gitlink" ? "submodule commit" : "tracked.txt",
            }).trim();
            git(
              cwd,
              "update-index",
              "--add",
              "--cacheinfo",
              `${disqualifier === "gitlink" ? "160000" : "120000"},${sha},observable-link`,
            );
          }
        }
        return recordedGit(gitCwd, args);
      };

      assert.throws(() => repositoryFingerprint(cwd, runGit));
      assert.equal(injected, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("replay fingerprint keeps the early ignored gate and post-diff safety gates", () => {
  const cwd = repository();
  try {
    const commands: string[][] = [];
    const fingerprint = repositoryFingerprint(cwd, recordingGit(commands));
    assert.ok(fingerprint);
    assertSameDirectory(fingerprint.root, realpathSync(cwd));
    assert.deepEqual(commands, [
      ["rev-parse", "--show-toplevel"],
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      ["rev-parse", "--verify", "HEAD"],
      ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"],
      ["ls-files", "-s", "-z"],
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
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
