/**
 * Domain model for background terminals.
 *
 * A "terminal" is one long-running shell process started by the model. It
 * receives no stdin (launched with stdin: "ignore"), captures stdout and
 * stderr separately, and settles exactly once into a final state.
 */

import { Data } from "effect";

export type TerminalStatus = "running" | "done" | "failed" | "killed";
// "done"   = exited with code 0
// "failed" = exited non-zero, or a spawn-level runtime error after start
// "killed" = terminated by bg_kill, the /ps UI, or session teardown

/** Read-only view over one captured output stream (stdout or stderr). */
export interface OutputView {
  /** Decoded, possibly head-trimmed text (bounded by the in-memory cap). */
  readonly text: string;
  /** True total bytes ever received on this stream. */
  readonly totalBytes: number;
  /** Bytes dropped from the head of the in-memory view (0 = complete). */
  readonly truncatedBytes: number;
  /** On-disk full capture; always the complete stream when spilling works. */
  readonly spillPath?: string;
}

export interface TerminalSnapshot {
  readonly id: string;
  /** Exactly the command line the model asked to run. */
  readonly command: string;
  /** Short model-provided name, shown in listings and the UI. */
  readonly title: string;
  /** Resolved absolute cwd the process runs in. */
  readonly cwd: string;
  /** Undefined only if spawn itself failed before a pid was assigned. */
  readonly pid?: number;
  readonly status: TerminalStatus;
  /** Date.now() at spawn. */
  readonly createdAt: number;
  /** Date.now() at settle (exit/kill). */
  readonly settledAt?: number;
  /** Set when the process exited via exit code (exactly one of exitCode/signal). */
  readonly exitCode?: number;
  /** Set when the process was terminated by a signal, e.g. "SIGTERM". */
  readonly signal?: string;
  /** Spawn error / kill-escalation notes, bounded. */
  readonly errorText?: string;
  readonly stdout: OutputView;
  readonly stderr: OutputView;
}

export function formatElapsed(snap: TerminalSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

/** "exit 0", "exit 137", "SIGTERM", or "running". */
export function formatExit(snap: TerminalSnapshot) {
  if (snap.status === "running") return "running";
  if (snap.signal) return snap.signal;
  if (snap.exitCode !== undefined) return `exit ${snap.exitCode}`;
  return snap.status;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class UnknownTerminalError extends Data.TaggedError(
  "UnknownTerminalError",
)<{
  readonly message: string;
}> {}
