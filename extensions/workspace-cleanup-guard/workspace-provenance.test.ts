import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceCleanupGuard } from "./workspace-provenance.ts";

function guardFor(
  confirmDelete: (paths: readonly string[]) => Promise<boolean>,
) {
  const guard = createWorkspaceCleanupGuard();
  return {
    ...guard,
    before(attempt: { id: string; command: string; cwd: string }) {
      return guard.before({ ...attempt, confirmDelete });
    },
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "openpi-workspace-provenance-"),
  );
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("r11-style mixed cleanup cannot delete a baseline file", async () => {
  await withWorkspace(async (workspace) => {
    const goMod = path.join(workspace, "go.mod");
    const scratch = path.join(workspace, "tt_test.go");
    await writeFile(goMod, "module bookstore\n\ngo 1.18\n");
    const guard = guardFor(async () => false);

    const overwrite = await guard.before({
      id: "overwrite-go-mod",
      command:
        "cd \"$(pwd)\" && cat > go.mod <<'EOF'\nmodule bookstore\n\ngo 1.21\nEOF\ngo build ./...",
      cwd: workspace,
    });
    assert.equal(overwrite.kind, "allow");
    await writeFile(goMod, "module bookstore\n\ngo 1.21\n");
    await guard.after({ id: "overwrite-go-mod", isError: false });

    const createScratch = await guard.before({
      id: "create-scratch",
      command: "printf 'package bookstore' > tt_test.go && go test -v .",
      cwd: workspace,
    });
    assert.equal(createScratch.kind, "allow");
    await writeFile(scratch, "package bookstore\n");
    await guard.after({ id: "create-scratch", isError: false });

    const cleanup = await guard.before({
      id: "cleanup",
      command: 'cd "$(pwd)" && rm -f tt_test.go go.mod && ls -la',
      cwd: workspace,
    });

    assert.equal(cleanup.kind, "block");
    if (cleanup.kind === "block") {
      assert.deepEqual(cleanup.protectedPaths, ["go.mod"]);
      assert.match(cleanup.reason, /existed before this agent changed it/u);
    }
    assert.equal(
      await readFile(goMod, "utf8"),
      "module bookstore\n\ngo 1.21\n",
    );
    assert.equal(await readFile(scratch, "utf8"), "package bookstore\n");
  });
});

test("session-created scratch can be deleted without confirmation", async () => {
  await withWorkspace(async (workspace) => {
    const guard = guardFor(async () => false);
    const scratch = path.join(workspace, "scratch.txt");

    assert.equal(
      (
        await guard.before({
          id: "create",
          command: "printf x > scratch.txt",
          cwd: workspace,
        })
      ).kind,
      "allow",
    );
    await writeFile(scratch, "x");
    await guard.after({ id: "create", isError: false });

    assert.equal(
      (
        await guard.before({
          id: "remove",
          command: "rm -f scratch.txt",
          cwd: workspace,
        })
      ).kind,
      "allow",
    );
  });
});

test("scratch created by the native write tool can be deleted without confirmation", async () => {
  await withWorkspace(async (workspace) => {
    const guard = guardFor(async () => false);
    const scratch = path.join(workspace, "zz_test.go");

    await guard.beforeWrite({
      id: "write-scratch",
      path: "zz_test.go",
      cwd: workspace,
    });
    await writeFile(scratch, "package bookstore\n");
    await guard.after({ id: "write-scratch", isError: false });

    const cleanup = await guard.before({
      id: "remove-scratch",
      command: "go test ./... && rm -f zz_test.go",
      cwd: workspace,
    });

    assert.equal(cleanup.kind, "allow");
  });
});

test("native write keeps an overwritten baseline file protected", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "go.mod");
    await writeFile(target, "module bookstore\n");
    const guard = guardFor(async () => false);

    await guard.beforeWrite({
      id: "overwrite-go-mod",
      path: "go.mod",
      cwd: workspace,
    });
    await writeFile(target, "module replacement\n");
    await guard.after({ id: "overwrite-go-mod", isError: false });

    const cleanup = await guard.before({
      id: "remove-go-mod",
      command: "rm -f go.mod",
      cwd: workspace,
    });
    assert.equal(cleanup.kind, "block");
  });
});

test("a failed native write never grants scratch deletion authority", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "failed.txt");
    const guard = guardFor(async () => false);

    await guard.beforeWrite({
      id: "failed-write",
      path: "failed.txt",
      cwd: workspace,
    });
    await writeFile(target, "external");
    await guard.after({ id: "failed-write", isError: true });

    const cleanup = await guard.before({
      id: "remove-failed",
      command: "rm -f failed.txt",
      cwd: workspace,
    });
    assert.equal(cleanup.kind, "block");
  });
});

test("confirmed deletion of a pre-existing file is allowed", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "obsolete.txt"), "old");
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return true;
    });

    const decision = await guard.before({
      id: "remove",
      command: "rm obsolete.txt",
      cwd: workspace,
    });

    assert.equal(decision.kind, "allow");
    assert.deepEqual(confirmations, [["obsolete.txt"]]);
  });
});

test("ambiguous shell deletion is not misrepresented as protected", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const guard = guardFor(async () => false);

    const decision = await guard.before({
      id: "ambiguous",
      command: 'target="keep.txt"; rm "$target"',
      cwd: workspace,
    });

    assert.equal(decision.kind, "allow");
    assert.equal(decision.opaqueDestructiveCommand, true);
  });
});

test("a later command failure does not erase proven scratch creation", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "test_main.go");
    const guard = guardFor(async () => false);

    await guard.before({
      id: "create-then-fail",
      command: "cat > test_main.go <<'EOF'\npackage main\nEOF\ngo run .",
      cwd: workspace,
    });
    await writeFile(target, "package main\n");
    await guard.after({ id: "create-then-fail", isError: true });

    const decision = await guard.before({
      id: "remove",
      command: "rm test_main.go",
      cwd: workspace,
    });

    assert.equal(decision.kind, "allow");
  });
});

test("a literal mkdir target remains session-owned after a later failure", async () => {
  await withWorkspace(async (workspace) => {
    const scratch = path.join(workspace, "testmain");
    const guard = guardFor(async () => false);

    await guard.before({
      id: "mkdir-then-fail",
      command: "mkdir -p testmain && go run ./testmain",
      cwd: workspace,
    });
    await mkdir(scratch);
    await guard.after({ id: "mkdir-then-fail", isError: true });

    const decision = await guard.before({
      id: "remove-directory",
      command: "rm -rf testmain",
      cwd: workspace,
    });

    assert.equal(decision.kind, "allow");
  });
});

test("a sandbox wrapper cannot hide a protected cleanup from the guard", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "go.mod"), "module bookstore\n");
    const guard = guardFor(async () => false);
    const wrapped =
      "/usr/bin/sandbox-exec -p '(version 1)' /usr/bin/env PATH=/usr/bin /bin/bash -c 'cd \"$(pwd)\" && rm -f go.mod && ls -la'";

    const decision = await guard.before({
      id: "wrapped-cleanup",
      command: wrapped,
      cwd: workspace,
    });

    assert.equal(decision.kind, "block");
  });
});
