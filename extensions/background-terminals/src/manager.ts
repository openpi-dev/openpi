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
import {
  Context,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  Scope,
} from "effect";
import {
  ConcurrencyLimitError,
  formatExit,
  SpawnError,
  UnknownTerminalError,
  type TerminalSnapshot,
  type TerminalStatus,
} from "./domain.ts";
import { OutputBuffer } from "./output.ts";

export const MAX_RUNNING = 8;
export const MAX_TRACKED = 32;
const MAX_SETTLED_HISTORY = MAX_TRACKED * 4;
/** In-memory retained cap per stream. */
export const RETAINED_PER_STREAM = 2 * 1024 * 1024;
/** Private full-log spills are bounded so a firehose cannot fill the temp disk. */
export const MAX_SPILL_BYTES_PER_STREAM = 256 * 1024 * 1024;
/** Aggregate private full-log budget across every terminal in one session. */
export const MAX_SPILL_BYTES_PER_SESSION = 512 * 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;
/** SIGTERM is normally enough; the second deadline covers a wedged process. */
const FORCE_KILL_AFTER_MS = 2_000;
const FORCE_CLOSE_WAIT_MS = 500;
/** After termination, how long to wait for the natural close→flush→settle
 * path before force-settling (a grandchild can hold the stdio pipes open). */
const SETTLE_GRACE_MS = 1_000;
/** Bound on waiting for spill WriteStreams to flush before settling; a hung
 * filesystem must not leave an exited entry "running" (and kill() waiting).
 * Terminate (≤2.5s) + settle grace (1s) + flush (1.5s) stays inside the 5s
 * scope-close bound, so teardown remains bounded end to end. */
const SPILL_FLUSH_TIMEOUT_MS = 1_500;
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

function appendSnapshotError(snapshot: MutableSnapshot, message: string) {
  snapshot.errorText = bounded(
    snapshot.errorText ? `${snapshot.errorText}; ${message}` : message,
  );
}

interface Entry {
  snapshot: MutableSnapshot;
  child: ChildProcess;
  scope: Scope.Closeable;
  stdoutBuf: OutputBuffer;
  stderrBuf: OutputBuffer;
  spillFiles: SpillFile[];
  /** Deadline won the race and initiated termination. */
  timedOut: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /** The child emitted 'error' (spawn failure etc.); settles as "failed".
   * Kept separate from errorText, which also carries non-fatal notes
   * (spill failures) that must not flip a clean exit to "failed". */
  processErrored: boolean;
  /** 'exit' event observed (code/signal recorded). */
  exited: boolean;
  /** 'close' event observed (stdio flushed; the settle trigger). */
  stdioClosed: boolean;
  /** A settle-after-spill-flush is in flight; don't start a second one. */
  settling: boolean;
  /** Scope termination is deciding whether a process-tree boundary was
   * actually reached. A concurrent close event must wait for that evidence. */
  terminationInFlight: boolean;
  /** At least one termination signal was sent to the child or its tree. */
  killSignaled: boolean;
  /** False when only a direct-child fallback was available or signaling
   * failed, so user-visible output must not claim a process-tree kill. */
  terminationConfirmed: boolean;
  /** A live target could not be terminated at the promised process-tree
   * boundary. This also covers the case where every signal attempt failed. */
  terminationFailed: boolean;
  /** The shell exited without stdio closing; a bounded scope close is queued
   * to reap descendants that still hold the inherited pipes open. */
  exitCleanupStarted: boolean;
  /** Completed exactly once when the entry settles. Kill callers and the scope
   * finalizer can all await the same result without missing a notification. */
  settled: Deferred.Deferred<void>;
}

interface SpillFile {
  readonly path: string;
  readonly file: fs.WriteStream;
  reservedBytes: number;
}

export interface StartOptions {
  readonly command: string;
  readonly title: string;
  readonly cwd: string;
  /** Optional runtime limit in seconds. Omit for an indefinite server/watcher. */
  readonly timeoutSeconds?: number;
}

