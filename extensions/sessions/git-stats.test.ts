import assert from "node:assert/strict";
import test from "node:test";
import { createSessionStatsLoader } from "./git-stats.ts";
import type { SessionInfoLike } from "./sessions.ts";

const makeSessions = (count: number): SessionInfoLike[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    cwd: `/tmp/project-${index}`,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T01:00:00.000Z"),
    firstMessage: "test",
    path: `/tmp/session-${index}.jsonl`,
  }));

test("large session lists bound Git subprocesses and reuse cached stats", async () => {
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
  const sessions = makeSessions(120);

  await loader.load(sessions, new AbortController().signal, () => undefined);

  assert.equal(calls, 240);
  assert.equal(maxActive, 4);
  assert.equal(loader.cache.size, 120);
  assert.deepEqual(loader.cache.get(sessions[0]!.path), {
    add: 4,
    mod: 2,
    del: 0,
  });

  await loader.load(sessions, new AbortController().signal, () => undefined);
  assert.equal(calls, 240, "cached sessions must not spawn Git again");
});

test("cancelling a stale list stops queued work and prevents stale cache updates", async () => {
  let started = 0;
  let completeImmediately = false;
  let resolveStarted!: () => void;
  const enoughStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const loader = createSessionStatsLoader({
    maxConcurrency: 3,
    runGit: (_args, _cwd, signal) => {
      started++;
      if (started === 3) resolveStarted();
      if (completeImmediately) return Promise.resolve("2\t0\tfile.ts\n");
      return new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("9\t0\tstale.ts\n"), {
          once: true,
        });
      });
    },
  });
  const sessions = makeSessions(100);
  const stale = new AbortController();
  let updates = 0;
  const loading = loader.load(sessions, stale.signal, () => {
    updates++;
  });

  await enoughStarted;
  stale.abort();
  await loading;

  assert.equal(started, 3);
  assert.equal(updates, 0);
  assert.equal(loader.cache.size, 0);

  completeImmediately = true;
  await loader.load(
    [sessions[0]!],
    new AbortController().signal,
    () => undefined,
  );
  assert.deepEqual(loader.cache.get(sessions[0]!.path), {
    add: 4,
    mod: 0,
    del: 0,
  });
});
