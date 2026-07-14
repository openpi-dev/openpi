/**
 * The async entry-point boundary: one ManagedRuntime shared by every tool
 * handler, disposed on session_shutdown (which runs the manager finalizer →
 * disposeAll → every process tree is killed).
 */

import { Cause, Exit, ManagedRuntime, type Effect } from "effect";
import { TerminalManagerLive } from "./manager.ts";

export function createTerminalRuntime() {
  return ManagedRuntime.make(TerminalManagerLive);
}

export type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;

/**
 * Run an effect from an async tool handler. Typed failures and defects are
 * converted to thrown Errors (what pi's tool contract expects); interruption
 * (tool AbortSignal) throws `interruptMessage`.
 */
export async function runTool<A, E>(
  runtime: TerminalRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
