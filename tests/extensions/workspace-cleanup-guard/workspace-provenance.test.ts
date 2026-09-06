import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceCleanupGuard } from "../../../extensions/workspace-cleanup-guard/workspace-provenance.ts";

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

test("r11-style mixed cleanup fails closed before confirmation", async () => {
  await withWorkspace(async (workspace) => {
    const goMod = path.join(workspace, "go.mod");
    const scratch = path.join(workspace, "tt_test.go");
    await writeFile(goMod, "module bookstore\n\ngo 1.18\n");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const overwrite = await guard.before({
      id: "overwrite-go-mod",
      command:
        "cat > go.mod <<'EOF'\nmodule bookstore\n\ngo 1.21\nEOF\ngo build ./...",
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
      command: "rm -f tt_test.go go.mod && ls -la",
      cwd: workspace,
    });

    assert.equal(cleanup.kind, "block");
    if (cleanup.kind === "block") {
      assert.deepEqual(cleanup.protectedPaths, []);
      assert.match(cleanup.reason, /direct rm command/u);
    }
    assert.equal(confirmations, 0);
    assert.equal(
      await readFile(goMod, "utf8"),
      "module bookstore\n\ngo 1.21\n",
    );
    assert.equal(await readFile(scratch, "utf8"), "package bookstore\n");
  });
});

test("session-created scratch can be deleted by a direct rm", async () => {
  await withWorkspace(async (workspace) => {
    const guard = guardFor(async () => false);
    const redirected = path.join(workspace, "redirected.txt");
    const written = path.join(workspace, "written.txt");

    assert.equal(
      (
        await guard.before({
          id: "create-redirected",
          command: "printf x > redirected.txt",
          cwd: workspace,
        })
      ).kind,
      "allow",
    );
    await writeFile(redirected, "x");
    await guard.after({ id: "create-redirected", isError: false });

    await guard.beforeWrite({
      id: "create-written",
      path: "written.txt",
      cwd: workspace,
    });
    await writeFile(written, "x");
    await guard.after({ id: "create-written", isError: false });

    assert.equal(
      (
        await guard.before({
          id: "remove",
          command: "rm -f redirected.txt written.txt",
          cwd: workspace,
        })
      ).kind,
      "allow",
    );
  });
});

test("native writes cannot reclassify baseline or failed output as scratch", async () => {
  await withWorkspace(async (workspace) => {
    const baseline = path.join(workspace, "go.mod");
    const failed = path.join(workspace, "failed.txt");
    await writeFile(baseline, "module bookstore\n");
    const guard = guardFor(async () => false);

    await guard.beforeWrite({
      id: "overwrite",
      path: "go.mod",
      cwd: workspace,
    });
    await writeFile(baseline, "module replacement\n");
    await guard.after({ id: "overwrite", isError: false });

    await guard.beforeWrite({
      id: "failed-write",
      path: "failed.txt",
      cwd: workspace,
    });
    await writeFile(failed, "external");
    await guard.after({ id: "failed-write", isError: true });

    assert.equal(
      (
        await guard.before({
          id: "remove-baseline",
          command: "rm -f go.mod",
          cwd: workspace,
        })
      ).kind,
      "block",
    );
    assert.equal(
      (
        await guard.before({
          id: "remove-failed",
          command: "rm -f failed.txt",
          cwd: workspace,
        })
      ).kind,
      "block",
    );
  });
});

