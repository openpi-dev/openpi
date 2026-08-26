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

test("dynamic rm targets fail closed without prompting for unknown paths", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const commands = [
      'target="keep.txt"; rm "$target"',
      "rm *.txt",
      'rm "$(printf keep.txt)"',
      "rm keep{.txt,.bak}",
      "rm ~/keep.txt",
      `bash -c 'target="keep.txt"; rm "$target"'`,
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `ambiguous-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
      if (decision.kind === "block") {
        assert.deepEqual(decision.protectedPaths, [], command);
        assert.match(decision.reason, /direct rm command/u);
      }
    }
    assert.equal(confirmations, 0);
    assert.equal(
      await readFile(path.join(workspace, "keep.txt"), "utf8"),
      "keep",
    );
  });
});

test("dynamic rm targets in compound command positions fail closed", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const commands = [
      'target="keep.txt"; printf x | rm "$target"',
      'target="keep.txt"; command rm "$target"',
      'target="keep.txt"; (rm "$target")',
      'target="keep.txt"; if true; then rm "$target"; fi',
      'target="keep.txt"; { rm "$target"; }',
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `compound-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations, 0);
    assert.equal(
      await readFile(path.join(workspace, "keep.txt"), "utf8"),
      "keep",
    );
  });
});

test("rm targets in nested shell execution contexts fail closed", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const commands = [
      'target="keep.txt"; echo "$(rm "$target")"',
      'target="keep.txt"; output=$(rm "$target")',
      'target="keep.txt"; echo `rm "$target"`',
      'target="keep.txt"; cat <(rm "$target")',
      "sh -c 'rm \"$1\"' sh keep.txt",
      'target="keep.txt"; eval \'rm "$target"\'',
      'target="keep.txt"; case x in x) rm "$target";; esac',
      'target="keep.txt"; f(){ rm "$target"; }; f',
      'target="keep.txt"; time rm "$target"',
      'target="keep.txt"\ncat <<EOF\n$(rm "$target")\nEOF',
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `nested-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations, 0);
    assert.equal(
      await readFile(path.join(workspace, "keep.txt"), "utf8"),
      "keep",
    );
  });
});

test("literal nested rm targets are confirmed when statically executable and otherwise fail closed", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return false;
    });

    const commands = [
      'echo "$(rm keep.txt)"',
      "output=$(rm keep.txt)",
      "echo `rm keep.txt`",
      "cat <(rm keep.txt)",
      "sh -c 'rm keep.txt'",
      "eval 'rm keep.txt'",
      "case x in x) rm keep.txt;; esac",
      "f(){ rm keep.txt; }; f",
      "time rm keep.txt",
      "cat <<EOF\n$(rm keep.txt)\nEOF",
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `nested-literal-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations.length, 8);
    assert(confirmations.every((paths) => paths.join() === "keep.txt"));
  });
});

test("dynamic eval and shell command sources fail closed", async () => {
  await withWorkspace(async (workspace) => {
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    for (const [index, command] of [
      'code=\'rm "$target"\'; eval "$code"',
      'code=\'rm "$1"\'; sh -c "$code" sh keep.txt',
      'code=\'rm "$1"\'; bash -lc "$code" bash keep.txt',
    ].entries()) {
      const decision = await guard.before({
        id: `dynamic-source-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations, 0);
  });
});

test("excessively nested shell execution fails closed", async () => {
  await withWorkspace(async (workspace) => {
    const guard = guardFor(async () => true);
    const command = `${"echo $(".repeat(40)}rm "$target"${")".repeat(40)}`;

    const decision = await guard.before({
      id: "deeply-nested",
      command,
      cwd: workspace,
    });

    assert.equal(decision.kind, "block");
  });
});

test("literal rm targets in compound command positions remain protected", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return false;
    });

    const commands = [
      "printf x | rm keep.txt",
      "command rm keep.txt",
      "(rm keep.txt)",
      "if true; then rm keep.txt; fi",
      "{ rm keep.txt; }",
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `compound-literal-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations.length, 4);
    assert(confirmations.every((paths) => paths.join() === "keep.txt"));
  });
});

test("quoted and escaped metacharacters remain literal rm targets", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep*.txt"), "keep");
    await writeFile(path.join(workspace, "scratch$1.txt"), "keep");
    await writeFile(path.join(workspace, "keep\\*.txt"), "keep");
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return false;
    });

    for (const [index, command] of [
      "rm 'keep*.txt'",
      'rm "keep*.txt"',
      "rm keep\\*.txt",
      "rm 'scratch$1.txt'",
      'rm "keep\\*.txt"',
    ].entries()) {
      const decision = await guard.before({
        id: `literal-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.deepEqual(confirmations, [
      ["keep*.txt"],
      ["keep*.txt"],
      ["keep*.txt"],
      ["scratch$1.txt"],
      ["keep\\*.txt"],
    ]);
  });
});

test("non-executing comments and heredocs do not trigger deletion protection", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return false;
    });

    for (const [index, command] of [
      "printf ok # rm keep.txt",
      'printf ok # ignored | rm "$target"',
      "cat <<EOF\nrm keep.txt\nEOF",
      "cat <<EOF\n\\$(rm keep.txt)\nEOF",
      "cat <<'EOF'\n$(rm keep.txt)\nEOF",
      "cat <<'EOF'\nrm keep.txt\nEOF",
    ].entries()) {
      const decision = await guard.before({
        id: `non-command-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "allow", command);
    }
    assert.equal(confirmations, 0);
  });
});