export interface KillResult {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalStatus;
  /** True when the entry was still running when this kill began. */
  readonly wasRunning: boolean;
  /** True when this call initiated the termination AND the entry settled as
   * killed (a natural exit that won the race reports killed: false). */
  readonly killed: boolean;
  /** A kill was attempted, but the promised process-tree boundary could not
   * be confirmed. */
  readonly terminationFailed?: boolean;
  readonly errorText?: string;
  /** Final exit rendering ("exit 0", "SIGTERM", ...) captured at settle time,
   * so reports stay accurate even if the entry is pruned afterwards. */
  readonly exit: string;
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
  /**
   * Per-terminal raw output chunks, for bg_watch's mid-run matching. Separate
   * from subscribeTo: that fires on any change and carries no payload, while a
   * watcher needs the actual bytes as they stream.
   */
  subscribeToChunks(
    id: string,
    listener: (chunk: string, stream: "stdout" | "stderr") => void,
  ): () => void;
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

type ProcessSignalTarget = Pick<ChildProcess, "pid" | "kill">;
type TaskkillSpawner = (pid: number, force: boolean) => ChildProcess;

export type ProcessTreeSignalResult =
  | { readonly outcome: "sent" }
  | { readonly outcome: "already_exited"; readonly detail: string }
  | { readonly outcome: "fallback_sent"; readonly detail: string }
  | { readonly outcome: "failed"; readonly detail: string };

export type WindowsTaskkillResult =
  | {
      readonly outcome: "completed";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly outcome: "launch_failed"; readonly error: string }
  | { readonly outcome: "timed_out"; readonly timeoutMs: number };

function spawnTaskkill(pid: number, force: boolean) {
  return spawn(
    "taskkill",
    ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])],
    { stdio: "ignore", windowsHide: true },
  );
}

/** Resolve only after taskkill has either failed to launch or closed. */
export function waitForWindowsTaskkill(
  pid: number,
  force: boolean,
  launch: TaskkillSpawner = spawnTaskkill,
  timeoutMs = force ? FORCE_CLOSE_WAIT_MS : FORCE_KILL_AFTER_MS,
) {
  return new Promise<WindowsTaskkillResult>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = launch(pid, force);
    } catch (error) {
      resolve({ outcome: "launch_failed", error: boundedError(error) });
      return;
    }

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WindowsTaskkillResult) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      killer.off("error", onError);
      killer.off("close", onClose);
      resolve(result);
    };
    const onError = (error: Error) =>
      finish({ outcome: "launch_failed", error: boundedError(error) });
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) =>
      finish({ outcome: "completed", exitCode, signal });
    killer.once("error", onError);
    killer.once("close", onClose);
    timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {
        // The helper may already be gone; the bounded result stays the same.
      }
      finish({ outcome: "timed_out", timeoutMs });
    }, timeoutMs);
  });
}

function directSignal(
  child: ProcessSignalTarget,
  signal: NodeJS.Signals,
  targetExited: () => boolean,
  detail: string,
): ProcessTreeSignalResult {
  if (targetExited()) return { outcome: "already_exited", detail };
  try {
    if (child.kill(signal)) return { outcome: "fallback_sent", detail };
    if (targetExited()) return { outcome: "already_exited", detail };
    return {
      outcome: "failed",
      detail: `${detail}; direct child signal returned false`,
    };
  } catch (error) {
    if (targetExited()) return { outcome: "already_exited", detail };
    return {
      outcome: "failed",
      detail: `${detail}; direct child signal failed: ${boundedError(error)}`,
    };
  }
}