test("confirmed direct deletion of a pre-existing file is allowed", async () => {
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

test("unproven or non-standalone rm input fails closed", async () => {
  await withWorkspace(async (workspace) => {
    const keep = path.join(workspace, "keep.txt");
    await writeFile(keep, "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    const commands = [
      'target="keep.txt"; rm "$target"',
      "PATH=/bin rm keep.txt",
      "printf ok # comment\nrm keep.txt",
      "x=foo; echo ${#x}; rm keep.txt",
      "! rm keep.txt",
      "rm *.txt",
      'rm "$(printf keep.txt)"',
      "rm keep{.txt,.bak}",
      "rm ~/keep.txt",
      `bash -c 'target="keep.txt"; rm "$target"'`,
      'target="keep.txt"; printf x | rm "$target"',
      'target="keep.txt"; command rm "$target"',
      "command r''m keep.txt",
      "env r\\m keep.txt",
      "command r\\\nm keep.txt",
      "r$''m keep.txt",
      'r$""m keep.txt',
      "r$'m' keep.txt",
      'target="keep.txt"; (rm "$target")',
      'target="keep.txt"; if true; then rm "$target"; fi',
      'target="keep.txt"; { rm "$target"; }',
      'target="keep.txt"; echo "$(rm "$target")"',
      'target="keep.txt"; output=$(rm "$target")',
      'target="keep.txt"; echo `rm "$target"`',
      'target="keep.txt"; cat <(rm "$target")',
      "sh -c 'rm \"$1\"' sh keep.txt",
      "dash -c 'rm keep.txt'",
      "ksh -c 'rm keep.txt'",
      "zsh -c 'rm keep.txt'",
      'target="keep.txt"; eval \'rm "$target"\'',
      'target="keep.txt"; case x in x) rm "$target";; esac',
      'target="keep.txt"; f(){ rm "$target"; }; f',
      'target="keep.txt"; time rm "$target"',
      'target="keep.txt"\ncat <<EOF\n$(rm "$target")\nEOF',
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
      'code=\'rm "$target"\'; eval "$code"',
      'code=\'rm "$1"\'; sh -c "$code" sh keep.txt',
      'code=\'rm "$1"\'; bash -lc "$code" bash keep.txt',
      "printf x | rm keep.txt",
      "command rm keep.txt",
      "(rm keep.txt)",
      "if true; then rm keep.txt; fi",
      "{ rm keep.txt; }",
      "./rm keep.txt",
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
      'target=keep.txt; cmd=/bin/rm; hash -p "$cmd" zap; zap "$target"',
      'target="keep.txt"; cmd=rm; env "$cmd" "$target"',
      'target="keep.txt"; cmd=rm; exec "$cmd" "$target"',
      'target="keep.txt"; cmd=rm; command "$cmd" "$target"',
      'target="keep.txt"; cmd=rm; printf "%s\\n" "$target" | xargs "$cmd"',
      'target="keep.txt"; cmd=rm; find . -name "$target" -exec "$cmd" {} +',
      'target="keep.txt"; cmd=rm; nice "$cmd" "$target"',
      'target="keep.txt"; cmd=rm; nohup "$cmd" "$target"',
      'target=keep.txt; (( a[$(rm "$target")] = 1 ))',
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
      `${"(".repeat(40)}rm keep.txt${")".repeat(40)}`,
      "/usr/bin/sandbox-exec -p '(version 1)' /bin/bash -c 'rm keep.txt'",
    ];

    for (const [index, command] of commands.entries()) {
      const decision = await guard.before({
        id: `unverified-${index}`,
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
    assert.equal(await readFile(keep, "utf8"), "keep");
  });
});

test("quoted or escaped literals remain directly verifiable", async () => {
  await withWorkspace(async (workspace) => {
    const cases =
      process.platform === "win32"
        ? [
            ["rm 'keep[1].txt'", "keep[1].txt"],
            ["rm scratch\\$1.txt", "scratch$1.txt"],
            ["rm 'scratch$1.txt'", "scratch$1.txt"],
            ['rm "file name.txt"', "file name.txt"],
            ['rm "keep\\\n.txt"', "keep.txt"],
          ]
        : [
            ["rm 'keep*.txt'", "keep*.txt"],
            ["rm keep\\*.txt", "keep*.txt"],
            ["rm 'scratch$1.txt'", "scratch$1.txt"],
            ['rm "file name.txt"', "file name.txt"],
            ['rm "keep\\*.txt"', "keep\\*.txt"],
            ['rm "keep\\\n.txt"', "keep.txt"],
          ];
    for (const target of new Set(cases.map(([, target]) => target))) {
      await writeFile(path.join(workspace, target), "keep");
    }
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return false;
    });

    for (const [index, [command]] of cases.entries()) {
      assert.equal(
        (
          await guard.before({
            id: `literal-${index}`,
            command,
            cwd: workspace,
          })
        ).kind,
        "block",
        command,
      );
    }
    assert.deepEqual(
      confirmations,
      cases.map(([, target]) => [target]),
    );
  });
});

test("ordinary Bash and identifiers without an rm executable stay native", async () => {
  await withWorkspace(async (workspace) => {
    const guard = guardFor(async () => false);

    for (const [index, command] of [
      "sh -c 'printf ok'",
      "eval 'printf ok'",
      "bash -n script.sh",
      "source ./env.sh",
      "trap 'printf ok' EXIT",
      "hash -r",
      "alias ll='ls -l'",
      "printf '%s' firmware rm-notes.txt terms",
      "printf '%s' \"r\\m\"",
      "printf '%s' $'firmware'",
      "printf '%s' $'rm-notes.txt'",
      "printf ok # rm keep.txt",
      "printf ok;# rm keep.txt",
      "cat <<EOF\nrm keep.txt\nEOF",
      "cat <<'EOF'\n$(rm keep.txt)\nEOF",
      "echo rm",
      "command -v rm",
      "echo '$(rm \"$target\")'",
      "label=rm printf ok",
    ].entries()) {
      const decision = await guard.before({
        id: `ordinary-${index}`,
        command,
        cwd: workspace,
      });
      assert.equal(decision.kind, "allow", command);
    }
  });
});

test("literal word concatenation still identifies the direct rm executable", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "keep.txt"), "keep");
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return false;
    });

    const decision = await guard.before({
      id: "concatenated-executable",
      command: "r''m keep.txt",
      cwd: workspace,
    });

    assert.equal(decision.kind, "block");
    assert.deepEqual(confirmations, [["keep.txt"]]);
  });
});