test("indirect rm references and shell evaluators fail closed", async () => {
  await withWorkspace(async (workspace) => {
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    for (const [index, command] of [
      "echo rm",
      "command -v rm",
      "echo '$(rm \"$target\")'",
      'echo "<(rm keep.txt)"',
      "sh -c 'echo ok'",
      "eval 'echo ok'",
      'code="echo ok"; eval "$code"',
      'echo "$(',
    ].entries()) {
      const decision = await guard.before({
        id: `indirect-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations, 0);
  });
});

test("indirect execution bypass matrix fails closed", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const commands = [
      'target=keep.txt; env rm "$target"',
      'target=keep.txt; exec rm "$target"',
      'target=keep.txt; cmd=rm; "$cmd" "$target"',
      'target=keep.txt; $(printf rm) "$target"',
      "printf 'keep.txt\\n' | xargs rm",
      "find . -name keep.txt -exec rm {} +",
      "target=keep.txt; trap 'rm \"$target\"' EXIT",
      "target=keep.txt; builtin eval 'rm \"$target\"'",
      "bash -O extglob -c 'rm \"$1\"' bash keep.txt",
      "shopt -s expand_aliases\nalias zap='rm \"$target\"'\nzap",
      "target=keep.txt\nshopt -s expand_aliases\nalias zap=\"$(printf '\\162\\155 keep.txt')\"\nzap",
      'target=keep.txt; cmd=/bin/rm; hash -p "$cmd" zap; zap "$target"',
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `reviewed-bypass-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
      if (decision.kind === "block") {
        assert.deepEqual(decision.protectedPaths, [], command);
      }
    }
    assert.equal(confirmations, 0);
    assert.equal(
      await readFile(path.join(workspace, "keep.txt"), "utf8"),
      "keep",
    );
  });
});

test("additional Bash AST execution contexts fail closed", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const commands = [
      'target=keep.txt; for x in x; do rm "$target"; done',
      'target=keep.txt; while true; do rm "$target"; break; done',
      'target=keep.txt; until false; do rm "$target"; break; done',
      'target=keep.txt; select x in x; do rm "$target"; break; done <<< 1',
      'target=keep.txt; coproc rm "$target"; wait',
      'target=keep.txt; arr=($(rm "$target"))',
      'target=keep.txt; echo "${x:-$(rm "$target")}"',
      'target=keep.txt; cat <<< "$(rm "$target")"',
      'target=keep.txt; [[ $(rm "$target") == x ]]',
      'target=keep.txt; mapfile < <(rm "$target")',
    ];
    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `additional-context-${index}`,
        command,
        cwd: workspace,
      });

      assert.equal(decision.kind, "block", command);
    }
    assert.equal(confirmations, 0);
    assert.equal(
      await readFile(path.join(workspace, "keep.txt"), "utf8"),
      "keep",
    );
  });
});

test("blocked unverified cleanup cannot grant pending scratch ownership", async () => {
  await withWorkspace(async (workspace) => {
    const scratch = path.join(workspace, "scratch.txt");
    const guard = guardFor(async () => false);

    const blocked = await guard.before({
      id: "blocked-create-and-cleanup",
      command: 'printf x > scratch.txt; target="keep.txt"; rm "$target"',
      cwd: workspace,
    });
    assert.equal(blocked.kind, "block");

    await writeFile(scratch, "external");
    await guard.after({ id: "blocked-create-and-cleanup", isError: false });
    const cleanup = await guard.before({
      id: "remove-external",
      command: "rm scratch.txt",
      cwd: workspace,
    });

    assert.equal(cleanup.kind, "block");
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