/** Windows process-tree signaling with explicit taskkill and fallback evidence. */
export async function signalWindowsProcessTree(
  child: ProcessSignalTarget,
  signal: NodeJS.Signals,
  targetExited: () => boolean,
  launch: TaskkillSpawner = spawnTaskkill,
): Promise<ProcessTreeSignalResult> {
  if (targetExited()) {
    return {
      outcome: "already_exited",
      detail: "target exited before taskkill started",
    };
  }
  if (!child.pid) {
    return directSignal(
      child,
      signal,
      targetExited,
      "taskkill unavailable because the child has no pid",
    );
  }

  const attempt = await waitForWindowsTaskkill(
    child.pid,
    signal === "SIGKILL",
    launch,
  );
  if (attempt.outcome === "completed" && attempt.exitCode === 0) {
    return { outcome: "sent" };
  }
  const detail =
    attempt.outcome === "launch_failed"
      ? `taskkill failed to launch: ${attempt.error}`
      : attempt.outcome === "timed_out"
        ? `taskkill timed out after ${attempt.timeoutMs}ms`
        : `taskkill exited ${attempt.exitCode ?? "without a code"}${attempt.signal ? ` (${attempt.signal})` : ""}`;
  return directSignal(child, signal, targetExited, detail);
}

/** Signal the whole process group on POSIX so descendants (servers a shell
 * command spawned) die with it; return exact evidence for every fallback. */
function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  targetExited: () => boolean,
) {
  if (process.platform === "win32") {
    return Effect.promise(() =>
      signalWindowsProcessTree(child, signal, targetExited),
    );
  }
  return Effect.sync((): ProcessTreeSignalResult => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
        return { outcome: "sent" };
      } catch (error) {
        return directSignal(
          child,
          signal,
          targetExited,
          `process-group ${signal} failed: ${boundedError(error)}`,
        );
      }
    }
    return directSignal(
      child,
      signal,
      targetExited,
      "process-group signal unavailable because the child has no pid",
    );
  });
}

/** Await stdio closure without retaining a listener after interruption. */
function awaitChildClose(child: ChildProcess, closed: () => boolean) {
  return Effect.callback<void>((resume) => {
    if (closed()) {
      resume(Effect.void);
      return;
    }
    const onClose = () => resume(Effect.void);
    child.once("close", onClose);
    return Effect.sync(() => child.off("close", onClose));
  });
}

/** SIGTERM → deadline → SIGKILL; waits for stdio closure rather than only the
 * shell's exit because descendants can keep the inherited pipes and process
 * group alive after the shell itself is gone. */
function terminateChild(
  child: ChildProcess,
  closed: () => boolean,
  targetExited: () => boolean,
) {
  return Effect.suspend(() => {
    if (closed()) {
      return Effect.succeed({
        signalSent: false,
        treeConfirmed: true,
        terminationFailed: false,
        detail: undefined as string | undefined,
      });
    }
    const liveAtStart = !targetExited();
    return Effect.gen(function* () {
      const attempts: ProcessTreeSignalResult[] = [];
      const gracefulDeadline = Date.now() + FORCE_KILL_AFTER_MS;
      attempts.push(yield* signalProcessTree(child, "SIGTERM", targetExited));
      yield* awaitChildClose(child, closed).pipe(
        Effect.timeout(Math.max(0, gracefulDeadline - Date.now())),
        Effect.ignore,
      );
      if (!closed()) {
        const forceDeadline = Date.now() + FORCE_CLOSE_WAIT_MS;
        attempts.push(yield* signalProcessTree(child, "SIGKILL", targetExited));
        yield* awaitChildClose(child, closed).pipe(
          Effect.timeout(Math.max(0, forceDeadline - Date.now())),
          Effect.ignore,
        );
      }
      const signalSent = attempts.some(
        (attempt) =>
          attempt.outcome === "sent" || attempt.outcome === "fallback_sent",
      );
      const treeConfirmed = attempts.some(
        (attempt) => attempt.outcome === "sent",
      );
      const detail = attempts
        .flatMap((attempt) => ("detail" in attempt ? [attempt.detail] : []))
        .join("; ");
      return {
        signalSent: liveAtStart && signalSent,
        treeConfirmed,
        terminationFailed:
          liveAtStart && !treeConfirmed && (signalSent || !targetExited()),
        detail: detail || undefined,
      };
    });
  });
}