test("direct rm targets must resolve from workspace-relative paths", async () => {
  await withWorkspace(async (workspace) => {
    const target = path.join(workspace, "keep.txt");
    await writeFile(target, "keep");
    let confirmations = 0;
    const guard = guardFor(async () => {
      confirmations += 1;
      return true;
    });

    for (const [index, command] of [
      "rm /outside/keep.txt",
      "rm ../keep.txt",
      "rm .",
      "rm ~/keep.txt",
    ].entries()) {
      const decision = await guard.before({
        id: `outside-${index}`,
        command,
        cwd: workspace,
      });
      assert.equal(decision.kind, "block", command);
      if (decision.kind === "block") {
        assert.deepEqual(decision.protectedPaths, [], command);
      }
    }
    assert.equal(confirmations, 0);
    assert.equal(await readFile(target, "utf8"), "keep");
  });
});

test("Bash literal whitespace and dot-prefixed names remain protected", async () => {
  await withWorkspace(async (workspace) => {
    const nonBreakingSpace = "keep\u00a0.txt";
    await writeFile(path.join(workspace, nonBreakingSpace), "keep");
    await writeFile(path.join(workspace, "..foo"), "keep");
    const confirmations: string[][] = [];
    const guard = guardFor(async (paths) => {
      confirmations.push([...paths]);
      return false;
    });

    for (const [index, target] of [nonBreakingSpace, "..foo"].entries()) {
      const decision = await guard.before({
        id: `literal-edge-${index}`,
        command: `rm ${target}`,
        cwd: workspace,
      });
      assert.equal(decision.kind, "block", target);
    }
    assert.deepEqual(confirmations, [[nonBreakingSpace], ["..foo"]]);
  });
});

test("blocked cleanup cannot grant pending scratch ownership", async () => {
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

test("proven creation survives a later command failure", async () => {
  await withWorkspace(async (workspace) => {
    const file = path.join(workspace, "test_main.go");
    const directory = path.join(workspace, "testmain");
    const guard = guardFor(async () => false);

    await guard.before({
      id: "create-file-then-fail",
      command: "cat > test_main.go <<'EOF'\npackage main\nEOF\ngo run .",
      cwd: workspace,
    });
    await writeFile(file, "package main\n");
    await guard.after({ id: "create-file-then-fail", isError: true });

    await guard.before({
      id: "mkdir-then-fail",
      command: "mkdir -p testmain && go run ./testmain",
      cwd: workspace,
    });
    await mkdir(directory);
    await guard.after({ id: "mkdir-then-fail", isError: true });

    assert.equal(
      (
        await guard.before({
          id: "remove-file",
          command: "rm test_main.go",
          cwd: workspace,
        })
      ).kind,
      "allow",
    );
    assert.equal(
      (
        await guard.before({
          id: "remove-directory",
          command: "rm -rf testmain",
          cwd: workspace,
        })
      ).kind,
      "allow",
    );
  });
});
