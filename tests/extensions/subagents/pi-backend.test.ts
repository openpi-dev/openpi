/**
 * Model resolution for the default (pi) backend. These paths reject before any
 * child session is created, so they need no SDK fake and no network.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { piBackend } from "../../../extensions/subagents/src/backends/pi.ts";
import type {
  ParentContext,
  SpawnTask,
} from "../../../extensions/subagents/src/domain.ts";

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

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-backend-preflight-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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

test("direct subagents reject a missing declared tool before prompting", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "extensions", "fixture.ts"),
      `export default function (pi) {
        pi.registerTool({
          name: "available_fixture_tool",
          label: "Available fixture tool",
          description: "fixture",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }`,
    );
    const model = {
      provider: "fixture",
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    };
    const registry = registryOf([model]);

    await assert.rejects(
      spawn({
        prompt: "must never reach the provider",
        title: "preflight",
        cwd,
        tools: ["read", "available_fixture_tool", "missing_fixture_tool"],
        parent: {
          parentCwd: cwd,
          projectTrusted: true,
          inheritedModel: { provider: model.provider, id: model.id },
          modelRegistry: registry,
        },
      }),
      /Child tool preflight failed: requested tool "missing_fixture_tool" is unavailable after child extensions initialized/,
    );
  });
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
