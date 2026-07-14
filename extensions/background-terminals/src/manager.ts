/**
 * TerminalManager — owns the registry of running/settled background
 * terminals.
 *
 * Each terminal is a raw `node:child_process` spawn (own process group on
 * POSIX, stdin ignored) whose stdout/stderr 'data' callbacks fold into two
 * bounded OutputBuffers. Closing a terminal's scope kills the whole process
 * tree (SIGTERM → SIGKILL escalation).
 *
 * The manager also exposes a synchronous `TerminalReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget kills without touching the Effect runtime.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect";
import {
  ConcurrencyLimitError,
  SpawnError,
  UnknownTerminalError,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
/** In-memory retained cap per stream; the spill file keeps the full capture. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
const FORCE_KILL_AFTER_MS = 2_000;
/** After exit, how long to wait for 'close' (stdio flush) before force-settling. */
const CLOSE_GRACE_MS = 1_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function boundedError(error: unknown) {
  return bounded(error instanceof Error ? error.message : String(error));
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly TerminalSnapshot type.
 * stdout/stderr are getters over the live OutputBuffers. */
interface MutableSnapshot extends TerminalSnapshot {
  status: TerminalStatus;
  pid?: number;
  settledAt?: number;
  exitCode?: number;
  signal?: string;
  errorText?: string;
}

interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  scope: Scope.Closeable;
  stdoutBuf: OutputBuffer;
  stderrBuf: OutputBuffer;
  spillStreams: fs.WriteStream[];
  /** Set before signaling so a SIGTERM'd process that exits with a code still
   * reports "killed" — whichever settle lands first wins (settle is idempotent). */
  killRequested: boolean;
  /** 'exit' event observed (code/signal recorded). */
  exited: boolean;
  /** 'close' event observed (stdio flushed; the settle trigger). */
  stdioClosed: boolean;
  closeWaiters: Array<() => void>;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
}

