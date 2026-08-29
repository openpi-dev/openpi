/**
 * Layer composition and the async entry-point boundary.
 *
 * Everything inside the extension is Effect generators; this module is where
 * tool handlers (plain async functions) run those effects against one shared
 * ManagedRuntime.
 */

import { Cause, Exit, Layer, ManagedRuntime, type Effect } from "effect";
import { BackendRegistry, type SubagentBackend } from "./backend.ts";
import { piBackend } from "./backends/pi.ts";
import type { BackendName } from "./domain.ts";

/**
 * Test-only injection seam for extension-level tests that drive real spawns
 * without a child pi session: production never sets it. The underscore-prefixed
 * setter name makes any accidental production use self-evidently wrong.
 */
let testBackends: readonly SubagentBackend[] | undefined;

/** Test-only: replace the backends the manager can spawn against. */
export function __setSubagentTestBackends(
  backends: readonly SubagentBackend[] | undefined,
) {
  testBackends = backends;
}

const BackendRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: readonly SubagentBackend[] = testBackends ?? [piBackend];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

import {
  makeSubagentManagerLayer,
  type SubagentManagerConfig,
} from "./manager.ts";

export function createSubagentRuntime(config: SubagentManagerConfig = {}) {
  return ManagedRuntime.make(
    makeSubagentManagerLayer(config).pipe(Layer.provide(BackendRegistryLive)),
  );
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>;

/**
 * Run an effect from an async tool handler. Typed failures and defects are
 * converted to thrown Errors (what pi's tool contract expects); interruption
 * (tool AbortSignal) throws `interruptMessage`.
 */
export async function runTool<A, E>(
  runtime: SubagentRuntime,
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
