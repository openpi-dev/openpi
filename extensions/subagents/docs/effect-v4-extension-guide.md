# Building a pi extension on the Effect v4 setup

> Practical, migration-oriented companion to [`effect-v4-notes.md`](./effect-v4-notes.md).
> That file is the Effect API cheat-sheet (v3→v4 renames, child processes, concurrency);
> **this** file is how to stand up _one pi extension_ on the same toolchain and where to
> draw the line between "wrap in Effect" and "leave as plain TS".
>
> The API examples originated against the July 2026 Effect v4 beta toolchain. The current
> dependency versions and all install/check commands are centralized in the repository root;
> treat the root `package.json`, lockfile, and `tsconfig.json` as canonical.
>
> Audience: the agents migrating `ask-user`, `model-info`, `git-info`,
> `ui-customization`, and `copy-all`.

---

## 0. The one rule: Effect is for the async core, not the whole file

A pi extension's public surface is **plain callbacks** the host calls:
`export default function (pi: ExtensionAPI)`, `pi.registerTool({ …, async execute() })`,
`pi.registerCommand`, `pi.on(...)`, renderers. None of that changes. Effect lives _inside_
those callbacks — you run an effect at the top of `execute` and return its value.

Reach for Effect only where you actually get something from it:

- **Yes:** async work that needs typed errors, cancellation via the tool `AbortSignal`,
  timeouts, retries/polling, or a resource whose lifetime must outlive one call
  (child process, subscription) → child processes (`git-info`, `copy-all`),
  git/gh polling (`git-info`).
- **No / barely:** pure TUI popups and rendering (`ask-user`, `ui-customization`),
  cross-extension channel plumbing, cost/token bookkeeping (`model-info`). These are
  synchronous or already-Promise UI code; wrapping them in Effect adds ceremony and no
  safety. Migrate them by keeping the logic and only touching whatever genuinely async
  part benefits (usually nothing).

If an extension has no async core worth typing, the "migration" may be just adopting the
toolchain (§1) and leaving the body plain. Don't invent an Effect layer to have one.

---

## 1. Repository-level toolchain

The repository now has one npm package and one dependency tree. Declare `effect`,
`@effect/platform-node`, `@effect/tsgo`, and TypeScript only in the root `package.json`;
do not recreate extension-local manifests, lockfiles, or `node_modules`.

The root `tsconfig.json` owns the Effect language-service plugin, the shared strict
compiler options, and the project scope. Its `extensions/**/*.ts` and `tests/**/*.ts`
includes cover production sources and tests respectively, so do not add extension-local
`tsconfig.json` files. Run typechecking through the root `bun run check` command.

Keep local `.ts` imports written **with the `.ts` extension** (`./src/manager.ts`), matching
the house style.

### The LSP / language-service, precisely

- `typescript@7` is the native TypeScript implementation used by `bun run typecheck`.
- The root `prepare` script patches the Effect Language Service into TypeScript when the
  development-only `@effect/tsgo` package is installed. It exits cleanly for production
  installs that omit dev dependencies.
- The root plugin configuration keeps Effect errors in the check exit code while printing
  existing warning-level diagnostics without failing the build.
- Practical sequence: run `bun install --frozen-lockfile` at the repository root, then
  `bun run check`. If editor diagnostics look stale, run `bun run prepare`.

---

## 2. The async boundary: one `ManagedRuntime` + a `runTool` helper

Every extension that uses Effect needs exactly this shape. Build **one** runtime lazily,
dispose it on shutdown, and funnel every tool handler through a single helper that turns
Effect exits into what pi expects (a value, or a thrown `Error`; interruption → a friendly
message). This is lifted verbatim from `src/runtime.ts` — reuse it.

```ts
// src/runtime.ts
import { Cause, Exit, Layer, ManagedRuntime, type Effect } from "effect";
import { NodeServices } from "@effect/platform-node"; // only if you need fs / processes

// Compose your services here (see §3). NodeServices.layer =
// ChildProcessSpawner | FileSystem | Path | Crypto | Stdio | Terminal.
const AppLayer = Layer.mergeAll(NodeServices.layer /*, MyServiceLive */);

export function createRuntime() {
  return ManagedRuntime.make(AppLayer);
}
export type ExtRuntime = ReturnType<typeof createRuntime>;

/** Run an effect from an async handler: value on success, thrown Error otherwise. */
export async function runTool<A, E>(
  runtime: ExtRuntime,
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
```

Wire it into the extension lifecycle (lazy build, dispose on shutdown):

```ts
// index.ts
export default function (pi: ExtensionAPI) {
  let runtime: ExtRuntime | undefined;
  const getRuntime = () => (runtime ??= createRuntime());

  pi.registerTool({
    name: "my_tool",
    parameters: Type.Object({/* typebox */}),
    async execute(_id, params, signal) {
      return await runTool(getRuntime(), myEffect(params), {
        signal,
        interruptMessage: "Cancelled.",
      });
    },
  });

  pi.on("session_shutdown", async () => {
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose(); // runs all finalizers: kills scoped child processes, etc.
  });
}
```

Key facts:

- `runPromiseExit(effect, { signal })` — passing the tool's `AbortSignal` makes cancelling
  the tool interrupt the fiber; scoped resources (child processes) are torn down.
- `runtime.runFork(effect)` for fire-and-forget background work (polling loops, §5).
- `dispose()` is the single teardown hook — put resource cleanup in Effect finalizers, not
  in ad-hoc `session_shutdown` code.
- If an extension has **no** services (pure `Effect.tryPromise` calls, no fs/process), you
  can skip `NodeServices.layer` and even skip `ManagedRuntime` — `Effect.runPromiseExit(effect, { signal })`
  works standalone. Add the runtime only when you have a `Layer` to share.

