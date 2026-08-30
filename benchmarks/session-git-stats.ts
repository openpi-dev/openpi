import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createSessionStatsLoader } from "../extensions/sessions/git-stats.ts";
import type { SessionInfoLike } from "../extensions/sessions/sessions.ts";

const run = (args: string[], cwd: string, signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", signal },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

async function createRepository(root: string, index: number) {
  const cwd = join(root, `repo-${index}`);
  await mkdir(cwd);
  await run(["init", "-q"], cwd);
  await run(["config", "user.email", "benchmark@openpi.local"], cwd);
  await run(["config", "user.name", "OpenPI benchmark"], cwd);
  await writeFile(join(cwd, "tracked.txt"), "baseline\n");
  await run(["add", "tracked.txt"], cwd);
  await run(["commit", "-qm", "benchmark fixture"], cwd);
  await writeFile(join(cwd, "tracked.txt"), "baseline\nworking\n");
  return cwd;
}

function makeSessions(
  count: number,
  repositories: readonly string[],
  sameWorkspace: boolean,
) {
  const now = Date.now();
  return Array.from({ length: count }, (_, index): SessionInfoLike => {
    const modified = new Date(now - index * 1_000);
    return {
      id: `session-${index}`,
      cwd: sameWorkspace
        ? repositories[0]!
        : repositories[index % repositories.length]!,
      created: new Date(modified.getTime() - 24 * 60 * 60 * 1_000),
      modified,
      firstMessage: "benchmark",
      path: join(root, `session-${index}.jsonl`),
    };
  });
}

async function measure(
  count: number,
  repositories: readonly string[],
  sameWorkspace: boolean,
) {
  const sessions = makeSessions(count, repositories, sameWorkspace);
  const targets = sessions.slice(0, Math.min(12, sessions.length));
  let calls = 0;
  const loader = createSessionStatsLoader({
    runGit: (args, cwd, signal) => {
      calls++;
      return run(args, cwd, signal);
    },
  });

  const coldStarted = performance.now();
  await loader.reconcile(targets, sessions, () => undefined);
  const coldMs = performance.now() - coldStarted;
  const coldCalls = calls;

  const warmStarted = performance.now();
  await loader.reconcile(targets, sessions, () => undefined);
  const warmMs = performance.now() - warmStarted;

  console.log(
    JSON.stringify({
      phase: "viewport",
      sessions: count,
      mode: sameWorkspace ? "same-workspace" : "multi-workspace",
      visible: targets.length,
      coldCalls,
      coldMs: Number(coldMs.toFixed(1)),
      warmCalls: calls - coldCalls,
      warmMs: Number(warmMs.toFixed(1)),
      cacheEntries: loader.cache.size,
    }),
  );
}

async function measureCancellation(repositories: readonly string[]) {
  const sessions = makeSessions(1_000, repositories, false);
  let started = 0;
  let resolveStarted!: () => void;
  const enoughStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const loader = createSessionStatsLoader({
    maxConcurrency: 4,
    runGit: (_args, _cwd, signal) => {
      started++;
      if (started === 4) resolveStarted();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(""), 1_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          },
          { once: true },
        );
      });
    },
  });
  const loading = loader.reconcile(
    sessions.slice(0, 12),
    sessions,
    () => undefined,
  );
  await enoughStarted;
  const cancelStarted = performance.now();
  loader.cancel();
  await loading;
  console.log(
    JSON.stringify({
      phase: "cancel",
      sessions: sessions.length,
      visible: 12,
      started,
      cancelMs: Number((performance.now() - cancelStarted).toFixed(1)),
      cacheEntries: loader.cache.size,
    }),
  );
}

async function measureCanonicalDiscovery() {
  const now = Date.now();
  const sessions = Array.from(
    { length: 1_000 },
    (_, index): SessionInfoLike => ({
      id: `canonical-${index}`,
      cwd: join(root, `canonical-workspace-${index}`),
      created: new Date(now - 24 * 60 * 60 * 1_000),
      modified: new Date(now - index),
      firstMessage: "benchmark",
      path: join(root, `canonical-session-${index}.jsonl`),
    }),
  );
  let canonicalCalls = 0;
  let canonicalActive = 0;
  let canonicalMaxActive = 0;
  const loader = createSessionStatsLoader({
    canonicalizeConcurrency: 8,
    canonicalizeCwd: async (cwd) => {
      canonicalCalls++;
      canonicalActive++;
      canonicalMaxActive = Math.max(canonicalMaxActive, canonicalActive);
      await new Promise<void>((resolve) => setImmediate(resolve));
      canonicalActive--;
      return cwd;
    },
    runGit: async () => "",
  });
  const started = performance.now();
  await loader.reconcile(sessions.slice(0, 12), sessions, () => undefined);
  const coldMs = performance.now() - started;
  await loader.reconcile(sessions.slice(12, 24), sessions, () => undefined);
  console.log(
    JSON.stringify({
      phase: "canonical",
      sessions: sessions.length,
      uniqueWorkspaces: sessions.length,
      canonicalCalls,
      canonicalMaxActive,
      coldMs: Number(coldMs.toFixed(1)),
      repeatedUniverseCalls: canonicalCalls - sessions.length,
    }),
  );

  let cancelStarts = 0;
  let resolveStarted!: () => void;
  const enoughStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const releases: Array<() => void> = [];
  const cancellable = createSessionStatsLoader({
    canonicalizeConcurrency: 4,
    canonicalizeCwd: (cwd) => {
      cancelStarts++;
      if (cancelStarts === 4) resolveStarted();
      return new Promise<string>((resolve) => {
        releases.push(() => resolve(cwd));
      });
    },
    runGit: async () => "",
  });
  const loading = cancellable.reconcile(
    sessions.slice(0, 12),
    sessions,
    () => undefined,
  );
  await enoughStarted;
  const cancelStarted = performance.now();
  cancellable.cancel();
  for (const release of releases) release();
  await loading;
  console.log(
    JSON.stringify({
      phase: "canonical-cancel",
      sessions: sessions.length,
      started: cancelStarts,
      cancelMs: Number((performance.now() - cancelStarted).toFixed(1)),
      cacheEntries: cancellable.cache.size,
    }),
  );
}

const root = await mkdtemp(join(tmpdir(), "openpi-session-git-stats-"));
try {
  const repositories = await Promise.all(
    Array.from({ length: 12 }, (_, index) => createRepository(root, index)),
  );
  for (const count of [10, 120, 1_000]) {
    await measure(count, repositories, false);
    await measure(count, repositories, true);
  }
  await measureCancellation(repositories);
  await measureCanonicalDiscovery();
} finally {
  await rm(root, { recursive: true, force: true });
}
