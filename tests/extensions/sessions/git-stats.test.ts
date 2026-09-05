import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createSessionStatsLoader } from "../../../extensions/sessions/git-stats.ts";
import type { SessionInfoLike } from "../../../extensions/sessions/sessions.ts";

const makeSessions = (count: number): SessionInfoLike[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    cwd: `/tmp/project-${index}`,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T01:00:00.000Z"),
    firstMessage: "test",
    path: `/tmp/session-${index}.jsonl`,
  }));

test("Git work is bounded by the requested viewport at 10, 120, and 1,000 sessions", async () => {
  for (const count of [10, 120, 1_000]) {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const loader = createSessionStatsLoader({
      maxConcurrency: 4,
      runGit: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return "3\t1\tfile.ts\n";
      },
    });
    const sessions = makeSessions(count);
    const targets = sessions.slice(0, Math.min(12, count));

    await loader.reconcile(targets, sessions, () => undefined);

    assert.equal(calls, targets.length * 2);
    assert.equal(maxActive, Math.min(4, calls));
    assert.deepEqual(loader.get(targets[0]!), {
      status: "ready",
      stats: { add: 4, mod: 2, del: 0 },
    });
    if (count > targets.length) {
      assert.equal(loader.get(sessions.at(-1)!), undefined);
    }

    await loader.reconcile(targets, sessions, () => undefined);
    assert.equal(
      calls,
      targets.length * 2,
      "cached targets must not rerun Git",
    );
  }
});

test("only the globally latest session for a workspace includes its working diff", async () => {
  const sessions = makeSessions(20).map((entry, index) => ({
    ...entry,
    cwd: "/tmp/shared-project",
    modified: new Date(Date.UTC(2026, 0, 2, 0, 0, 20 - index)),
  }));
  const calls: string[][] = [];
  const loader = createSessionStatsLoader({
    runGit: async (args) => {
      calls.push(args);
      return args[0] === "diff" ? "10\t0\tworking.ts\n" : "2\t0\thistory.ts\n";
    },
  });

  await loader.reconcile([sessions[10]!], sessions, () => undefined);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["log"],
  );
  assert.deepEqual(loader.get(sessions[10]!), {
    status: "ready",
    stats: { add: 2, mod: 0, del: 0 },
  });

  await loader.reconcile([sessions[0]!], sessions, () => undefined);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["log", "log", "diff"],
  );
  assert.deepEqual(loader.get(sessions[0]!), {
    status: "ready",
    stats: { add: 12, mod: 0, del: 0 },
  });
});

