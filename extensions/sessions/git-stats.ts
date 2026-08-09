import { execFile } from "node:child_process";
import type { SessionInfoLike } from "./sessions.ts";

export interface SessionStats {
  add: number;
  mod: number;
  del: number;
}

interface StatsLoaderOptions {
  cache?: Map<string, SessionStats>;
  maxCache?: number;
  maxConcurrency?: number;
  runGit?: (
    args: string[],
    cwd: string,
    signal: AbortSignal,
  ) => Promise<string>;
}

interface QueueEntry {
  signal: AbortSignal;
  start: (done: () => void) => void;
  cancel: () => void;
}

const GIT_STATS_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CACHE = 256;
const DEFAULT_MAX_CONCURRENCY = 4;

const abortError = () => {
  const error = new Error("Session stats load was cancelled.");
  error.name = "AbortError";
  return error;
};

function createQueue(maxConcurrency: number) {
  const queue: QueueEntry[] = [];
  let active = 0;

  const pump = () => {
    while (active < maxConcurrency && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.signal.aborted) {
        entry.cancel();
        continue;
      }
      active++;
      entry.start(() => {
        active--;
        pump();
      });
    }
  };

  const run = <A>(task: () => Promise<A>, signal: AbortSignal) =>
    new Promise<A>((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancelQueued);
        complete();
      };
      const cancelQueued = () => {
        if (started || settled) return;
        // Leave the cancelled entry in place for the next linear pump. Removing
        // every entry from a large shared-signal queue would make abort O(n²).
        finish(() => reject(abortError()));
      };
      const entry: QueueEntry = {
        signal,
        cancel: cancelQueued,
        start: (done) => {
          if (settled) {
            done();
            return;
          }
          started = true;
          signal.removeEventListener("abort", cancelQueued);
          void task()
            .then(
              (value) => finish(() => resolve(value)),
              (error) => finish(() => reject(error)),
            )
            .finally(done);
        },
      };

      signal.addEventListener("abort", cancelQueued, { once: true });
      queue.push(entry);
      pump();
    });

  return { run };
}

const runGit = (args: string[], cwd: string, signal: AbortSignal) =>
  new Promise<string>((resolve) => {
    try {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: GIT_STATS_TIMEOUT_MS,
          signal,
        },
        (error, stdout) => resolve(error ? "" : stdout),
      );
    } catch {
      resolve("");
    }
  });

const calculateStats = (outputs: readonly string[]) => {
  let added = 0;
  let deleted = 0;
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const [rawAdded, rawDeleted] = line.trim().split(/\s+/);
      const nextAdded = Number.parseInt(rawAdded ?? "", 10);
      const nextDeleted = Number.parseInt(rawDeleted ?? "", 10);
      if (!Number.isNaN(nextAdded)) added += nextAdded;
      if (!Number.isNaN(nextDeleted)) deleted += nextDeleted;
    }
  }

  const mod = Math.min(added, deleted);
  return { add: added - mod, mod, del: deleted - mod };
};

export function createSessionStatsLoader(options: StatsLoaderOptions = {}) {
  const cache = options.cache ?? new Map<string, SessionStats>();
  const maxCache = options.maxCache ?? DEFAULT_MAX_CACHE;
  const execute = options.runGit ?? runGit;
  const queue = createQueue(
    Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
  );
  const loading = new Map<string, AbortSignal>();

  const loadOne = async (
    session: SessionInfoLike,
    isLatestForCwd: boolean,
    signal: AbortSignal,
    onUpdate: () => void,
  ) => {
    const key = session.path;
    if (cache.has(key)) return;
    const currentLoad = loading.get(key);
    if (currentLoad && !currentLoad.aborted) return;
    loading.set(key, signal);

    const after = session.created
      ? session.created.toISOString()
      : new Date(session.modified.getTime() - 24 * 3600 * 1000).toISOString();
    const before = session.modified.toISOString();

    try {
      const outputs = await Promise.all([
        queue
          .run(
            () =>
              execute(
                [
                  "log",
                  `--after=${after}`,
                  `--before=${before}`,
                  "--numstat",
                  "--pretty=format:",
                ],
                session.cwd,
                signal,
              ),
            signal,
          )
          .catch(() => ""),
        isLatestForCwd
          ? queue
              .run(
                () => execute(["diff", "--numstat"], session.cwd, signal),
                signal,
              )
              .catch(() => "")
          : Promise.resolve(""),
      ]);
      if (signal.aborted || loading.get(key) !== signal) return;

      if (cache.size >= maxCache) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, calculateStats(outputs));
      onUpdate();
    } finally {
      if (loading.get(key) === signal) loading.delete(key);
    }
  };

  const load = (
    sessions: SessionInfoLike[],
    signal: AbortSignal,
    onUpdate: () => void,
  ) => {
    const latestByCwd = new Map<string, string>();
    for (const session of sessions) {
      if (!latestByCwd.has(session.cwd)) {
        latestByCwd.set(session.cwd, session.path);
      }
    }
    return Promise.all(
      sessions.map((session) =>
        loadOne(
          session,
          latestByCwd.get(session.cwd) === session.path,
          signal,
          onUpdate,
        ),
      ),
    ).then(() => undefined);
  };

  return { cache, load };
}
