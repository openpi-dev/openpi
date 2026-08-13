/**
 * Session liveness: whether ANY work is still in flight in this session —
 * the main agent streaming, background subagents, or workflows. The liveness
 * strip (session-liveness extension) animates while active and freezes when
 * everything settles, so a glance at the screen always answers "is the
 * session still running?" even when the main agent is idle behind detached
 * children (omp keeps its anchored HUD visibly alive the same way).
 *
 * Counters are merged here: subagents publishes its running count, workflows
 * publishes its own; the merged state is what consumers subscribe to.
 */

export interface SessionLiveness {
  readonly active: boolean;
  /** Compact human summary, e.g. "2 subagent · 1 workflow". */
  readonly detail: string;
  readonly runningSubagents: number;
  readonly runningWorkflows: number;
}

let runningSubagents = 0;
let runningWorkflows = 0;
let listeners: Array<(state: SessionLiveness) => void> = [];

function merged(): SessionLiveness {
  const parts: string[] = [];
  if (runningSubagents > 0) parts.push(`${runningSubagents} subagent`);
  if (runningWorkflows > 0) parts.push(`${runningWorkflows} workflow`);
  return {
    active: runningSubagents > 0 || runningWorkflows > 0,
    detail: parts.join(" · "),
    runningSubagents,
    runningWorkflows,
  };
}

function notify() {
  const state = merged();
  for (const listener of listeners) listener(state);
}

export function getSessionLiveness(): SessionLiveness {
  return merged();
}

export function setRunningSubagents(count: number): void {
  if (count === runningSubagents) return;
  runningSubagents = count;
  notify();
}

export function setRunningWorkflows(count: number): void {
  if (count === runningWorkflows) return;
  runningWorkflows = count;
  notify();
}

export function subscribeSessionLiveness(
  listener: (state: SessionLiveness) => void,
): () => void {
  listeners.push(listener);
  listener(merged());
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function resetSessionLiveness(): void {
  runningSubagents = 0;
  runningWorkflows = 0;
  listeners = [];
}