export interface KillResult {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  /** True when this call initiated the termination (entry was running). */
  readonly killed: boolean;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface TerminalReadModel {
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  /** Any-change notification (widget, /ps list). */
  subscribe(listener: () => void): () => void;
  /** Per-terminal notification (/ps detail view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget kill (dashboard/detail `x`). Not marked consumed: the
   * settle still flows back to the model as a follow-up message. */
  requestKill(id: string): void;
  /**
   * Register the settle hook. `consumed` is true when an active bg_kill is
   * collecting the result (so it must not also be delivered as a follow-up).
   */
  setOnSettled(
    hook: ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface TerminalManagerShape {
  start(
    options: StartOptions,
  ): Effect.Effect<TerminalSnapshot, SpawnError | ConcurrencyLimitError>;
  status(id: string): Effect.Effect<TerminalSnapshot, UnknownTerminalError>;
  /** Kill running terminals; resolves only after they have settled. */
  kill(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<KillResult>>;
  readonly list: Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: TerminalReadModel;
}

export class TerminalManager extends Context.Service<
  TerminalManager,
  TerminalManagerShape
>()("background-terminals/TerminalManager") {}

// --- Process helpers ------------------------------------------------------------

function shellInvocation(command: string) {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    return { shell, args: ["/d", "/s", "/c", command] };
  }
  return { shell: "/bin/sh", args: ["-c", command] };
}

/** Signal the whole process group on POSIX so descendants (servers a shell
 * command spawned) die with it; a wedged child must not orphan its tree. */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group may already be gone; fall through to the direct signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be gone.
  }
}

/** SIGTERM → deadline → SIGKILL; resolves once exit is observed (or shortly
 * after the force kill, so teardown can never hang on a wedged process). */
function terminateChild(child: ChildProcess, exited: () => boolean) {
  if (exited()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (lastTimer) clearTimeout(lastTimer);
      resolve();
    };
    child.once("exit", finish);
    killTree(child, "SIGTERM");
    forceTimer = setTimeout(() => {
      if (!exited()) killTree(child, "SIGKILL");
    }, FORCE_KILL_AFTER_MS);
    lastTimer = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
  });
}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  // Detached forker for sync contexts (read-model kills, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  /** ids with an in-flight kill() collecting the result (settle → consumed). */
  const killInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let counter = 0;
  let reserved = 0;
  let disposed = false;
  let spillDir: string | undefined | null;
  let onSettled:
    ((snap: TerminalSnapshot, consumed: boolean) => void) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed widget/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () =>
    [...entries.values()].filter((e) => e.snapshot.status === "running").length;

  const addKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) killInterest.set(id, (killInterest.get(id) ?? 0) + 1);
  };
  const releaseKillInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (killInterest.get(id) ?? 1) - 1;
      if (count <= 0) killInterest.delete(id);
      else killInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" && !killInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  const closeSpillStreams = (entry: Entry) => {
    for (const stream of entry.spillStreams) {
      try {
        stream.end();
      } catch {
        // Best effort; tmpdir contents are disposable.
      }
    }
    entry.spillStreams = [];
  };

  /** Single settle path — idempotent; kill vs natural exit vs error races are
   * resolved by whichever lands first (the second call is a no-op). */
  const settle = (entry: Entry) => {
    const s = entry.snapshot;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    s.status = entry.killRequested
      ? "killed"
      : s.errorText !== undefined
        ? "failed"
        : s.exitCode === 0
          ? "done"
          : "failed";
    closeSpillStreams(entry);
    const consumed = (killInterest.get(s.id) ?? 0) > 0;
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  const resolveSpillDir = () => {
    if (spillDir !== undefined) return spillDir ?? undefined;
    try {
      const base = path.join(os.tmpdir(), "pi-background-terminals");
      fs.mkdirSync(base, { recursive: true });
      spillDir = fs.mkdtempSync(path.join(base, "session-"));
    } catch {
      spillDir = null;
    }
    return spillDir ?? undefined;
  };

  const makeSpill = (
    entry: () => Entry | undefined,
    id: string,
    stream: "stdout" | "stderr",
  ) => {
    const dir = resolveSpillDir();
    if (!dir) return undefined;
    const spillPath = path.join(dir, `${id}.${stream}.log`);
    try {
      const file = fs.createWriteStream(spillPath, { flags: "a" });
      let broken = false;
      file.on("error", (error) => {
        broken = true;
        const current = entry();
        if (current) {
          const buf =
            stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
          buf.spillPath = undefined;
          current.snapshot.errorText ??= bounded(
            `Full-log spill to ${spillPath} failed: ${boundedError(error)}`,
          );
        }
      });
      return {
        spillPath,
        file,
        write: (chunk: string) => {
          if (!broken) file.write(chunk);
        },
      };
    } catch {
      return undefined;
    }
  };

  const start = (options: StartOptions) =>
    Effect.gen(function* () {
      // Reserve synchronously (before the first yield inside doStart) so
      // parallel tool calls cannot race past the cap.
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({
              message: "Background terminal manager is shutting down.",
            });
          }
          if (runningCount() + reserved >= MAX_RUNNING) {
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} background terminals can run concurrently. Stop one with bg_kill before starting another.`,
            });
          }
          reserved++;
          return Effect.void;
        },
      );

      const doStart = Effect.gen(function* () {
        const { shell, args } = shellInvocation(options.command);
        const child = yield* Effect.try({
          try: () =>
            spawn(shell, args, {
              cwd: options.cwd,
              env: process.env,
              // stdin IGNORED: there is no input surface, ever. A process
              // that reads stdin sees EOF immediately.
              stdio: ["ignore", "pipe", "pipe"],
              // Own process group on POSIX → group kill takes the whole tree.
              detached: process.platform !== "win32",
            }),
          catch: (error) => new SpawnError({ message: boundedError(error) }),
        });

        const id = `bt-${++counter}`;
        const entryRef = () => entries.get(id);
        const stdoutSpill = makeSpill(entryRef, id, "stdout");
        const stderrSpill = makeSpill(entryRef, id, "stderr");
        const stdoutBuf = new OutputBuffer(
          RETAINED_PER_STREAM,
          stdoutSpill?.write,
        );
        const stderrBuf = new OutputBuffer(
          RETAINED_PER_STREAM,
          stderrSpill?.write,
        );
        stdoutBuf.spillPath = stdoutSpill?.spillPath;
        stderrBuf.spillPath = stderrSpill?.spillPath;

        const snapshot: MutableSnapshot = {
          id,
          command: options.command,
          title: options.title,
          cwd: options.cwd,
          pid: child.pid,
          status: "running",
          createdAt: Date.now(),
          get stdout() {
            return stdoutBuf.view();
          },
          get stderr() {
            return stderrBuf.view();
          },
        };

        const scope = yield* Scope.make();
        const entry: Entry = {
          snapshot,
          child,
          scope,
          stdoutBuf,
          stderrBuf,
          spillStreams: [stdoutSpill?.file, stderrSpill?.file].filter(
            (file): file is fs.WriteStream => file !== undefined,
          ),
          killRequested: false,
          exited: false,
          stdioClosed: false,
          closeWaiters: [],
        };

        // Plain-callback stream plumbing (the codex-backend precedent):
        // setEncoding's internal StringDecoder is multibyte-safe across
        // chunk boundaries.
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdoutBuf.push(chunk);
          notify(id);
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderrBuf.push(chunk);
          notify(id);
        });
        // Spawn failures (ENOENT etc.) arrive via 'error', not a throw.
        child.once("error", (error) => {
          snapshot.errorText ??= boundedError(error);
          entry.exited = true;
          settle(entry);
        });
        // Record code/signal on 'exit'; settle on 'close' so the completion
        // notification always carries the final flushed output.
        child.once("exit", (code, signal) => {
          entry.exited = true;
          snapshot.exitCode = code ?? undefined;
          snapshot.signal = signal ?? undefined;
        });
        child.once("close", (code, signal) => {
          entry.exited = true;
          entry.stdioClosed = true;
          snapshot.exitCode ??= code ?? undefined;
          snapshot.signal ??= signal ?? undefined;
          const waiters = entry.closeWaiters;
          entry.closeWaiters = [];
          for (const waiter of waiters) waiter();
          settle(entry);
        });

        // One teardown path: kill(), requestKill, pruning, disposeAll, and
        // runtime.dispose() all converge on closing this scope.
        yield* Scope.provide(
          Effect.addFinalizer(() =>
            Effect.promise(async () => {
              entry.killRequested ||= entry.snapshot.status === "running";
              await terminateChild(child, () => entry.exited);
              // Give stdio a bounded grace to flush + close, then force the
              // settle: a grandchild holding the pipe open (detached into a
              // new group) must not leave the entry "running" forever.
              if (!entry.stdioClosed) {
                await new Promise<void>((resolve) => {
                  if (entry.stdioClosed) return resolve();
                  const timer = setTimeout(resolve, CLOSE_GRACE_MS);
                  entry.closeWaiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                  });
                });
              }
              if (entry.snapshot.status === "running") {
                entry.snapshot.errorText ??=
                  "stdio did not close after termination; output may be incomplete";
                settle(entry);
              }
              closeSpillStreams(entry);
            }),
          ),
          scope,
        );

        entries.set(id, entry);
        notify(id);
        return snapshot as TerminalSnapshot;
      });

      return yield* doStart.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const status = (id: string) =>
    Effect.suspend(
      (): Effect.Effect<TerminalSnapshot, UnknownTerminalError> => {
        const entry = entries.get(id);
        if (!entry) {
          const known = [...entries.keys()];
          return new UnknownTerminalError({
            message: `Unknown terminal id "${id}". Known: ${known.join(", ") || "none"}.`,
          });
        }
        return Effect.succeed(entry.snapshot as TerminalSnapshot);
      },
    );

  /** Kill one running entry: flag first (so the exit reports "killed"), then
   * close the scope, whose finalizer terminates the tree and force-settles. */
  const killEntry = (entry: Entry) =>
    Effect.suspend(() => {
      if (entry.snapshot.status !== "running") return Effect.void;
      entry.killRequested = true;
      return closeEntryScope(entry).pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.ignore,
      );
    });

  const kill = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const running = unique
        .map((id) => entries.get(id))
        .filter(
          (entry): entry is Entry => entry?.snapshot.status === "running",
        );
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before signaling so this kill's settlements are not
      // ALSO queued as automatic follow-up messages to the model.
      addKillInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, killEntry, {
          concurrency: "unbounded",
        });
        // Resolve only after the exit/close events settled every snapshot.
        while (running.some((entry) => entry.snapshot.status === "running")) {
          yield* nextChange;
        }
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseKillInterest(runningIds);
            pruneSettled();
          }),
        ),
        Effect.map((): ReadonlyArray<KillResult> =>
          unique.map((id) => {
            const snapshot = entries.get(id)?.snapshot;
            return {
              id,
              title: snapshot?.title ?? "?",
              status: snapshot?.status ?? "killed",
              killed: runningIds.includes(id),
            };
          }),
        ),
      );
    });

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    const all = [...entries.values()];
    entries.clear();
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Pruning cleanups are detached; bound them like everything else so a
    // wedged process cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: TerminalReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestKill: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated kills are not "consumed": the killed result still flows
      // back to the model as a follow-up message (subagents precedent).
      runDetached(killEntry(entry).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return TerminalManager.of({
    start,
    status,
    kill,
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const TerminalManagerLive: Layer.Layer<TerminalManager> = Layer.effect(
  TerminalManager,
  makeManager,
);