// --- Implementation --------------------------------------------------------------

function* makeManager(maxSpillBytesPerSession: number) {
  // Scoped detached forker for sync contexts (read-model kills, process-event
  // settlement, pruning). Completed fibers remove themselves; manager scope
  // close interrupts any work that outlives the bounded disposeAll wait.
  const cleanupFibers = yield* FiberSet.make();
  const runCleanup = yield* FiberSet.runtime(cleanupFibers)();

  const entries = new Map<string, Entry>();
  /** Small immutable tombstones preserve truthful kill reports if pruning
   * races the tool boundary after an id was validated. */
  const settledHistory = new Map<
    string,
    Pick<
      KillResult,
      "title" | "status" | "exit" | "terminationFailed" | "errorText"
    >
  >();
  /** ids with an in-flight kill() collecting the result (settle → consumed). */
  const killInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  const idListeners = new Map<string, Set<() => void>>();
  /** bg_watch chunk listeners, keyed by terminal id. */
  const chunkListeners = new Map<
    string,
    Set<(chunk: string, stream: "stdout" | "stderr") => void>
  >();
  let counter = 0;
  let reserved = 0;
  let disposed = false;
  let spillDir: string | undefined | null;
  let sessionSpillBytes = 0;
  let onSettled:
    | ((snap: TerminalSnapshot, consumed: boolean) => void)
    | undefined;

  const notify = (id?: string) => {
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

  /**
   * Fan out a raw output chunk to bg_watch listeners. Purely additive next to
   * notify(): a throwing watcher must never corrupt stream/lifecycle state.
   */
  const emitChunk = (
    id: string,
    chunk: string,
    stream: "stdout" | "stderr",
  ) => {
    const set = chunkListeners.get(id);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(chunk, stream);
      } catch {
        // A failed watcher must not break output capture.
      }
    }
  };

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

  const removeEntrySpills = (entry: Entry) =>
    Effect.sync(() => {
      for (const spill of entry.spillFiles) {
        try {
          fs.rmSync(spill.path, { force: true });
        } catch {
          // Retain the reservation when deletion fails. The session budget
          // remains fail-closed and disposeAll still removes the private dir.
        }
        if (!fs.existsSync(spill.path)) {
          sessionSpillBytes = Math.max(
            0,
            sessionSpillBytes - spill.reservedBytes,
          );
          spill.reservedBytes = 0;
        }
      }
      entry.stdoutBuf.spillPath = undefined;
      entry.stderrBuf.spillPath = undefined;
    });

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
      runCleanup(
        closeEntryScope(entry).pipe(Effect.andThen(removeEntrySpills(entry))),
      );
    }
  };

  /** End all spill streams; resolves when their buffers are flushed to disk
   * (bounded), so a settle notification never points at a partial file. */
  const flushSpillStreams = (entry: Entry) => {
    const streams = entry.spillFiles
      .map((spill) => spill.file)
      .filter((stream) => !stream.writableEnded);
    return Effect.forEach(
      streams,
      (stream) =>
        Effect.callback<void>((resume) => {
          const done = () => resume(Effect.void);
          try {
            stream.end(done);
          } catch {
            // Best effort; tmpdir contents are disposable.
            done();
          }
        }),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.timeoutOrElse({
        duration: SPILL_FLUSH_TIMEOUT_MS,
        orElse: () =>
          Effect.sync(() => {
            entry.stdoutBuf.spillPath = undefined;
            entry.stderrBuf.spillPath = undefined;
            appendSnapshotError(
              entry.snapshot,
              "Full-log spill flush timed out; full output may be incomplete",
            );
          }),
      }),
    );
  };

  /** Single settle path — idempotent; kill vs natural exit vs error races are
   * resolved by whichever lands first (the second call is a no-op). */
  const settle = (entry: Entry) => {
    const s = entry.snapshot;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    s.status = entry.timedOut
      ? "timed_out"
      : entry.killSignaled
        ? entry.terminationConfirmed
          ? "killed"
          : "failed"
        : entry.processErrored
          ? "failed"
          : s.exitCode === 0
            ? "done"
            : "failed";
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.timeoutTimer = undefined;
    settledHistory.set(s.id, {
      title: s.title,
      status: s.status,
      exit: formatExit(s),
      terminationFailed:
        entry.terminationFailed ||
        (entry.killSignaled && !entry.terminationConfirmed),
      errorText: s.errorText,
    });
    while (settledHistory.size > MAX_SETTLED_HISTORY) {
      const oldest = settledHistory.keys().next().value;
      if (oldest === undefined) break;
      settledHistory.delete(oldest);
    }
    // Completing the Deferred can immediately resume kill waiters, whose
    // ensuring blocks release interest. Snapshot consumption first so the
    // settle hook observes the interest that existed when settlement won.
    const consumed = (killInterest.get(s.id) ?? 0) > 0;
    Deferred.doneUnsafe(entry.settled, Effect.void);
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(s, consumed);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  /** Flush the spill files, then settle: the completion follow-up (and the
   * kill() resolution) reference the spill path, so the full capture must be
   * on disk before anyone is told about it. Idempotent via `settling`. */
  const settleAfterFlush = (entry: Entry) => {
    if (entry.settling || entry.snapshot.status !== "running") return;
    entry.settling = true;
    runCleanup(
      flushSpillStreams(entry).pipe(
        Effect.andThen(Effect.sync(() => settle(entry))),
      ),
    );
  };

  const scheduleExitCleanup = (entry: Entry) => {
    if (entry.exitCleanupStarted) return;
    entry.exitCleanupStarted = true;
    runCleanup(
      Effect.sleep(SETTLE_GRACE_MS).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            entry.snapshot.status === "running" && !entry.stdioClosed
              ? closeEntryScope(entry).pipe(
                  Effect.timeout(STOP_TIMEOUT_MS),
                  Effect.ignore,
                )
              : Effect.void,
          ),
        ),
      ),
    );
  };

  const resolveSpillDir = () => {
    if (spillDir !== undefined) return spillDir ?? undefined;
    try {
      const base = path.join(os.tmpdir(), "pi-background-terminals");
      fs.mkdirSync(base, { recursive: true, mode: 0o700 });
      fs.chmodSync(base, 0o700);
      spillDir = fs.mkdtempSync(path.join(base, "session-"));
      fs.chmodSync(spillDir, 0o700);
    } catch {
      spillDir = null;
    }
    return spillDir ?? undefined;
  };

  const makeSpill = (
    entry: () => Entry | undefined,
    id: string,
    stream: "stdout" | "stderr",
    resumeSource: () => void,
  ) => {
    const dir = resolveSpillDir();
    if (!dir) return undefined;
    const spillPath = path.join(dir, `${id}.${stream}.log`);
    try {
      const file = fs.createWriteStream(spillPath, {
        flags: "a",
        mode: 0o600,
      });
      const spillFile: SpillFile = {
        path: spillPath,
        file,
        reservedBytes: 0,
      };
      let broken = false;
      let capped = false;
      const markUnavailable = (message: string) => {
        capped = true;
        const current = entry();
        if (!current) return;
        const buf = stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
        buf.spillPath = undefined;
        appendSnapshotError(current.snapshot, message);
      };
      file.on("error", (error) => {
        broken = true;
        resumeSource();
        const current = entry();
        if (current) {
          const buf =
            stream === "stdout" ? current.stdoutBuf : current.stderrBuf;
          buf.spillPath = undefined;
          appendSnapshotError(
            current.snapshot,
            `Full-log spill to ${spillPath} failed: ${boundedError(error)}`,
          );
        }
      });
      return {
        spillPath,
        file,
        spillFile,
        write: (chunk: string) => {
          // writableEnded guard: late 'data' after the settle flush must not
          // error the ended stream (and falsely report the spill as broken).
          if (broken || capped || file.writableEnded) return true;
          const chunkBytes = Buffer.byteLength(chunk, "utf8");
          if (
            spillFile.reservedBytes + chunkBytes >
            MAX_SPILL_BYTES_PER_STREAM
          ) {
            markUnavailable(
              `Complete ${stream} log is unavailable: the per-stream spill limit of ${MAX_SPILL_BYTES_PER_STREAM} bytes would be exceeded`,
            );
            return true;
          }
          if (sessionSpillBytes + chunkBytes > maxSpillBytesPerSession) {
            markUnavailable(
              `Complete ${stream} log is unavailable: the session spill budget of ${maxSpillBytesPerSession} bytes would be exceeded`,
            );
            return true;
          }
          spillFile.reservedBytes += chunkBytes;
          sessionSpillBytes += chunkBytes;
          const accepted = file.write(chunk);
          if (!accepted) file.once("drain", resumeSource);
          return accepted;
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
        const stdoutSpill = makeSpill(entryRef, id, "stdout", () =>
          child.stdout?.resume(),
        );
        const stderrSpill = makeSpill(entryRef, id, "stderr", () =>
          child.stderr?.resume(),
        );
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
          timeoutAt:
            options.timeoutSeconds === undefined
              ? undefined
              : Date.now() + options.timeoutSeconds * 1_000,
          get stdout() {
            return stdoutBuf.view();
          },
          get stderr() {
            return stderrBuf.view();
          },
        };

        const scope = yield* Scope.make();
        const settled = yield* Deferred.make<void>();
        const entry: Entry = {
          snapshot,
          child,
          scope,
          stdoutBuf,
          stderrBuf,
          spillFiles: [stdoutSpill?.spillFile, stderrSpill?.spillFile].filter(
            (file): file is SpillFile => file !== undefined,
          ),
          killSignaled: false,
          timedOut: false,
          processErrored: false,
          exited: false,
          stdioClosed: false,
          settling: false,
          terminationInFlight: false,
          terminationConfirmed: false,
          terminationFailed: false,
          exitCleanupStarted: false,
          settled,
        };

        if (options.timeoutSeconds !== undefined) {
          entry.timeoutTimer = setTimeout(() => {
            if (entry.snapshot.status !== "running") return;
            // If the shell exited naturally just before the deadline, preserve
            // that result; bounded exit cleanup will reap descendants holding
            // inherited stdio open.
            if (entry.exited) return;
            entry.timedOut = true;
            runCleanup(
              closeEntryScope(entry).pipe(
                Effect.timeout(STOP_TIMEOUT_MS),
                Effect.ignore,
              ),
            );
          }, options.timeoutSeconds * 1_000);
          entry.timeoutTimer.unref?.();
        }

        // Plain-callback stream plumbing (the codex-backend precedent):
        // setEncoding's internal StringDecoder is multibyte-safe across
        // chunk boundaries.
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          if (!stdoutBuf.push(chunk)) child.stdout?.pause();
          notify(id);
          emitChunk(id, chunk, "stdout");
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (!stderrBuf.push(chunk)) child.stderr?.pause();
          notify(id);
          emitChunk(id, chunk, "stderr");
        });
        // Spawn failures (ENOENT etc.) arrive via 'error', not a throw. Node
        // still emits 'close' afterwards (with a bogus errno as code), so
        // record the failure here and let the close path do the one settle.
        child.once("error", (error) => {
          entry.processErrored = true;
          snapshot.errorText ??= boundedError(error);
          entry.exited = true;
          settleAfterFlush(entry);
        });
        // Record code/signal on 'exit'; settle on 'close' so the completion
        // notification always carries the final flushed output.
        child.once("exit", (code, signal) => {
          entry.exited = true;
          snapshot.exitCode = code ?? undefined;
          snapshot.signal = signal ?? undefined;
          // A descendant can keep the pipes open after the shell exits. Give
          // close a short natural grace, then close the scope to terminate
          // the surviving process group and force a bounded settlement.
          scheduleExitCleanup(entry);
        });
        child.once("close", (code, signal) => {
          entry.exited = true;
          entry.stdioClosed = true;
          // Only trust close's code/signal when 'exit' never fired (a spawn
          // 'error' close reports the errno, e.g. -2, as its code).
          if (!entry.processErrored) {
            snapshot.exitCode ??= code ?? undefined;
            snapshot.signal ??= signal ?? undefined;
          }
          if (!entry.terminationInFlight) settleAfterFlush(entry);
        });

        // One teardown path: kill(), requestKill, pruning, disposeAll, and
        // runtime.dispose() all converge on closing this scope.
        yield* Scope.provide(
          Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // Defer a concurrent close settlement until the awaited helper
              // result tells us whether the process-tree promise was met.
              entry.terminationInFlight = true;
              const termination = yield* terminateChild(
                child,
                () => entry.stdioClosed,
                () => entry.exited,
              );
              entry.killSignaled ||=
                !entry.timedOut &&
                termination.signalSent &&
                entry.snapshot.status === "running";
              entry.terminationConfirmed ||=
                termination.signalSent && termination.treeConfirmed;
              entry.terminationFailed ||=
                !entry.timedOut && termination.terminationFailed;
              if (
                !termination.treeConfirmed &&
                termination.detail &&
                (termination.signalSent || !entry.exited)
              ) {
                appendSnapshotError(
                  entry.snapshot,
                  `Process-tree termination could not be confirmed: ${termination.detail}`,
                );
              }
              entry.terminationInFlight = false;
              if (
                entry.stdioClosed &&
                entry.snapshot.status === "running" &&
                !entry.settling
              ) {
                settleAfterFlush(entry);
              }
              // Give the natural close→flush→settle path a bounded grace,
              // then force the settle: a grandchild holding the pipe open
              // (detached into a new group) must not leave the entry
              // "running" forever.
              if (entry.snapshot.status === "running") {
                yield* Deferred.await(entry.settled).pipe(
                  Effect.timeout(SETTLE_GRACE_MS),
                  Effect.ignore,
                );
              }
              if (entry.snapshot.status === "running" && !entry.settling) {
                // Force the settle ourselves. When `settling` is set, the
                // close path's flush→settle is already in flight (bounded by
                // SPILL_FLUSH_TIMEOUT_MS) — settling here first would cite a
                // spill file that is still being flushed.
                if (!entry.stdioClosed) {
                  appendSnapshotError(
                    entry.snapshot,
                    "stdio did not close after termination; process state and output may be incomplete",
                  );
                }
                entry.settling = true;
                yield* flushSpillStreams(entry);
                settle(entry);
              }
            }),
          ),
          scope,
        );

        // disposeAll may have swept the entries map while we were setting up;
        // an entry added after the sweep would never be torn down. Close our
        // own scope (kills the child) and fail instead (subagents precedent).
        if (disposed) {
          yield* closeEntryScope(entry);
          return yield* new SpawnError({
            message: "Background terminal manager shut down while starting.",
          });
        }
        entries.set(id, entry);
        notify(id);
        return snapshot as TerminalSnapshot;
      });

      // Uninterruptible: between spawn() and entries.set there must be no
      // window where an interrupt (tool abort, runtime dispose) leaves a
      // live child that no scope/registry knows about. All steps are sync.
      return yield* doStart.pipe(
        Effect.uninterruptible,
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

  /** Kill one running entry: close the scope — whose finalizer marks the kill
   * at the signal point, terminates the tree, and force-settles —
   * in a DETACHED fiber. Once the flag is set the termination must actually
   * happen; a tool abort interrupting the caller cannot cancel it (this is
   * what makes "termination continues in the background" truthful). */
  const killEntry = (entry: Entry) =>
    Effect.sync(() => {
      if (entry.snapshot.status !== "running") return;
      runCleanup(
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      );
    });

  const kill = (ids: ReadonlyArray<string>) =>
    Effect.suspend(() => {
      const unique = [...new Set(ids)];
      const byId = new Map(
        unique
          .map((id) => entries.get(id))
          .filter((entry): entry is Entry => entry !== undefined)
          .map((entry) => [entry.snapshot.id, entry]),
      );
      const running = [...byId.values()].filter(
        (entry) => entry.snapshot.status === "running",
      );
      const runningIds = running.map((entry) => entry.snapshot.id);
      // Mark consumed before signaling so this kill's settlements are not
      // ALSO queued as automatic follow-up messages to the model.
      addKillInterest(runningIds);
      const work = Effect.gen(function* () {
        yield* Effect.forEach(running, killEntry, {
          concurrency: "unbounded",
        });
        // Every caller waits on the entries that were running when its kill
        // began. Deferred completion cannot be missed and supports concurrent
        // overlapping/multi-id kill calls.
        yield* Effect.forEach(
          running,
          (entry) => Deferred.await(entry.settled),
          { concurrency: "unbounded", discard: true },
        );
        // Capture the report BEFORE the ensuring below releases interest and
        // prunes — a just-settled entry must not vanish out from under it.
        return unique.map((id): KillResult => {
          const sourceEntry = byId.get(id);
          const snapshot = sourceEntry?.snapshot;
          const history = settledHistory.get(id);
          const status = snapshot?.status ?? history?.status ?? "killed";
          const wasRunning = runningIds.includes(id);
          const terminationFailed = sourceEntry
            ? sourceEntry.terminationFailed ||
              (sourceEntry.killSignaled && !sourceEntry.terminationConfirmed)
            : history?.terminationFailed;
          return {
            id,
            title: snapshot?.title ?? history?.title ?? "?",
            status,
            wasRunning,
            // A natural exit can win the race with our SIGTERM; report what
            // actually happened rather than claiming the kill did it.
            killed: wasRunning && status === "killed",
            terminationFailed,
            errorText: snapshot?.errorText ?? history?.errorText,
            exit: snapshot
              ? formatExit(snapshot)
              : (history?.exit ?? "unknown"),
          };
        });
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseKillInterest(runningIds);
            pruneSettled();
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
    // Detached kill/prune/flush work is scoped to the manager. Wait for it
    // within the shutdown bound; the FiberSet finalizer interrupts anything
    // still live when the manager scope closes, so cleanup cannot leak.
    yield* FiberSet.awaitEmpty(cleanupFibers).pipe(
      Effect.timeout(STOP_TIMEOUT_MS),
      Effect.ignore,
    );
    yield* Effect.sync(() => {
      const dir = spillDir;
      spillDir = null;
      sessionSpillBytes = 0;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
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
    subscribeToChunks: (id, listener) => {
      let set = chunkListeners.get(id);
      if (!set) {
        set = new Set();
        chunkListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) chunkListeners.delete(id);
      };
    },
    requestKill: (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      // UI-initiated kills are not "consumed": the killed result still flows
      // back to the model as a follow-up message (subagents precedent).
      runCleanup(killEntry(entry).pipe(Effect.ignore));
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
}

export function makeTerminalManagerLive(
  maxSpillBytesPerSession = MAX_SPILL_BYTES_PER_SESSION,
) {
  return Layer.effect(
    TerminalManager,
    Effect.gen(() => makeManager(maxSpillBytesPerSession)),
  );
}

export const TerminalManagerLive: Layer.Layer<TerminalManager> = Layer.effect(
  TerminalManager,
  Effect.gen(() => makeManager(MAX_SPILL_BYTES_PER_SESSION)),
);