test("overlapping viewport work is retained while work that leaves is cancelled", async () => {
  const sessions = makeSessions(30);
  const started: string[] = [];
  const aborted: string[] = [];
  let resolveStarted!: () => void;
  const enoughStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let releaseNew!: () => void;
  const newCanFinish = new Promise<void>((resolve) => {
    releaseNew = resolve;
  });
  const loader = createSessionStatsLoader({
    maxConcurrency: 4,
    canonicalizeCwd: async (cwd) => cwd,
    runGit: (args, cwd, signal) => {
      const id = `${cwd}:${args[0]}`;
      started.push(id);
      if (started.length === 4) resolveStarted();
      return new Promise<string>((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted.push(id);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
        if (cwd.endsWith("project-12") || cwd.endsWith("project-13")) {
          void newCanFinish.then(() => resolve("1\t0\tnew.ts\n"));
        }
      });
    },
  });

  const first = loader.reconcile(
    sessions.slice(0, 12),
    sessions,
    () => undefined,
  );
  await enoughStarted;
  const second = loader.reconcile(
    sessions.slice(2, 14),
    sessions,
    () => undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(aborted.length, 4);
  assert.equal(
    started.filter((entry) => entry.startsWith(`${resolve("/tmp/project-2")}:`))
      .length,
    2,
    "overlapping work must not restart",
  );

  loader.cancel();
  releaseNew();
  await Promise.all([first, second]);
  assert.equal(loader.cache.size, 0, "cancelled work must not populate cache");
});

test("duplicate query identities share work and Git failures remain unavailable", async () => {
  const duplicateA = makeSessions(1)[0]!;
  const duplicateB = {
    ...duplicateA,
    id: "duplicate",
    path: "/tmp/duplicate.jsonl",
  };
  const newest = {
    ...duplicateA,
    id: "newest",
    path: "/tmp/newest.jsonl",
    modified: new Date("2026-01-01T02:00:00.000Z"),
  };
  let calls = 0;
  const shared = createSessionStatsLoader({
    runGit: async () => {
      calls++;
      return "1\t0\tfile.ts\n";
    },
  });

  await shared.reconcile(
    [duplicateA, duplicateB],
    [newest, duplicateA, duplicateB],
    () => undefined,
  );
  assert.equal(calls, 1);
  assert.deepEqual(shared.get(duplicateA), shared.get(duplicateB));

  const failed = createSessionStatsLoader({
    runGit: async () => {
      throw new Error("git unavailable");
    },
  });
  await failed.reconcile([duplicateA], [duplicateA], () => undefined);
  assert.deepEqual(failed.get(duplicateA), { status: "unavailable" });
});

test("one failed Git command aborts its sibling before settling unavailable", async () => {
  const session = makeSessions(1)[0]!;
  let diffSignal: AbortSignal | undefined;
  const loader = createSessionStatsLoader({
    runGit: (args, _cwd, signal) => {
      if (args[0] === "log") return Promise.reject(new Error("log failed"));
      diffSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    },
  });

  await loader.reconcile([session], [session], () => undefined);

  assert.equal(diffSignal?.aborted, true);
  assert.deepEqual(loader.get(session), { status: "unavailable" });
});

test("real and symlink workspace paths share one canonical latest bucket", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-git-stats-alias-"));
  const workspace = join(root, "workspace");
  const alias = join(root, "alias");
  try {
    await mkdir(workspace);
    await symlink(
      workspace,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const [newest, older] = makeSessions(2).map((entry, index) => ({
      ...entry,
      cwd: index === 0 ? workspace : alias,
      modified: new Date(Date.UTC(2026, 0, 2, 0, 0, 2 - index)),
    }));
    const commands: string[] = [];
    const loader = createSessionStatsLoader({
      runGit: async (args) => {
        commands.push(args[0]!);
        return "";
      },
    });

    await loader.reconcile(
      [newest!, older!],
      [newest!, older!],
      () => undefined,
    );

    assert.equal(commands.filter((command) => command === "log").length, 2);
    assert.equal(commands.filter((command) => command === "diff").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical workspace discovery is bounded and reused for one universe", async () => {
  const sessions = makeSessions(1_000);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const loader = createSessionStatsLoader({
    canonicalizeConcurrency: 8,
    canonicalizeCwd: async (cwd) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return cwd;
    },
    runGit: async () => "",
  });

  await loader.reconcile(sessions.slice(0, 12), sessions, () => undefined);
  await loader.reconcile(sessions.slice(12, 24), sessions, () => undefined);

  assert.equal(calls, 1_000);
  assert.equal(maxActive, 8);
});

test("cancelling canonical discovery stops scheduling undiscovered workspaces", async () => {
  const sessions = makeSessions(1_000);
  const releases: Array<() => void> = [];
  let started = 0;
  let resolveStarted!: () => void;
  const enoughStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const loader = createSessionStatsLoader({
    canonicalizeConcurrency: 4,
    canonicalizeCwd: (cwd) => {
      started++;
      if (started === 4) resolveStarted();
      return new Promise<string>((resolve) => {
        releases.push(() => resolve(cwd));
      });
    },
    runGit: async () => "",
  });

  const loading = loader.reconcile(
    sessions.slice(0, 12),
    sessions,
    () => undefined,
  );
  await enoughStarted;
  loader.cancel();
  for (const release of releases) release();
  await loading;

  assert.equal(started, 4);
  assert.equal(loader.cache.size, 0);
});

test("stats cache is a per-query first observation and a new loader refreshes it", async () => {
  const session = makeSessions(1)[0]!;
  let added = 1;
  let calls = 0;
  const create = () =>
    createSessionStatsLoader({
      canonicalizeCwd: async (cwd) => cwd,
      runGit: async () => {
        calls++;
        return `${added}\t0\tfile.ts\n`;
      },
    });
  const firstPicker = create();

  await firstPicker.reconcile([session], [session], () => undefined);
  added = 5;
  await firstPicker.reconcile([session], [session], () => undefined);
  assert.deepEqual(firstPicker.get(session), {
    status: "ready",
    stats: { add: 2, mod: 0, del: 0 },
  });
  assert.equal(calls, 2);

  const reopenedPicker = create();
  await reopenedPicker.reconcile([session], [session], () => undefined);
  assert.deepEqual(reopenedPicker.get(session), {
    status: "ready",
    stats: { add: 10, mod: 0, del: 0 },
  });
  assert.equal(calls, 4);
});