---

## 3. Services, layers, errors (house style)

Mirror the subagents code. Class-style `Context.Service`, `Layer.effect`/`Layer.sync`,
`Data.TaggedError` for domain errors.

```ts
import { Context, Data, Effect, Layer } from "effect";

// Domain error — yieldable, tag-narrowable with Effect.catchTag:
export class GitError extends Data.TaggedError("GitError")<{
  readonly message: string;
}> {}

// Service: the class value is the key AND the type.
export interface GitShape {
  readonly status: Effect.Effect<string, GitError>;
}
export class Git extends Context.Service<Git, GitShape>()("gitinfo/Git") {}

// Layer building it (Layer.effect can use scoped resources; Layer.sync for pure):
export const GitLive: Layer.Layer<Git, never, ChildProcessSpawner> =
  Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner; // dependency, provided by NodeServices.layer
      return Git.of({
        status: spawner
          .string(ChildProcess.make("git", ["status", "--porcelain"]))
          .pipe(
            Effect.mapError(
              (cause) => new GitError({ message: String(cause) }),
            ),
          ),
      });
    }),
  );
```

Provide dependencies with `Layer.provide`, compose with `Layer.mergeAll` (see §2 `AppLayer`).
Full rename table (`Effect.fork`→`forkChild`, `catchAll`→`catch`, `Either`→`Result`, …) and
the child-process / concurrency APIs live in `effect-v4-notes.md` — don't re-derive them.

---

## 4. Recipe: child processes + timeout + polling (git-info, copy-all)

`git-info` shells out to `git`/`gh` with per-command timeouts and polls on an interval;
`copy-all` pipes text into `pbcopy`. Two viable levels — pick the lightest that fits.

**Simple, one-shot, small:** if all you do is "run a command, capture stdout, with a
timeout," the Effect win is `Effect.timeout` + interruption killing the child. Use the
spawner service:

```ts
import { Effect } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

const gitStatus = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make("git", ["status", "--porcelain"], { cwd }))
    .pipe(Effect.timeout("3 seconds")); // fails with Cause.TimeoutError (tag "TimeoutError")
});
```

Note the import gotcha: `ChildProcessSpawner` the **class** comes from the
`.../ChildProcessSpawner` submodule; the `effect/unstable/process` index gives you the
namespace. Provide `NodeServices.layer` (or `ChildProcessSpawner.layer`). Full command
builder / streaming / kill semantics are in `effect-v4-notes.md §6`.

**Polling on an interval:** replace `setInterval` with a forked, scheduled effect so it
cancels cleanly on dispose:

```ts
import { Effect, Schedule } from "effect";

const pollLoop = refresh.pipe(
  Effect.catchCause(() => Effect.void), // don't let one failure kill the loop
  Effect.repeat(Schedule.spaced("3 seconds")),
);
const fiber = runtime.runFork(pollLoop); // interrupted by runtime.dispose()
```

**When to stay plain:** `copy-all` spawning `pbcopy` is a trivial one-shot with no
cancellation need — the existing `node:child_process` + Promise wrapper is honestly fine.
Migrate it only for consistency; if you do, `Effect.callback` around `child.once("exit", …)`
(see notes §4) is the minimal wrapper. Don't add a service/layer for a clipboard write.

---

## 6. Recipe: UI popups & rendering (ask-user, ui-customization, model-info)

These are the "leave it mostly plain" cases.

- `ask-user` is a TUI popup that resolves a Promise when the user picks. That Promise already
  models the one async thing. Effect adds nothing; if you want uniformity, wrap the final
  await in `Effect.tryPromise` at the boundary and stop there. Do **not** build a service.
- `ui-customization` and `model-info` are renderers / event bookkeepers driven by
  `pi.on(...)` and cross-extension channels (`shared/dashboard-state.ts`). Channels are a
  pi-native mechanism — keep them. State counting and formatting stay synchronous TS.
- If `model-info` has a periodic "live update" tick, the §5 polling pattern applies; but a
  plain timer here is also acceptable since there's no resource to tear down.

The migration bar for these: adopt the toolchain (§1) so they typecheck under TS7 + the
Effect LS, and only touch runtime code that has a real async/resource concern.

---

## 7. Verify from the repository root

The root scripts are the canonical checks and cover every extension:

```bash
bun install --frozen-lockfile
bun run check
bun run test
```

For a clean dependency-install check, use `bun install --frozen-lockfile`. If an extension fails with
`Effect.fork`/`ServiceMap`/`Either` errors, it is using stale v3/early-beta APIs — consult
the rename table in `effect-v4-notes.md`.

---

## 8. Don'ts (keep it lean)

1. **Don't declare versions per extension.** The root `package.json` is the single source of
   dependency versions; `unstable/*` can break between Effect betas.
2. **Don't Effect-ify pure/UI code.** No service or layer for a clipboard write, a string
   truncation, or a popup. §0 is the test: is there a typed-error / cancellation / resource /
   retry concern? If not, leave it.
3. **Don't guess APIs.** If it's not in this guide or `effect-v4-notes.md` and you haven't
   grepped it in `node_modules/effect/dist/*.d.ts`, don't write it. Watch for hallucinated
   `ServiceMap` (reverted to `Context`), `Effect.fork` (→ `forkChild`), `Effect.either`
   (→ `Effect.result`).
4. **Don't hand-roll teardown.** Put cleanup in Effect finalizers and let `runtime.dispose()`
   in `session_shutdown` run them.
5. **Don't over-test.** A `check` that passes plus one focused runtime test (where behavior
   is non-obvious) beats a wall of defensive unit tests.
6. **Don't invent nested package scripts.** Run `bun run check` and `bun run test`
   from the repository root so every extension uses the same dependency tree and gates.
