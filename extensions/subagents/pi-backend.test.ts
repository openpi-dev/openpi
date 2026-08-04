/**
 * Model resolution for the default (pi) backend. These paths reject before any
 * child session is created, so they need no SDK fake and no network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { piBackend } from "./src/backends/pi.ts";
import type { ParentContext, SpawnTask } from "./src/domain.ts";

function registryOf(models: { provider: string; id: string }[]) {
  return {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
  } as unknown as ModelRegistry;
}

function spawnTask(model: string | undefined, parent: Partial<ParentContext>) {
  return {
    prompt: "p",
    title: "t",
    cwd: process.cwd(),
    model,
    parent: { parentCwd: process.cwd(), projectTrusted: false, ...parent },
  } satisfies SpawnTask;
}

const spawn = (task: SpawnTask) =>
  Effect.runPromise(Effect.scoped(piBackend.spawn(task)));

test("the pi backend refuses to spawn without the parent's model registry", async () => {
  await assert.rejects(
    spawn(spawnTask("seal/kimi-k3", {})),
    /requires the parent session's model registry/,
  );
});

test("an inherited model that disappeared fails instead of selecting an SDK default", async () => {
  const registry = registryOf([{ provider: "seal", id: "available" }]);

  await assert.rejects(
    spawn(
      spawnTask(undefined, {
        modelRegistry: registry,
        inheritedModel: { provider: "seal", id: "removed" },
      }),
    ),
    /Inherited model "seal\/removed" is no longer available/,
  );
});

test("an unresolvable model hint fails before a child session exists", async () => {
  const registry = registryOf([{ provider: "seal", id: "kimi-k3" }]);

  await assert.rejects(
    spawn(spawnTask("seal/nope", { modelRegistry: registry })),
    /Unknown model "seal\/nope"/,
  );
  await assert.rejects(
    spawn(spawnTask("nope", { modelRegistry: registry })),
    /Unknown model "nope"/,
  );
});

test("a bare id carried by several providers demands qualification", async () => {
  const registry = registryOf([
    { provider: "seal", id: "kimi-k3" },
    { provider: "moonshot", id: "kimi-k3" },
  ]);

  await assert.rejects(
    spawn(spawnTask("kimi-k3", { modelRegistry: registry })),
    /exists in multiple providers \(seal, moonshot\)\. Use "provider\/kimi-k3"/,
  );
});
