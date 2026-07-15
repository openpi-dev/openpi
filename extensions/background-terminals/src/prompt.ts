/** All model-facing strings for the background-terminals tools. */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { formatElapsed, formatExit, type TerminalSnapshot } from "./domain.ts";
import { MAX_RUNNING, type KillResult } from "./manager.ts";

/** bg_status stdout tail. */
export const STATUS_STDOUT_MAX = 16 * 1024;
/** bg_status stderr tail. */
export const STATUS_STDERR_MAX = 8 * 1024;
/** Completion follow-up stdout tail. Keep this concise; /ps has the detailed view. */
export const RESULT_STDOUT_MAX = 8 * 1024;
/** Completion follow-up stderr tail. Keep this concise; /ps has the detailed view. */
export const RESULT_STDERR_MAX = 4 * 1024;
const STATUS_STDOUT_MAX_LINES = 400;
const STATUS_STDERR_MAX_LINES = 200;
const RESULT_STDOUT_MAX_LINES = 40;
const RESULT_STDERR_MAX_LINES = 20;

export const BG_START_TOOL_DESCRIPTION =
  "Start a long-running shell command as a background terminal (executed via the platform shell — sh -c on POSIX, cmd.exe /d /s /c on Windows). " +
  "Fire-and-forget: this returns immediately with an id, and you get a message with the final output when the process exits. " +
  "The process receives NO stdin (immediate EOF) and there is no way to send input later — interactive commands will not work; use bg_kill to stop a stuck one. " +
  `Terminals are session-scoped: they are killed when the session ends or reloads. Output shown to you is tail-truncated (stdout ${formatSize(STATUS_STDOUT_MAX)}, stderr ${formatSize(STATUS_STDERR_MAX)}); the full logs are captured to files and in the /ps viewer. ` +
  `Max ${MAX_RUNNING} background terminals can run at once.`;

export const BG_START_PROMPT_SNIPPET =
  "Run a long-lived shell command in the background (dev servers, builds, watchers); output is captured and you're notified on exit";

export const BG_START_PROMPT_GUIDELINES = [
  "Use bg_start for commands expected to run long or indefinitely (servers, watch modes, long builds); use the regular bash tool for quick commands.",
  "bg_start processes receive no stdin — never start a command that requires interactive input.",
  "After bg_start, keep working; the exit result arrives automatically. Use bg_status only when you need current output before continuing.",
];

export const BG_START_PARAMETER_DESCRIPTIONS = {
  command:
    "Shell command line to run in the background (sh -c on POSIX, cmd.exe /d /s /c on Windows). It receives no stdin (EOF immediately); interactive commands will not work.",
  title: "Short human-readable name shown in listings and the UI",
  workingDir: "Working directory (default: current working directory)",
};

export const BG_STATUS_TOOL_DESCRIPTION =
  "Peek at a background terminal's status and current output (tail-truncated) without blocking. If the terminal already exited, this returns its final state.";

export const BG_STATUS_PARAMETER_DESCRIPTIONS = {
  id: 'Terminal id, e.g. "bt-1"',
};

export const BG_LIST_TOOL_DESCRIPTION =
  "List all background terminals (running and settled) with pid, elapsed time, exit status, and output sizes.";

export const BG_KILL_TOOL_DESCRIPTION =
  "Stop one or more running background terminals (SIGTERM to the whole process tree, escalating to SIGKILL). Returns each terminal's final state; already-settled ids are reported as such.";

export const BG_KILL_PARAMETER_DESCRIPTIONS = {
  ids: 'Terminal ids to stop, e.g. ["bt-1"]',
};

export function buildStartResult(snap: TerminalSnapshot) {
  return (
    `Started background terminal ${snap.id} "${snap.title}" (pid ${snap.pid ?? "?"}, ${snap.cwd}).\n` +
    `It runs in the background with no stdin. You'll get a message when it exits, ` +
    `or use bg_status(id: "${snap.id}") to peek, bg_kill to stop it, bg_list to see all.`
  );
}

/** One metadata line: `bt-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path)`. */
export function describeTerminal(snap: TerminalSnapshot) {
  const details = [
    `pid ${snap.pid ?? "?"}`,
    formatElapsed(snap),
    snap.status === "running" ? "exit -" : formatExit(snap),
    snap.cwd,
    `stdout ${formatSize(snap.stdout.totalBytes)}, stderr ${formatSize(snap.stderr.totalBytes)}`,
  ];
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

/** Tail-truncated labeled output section with a pointer at the full log. */
function outputSection(
  label: string,
  view: TerminalSnapshot["stdout"],
  maxBytes: number,
  maxLines: number,
) {
  if (view.totalBytes === 0) return `${label}: (empty)`;
  const truncation = truncateTail(view.text, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(maxLines, DEFAULT_MAX_LINES),
  });
  let text = `${label}:\n${truncation.content}`;
  const shownBytes = truncation.outputBytes;
  if (truncation.truncated || view.truncatedBytes > 0) {
    const where = view.spillPath
      ? `Full log: ${view.spillPath}`
      : "Full output in the /ps viewer";
    text += `\n[${label} truncated: showing last ${formatSize(shownBytes)} of ${formatSize(view.totalBytes)}. ${where}]`;
  }
  return text;
}

export function buildStatusResult(snap: TerminalSnapshot) {
  let text = describeTerminal(snap);
  if (snap.errorText) text += `\nError: ${snap.errorText}`;
  text += `\n\n${outputSection("stdout", snap.stdout, STATUS_STDOUT_MAX, STATUS_STDOUT_MAX_LINES)}`;
  text += `\n\n${outputSection("stderr", snap.stderr, STATUS_STDERR_MAX, STATUS_STDERR_MAX_LINES)}`;
  return text;
}

/** The async completion follow-up injected into the model's context. */
export function buildTerminalResultMessage(snap: TerminalSnapshot) {
  const how =
    snap.status === "killed" ? "was killed" : `exited (${formatExit(snap)})`;
  let text = `Background terminal ${snap.id} "${snap.title}" ${how} after ${formatElapsed(snap)}.`;
  if (snap.errorText) text += `\nError: ${snap.errorText}`;
  text += `\n\n${outputSection("stdout", snap.stdout, RESULT_STDOUT_MAX, RESULT_STDOUT_MAX_LINES)}`;
  if (snap.stderr.totalBytes > 0) {
    text += `\n\n${outputSection("stderr", snap.stderr, RESULT_STDERR_MAX, RESULT_STDERR_MAX_LINES)}`;
  }
  return text;
}

export function buildKillReport(results: ReadonlyArray<KillResult>) {
  return results
    .map((entry) => {
      if (entry.killed) {
        return `Killed ${entry.id} "${entry.title}" (${entry.exit}).`;
      }
      if (entry.wasRunning) {
        // The natural exit won the race with the kill signal.
        return `${entry.id} "${entry.title}" exited on its own before the kill landed (${entry.exit}).`;
      }
      return `${entry.id} "${entry.title}" was already ${entry.status} (${entry.exit}).`;
    })
    .join("\n");
}
