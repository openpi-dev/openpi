import assert from "node:assert/strict";
import fsPromises, {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  readModelConfigurations,
  saveModelConfiguration,
  validModelConfiguration,
} from "../../web/runtime/model-configuration.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import type { WebModelConfiguration } from "../../web/runtime/types.ts";

const model: WebModelConfiguration = {
  provider: "local-fixture",
  id: "fixture-model",
  name: "Fixture",
  baseUrl: "http://127.0.0.1:9/v1",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 4096,
};

test("native model configuration preserves other fields, rejects stale writes and never returns credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-model-config-"));
  try {
    const path = join(directory, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          [model.provider]: {
            apiKey: "secret-fixture",
            headers: { "X-Credential": "header-fixture" },
            baseUrl: model.baseUrl,
            api: model.api,
            models: [
              {
                ...model,
                input: ["text", "image"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const before = await readModelConfigurations(directory);
    assert.equal(before.models.length, 1);
    assert.doesNotMatch(
      JSON.stringify(before),
      /secret-fixture|header-fixture|apiKey|headers/u,
    );
    await saveModelConfiguration(directory, before.revision, {
      ...model,
      name: "Updated",
    });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.providers[model.provider].apiKey, "secret-fixture");
    assert.deepEqual(persisted.providers[model.provider].models[0].input, [
      "text",
      "image",
    ]);
    assert.equal(persisted.providers[model.provider].models[0].name, "Updated");
    // Windows reports a synthetic mode; ACLs are not represented by POSIX bits.
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(
      saveModelConfiguration(directory, before.revision, model),
      {
        name: "WebRuntimeRequestError",
        message: "Model configuration changed; refresh before saving",
        code: "MODEL_CONFIGURATION_CONFLICT",
        statusCode: 409,
      },
    );
    const runtime = await ModelRuntime.create({
      modelsPath: path,
      authPath: join(directory, "auth.json"),
      modelsStorePath: join(directory, "catalog.json"),
      allowModelNetwork: false,
    });
    assert.equal(runtime.getError(), undefined);
    assert.equal(runtime.getModel(model.provider, model.id)?.name, "Updated");
    assert.equal(
      validModelConfiguration({
        ...model,
        baseUrl: "https://user:secret@example.com",
      }),
      false,
    );
    assert.equal(
      validModelConfiguration({
        ...model,
        baseUrl: "https://example.com?key=secret",
      }),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model configuration rejects a revision change before rename and preserves the external write", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-model-config-race-"));
  const path = join(directory, "models.json");
  const external = JSON.stringify({ providers: {}, external: true });
  try {
    await writeFile(path, JSON.stringify({ providers: {} }));
    const before = await readModelConfigurations(directory);
    const originalWrite = fsPromises.writeFile;
    context.mock.method(
      fsPromises,
      "writeFile",
      async (...args: Parameters<typeof originalWrite>) => {
        await originalWrite(...args);
        if (String(args[0]).startsWith(`${path}.`))
          await originalWrite(path, external);
      },
    );
    syncBuiltinESMExports();
    context.after(() => {
      context.mock.restoreAll();
      syncBuiltinESMExports();
    });

    await assert.rejects(
      saveModelConfiguration(directory, before.revision, model),
      {
        name: "WebRuntimeRequestError",
        message: "Model configuration changed; refresh before saving",
        code: "MODEL_CONFIGURATION_CONFLICT",
        statusCode: 409,
      },
    );
    assert.equal(await readFile(path, "utf8"), external);
    assert.deepEqual(await readdir(directory), ["models.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Web saves a custom provider key through Pi login, reloads it, and rejects busy or stale sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-credentials-"));
  try {
    await saveModelConfiguration(
      directory,
      (await readModelConfigurations(directory)).revision,
      model,
    );
    const options = {
      modelsPath: join(directory, "models.json"),
      authPath: join(directory, "auth.json"),
      modelsStorePath: join(directory, "catalog.json"),
      allowModelNetwork: false,
    };
    const modelRuntime = await ModelRuntime.create(options);
    const session = {
      sessionManager: SessionManager.inMemory(directory),
      isStreaming: false,
      model: modelRuntime.getModel(model.provider, model.id)!,
      async setModel(next: NonNullable<ReturnType<ModelRuntime["getModel"]>>) {
        this.model = next;
      },
    };
    const runtime = Object.assign(
      Object.create(PiWebRuntime.prototype) as object,
      {
        runtime: { services: { agentDir: directory, modelRuntime }, session },
        hasSelectedWorkspace: true,
        runtimeOperations: new Set(),
        listeners: new Set(),
      },
    ) as unknown as PiWebRuntime;
    const sessionId = session.sessionManager.getSessionId();
    await runtime.saveProviderKey(
      sessionId,
      model.provider,
      "fixture-write-only-key",
    );
    assert.equal(
      JSON.parse(await readFile(options.authPath, "utf8"))[model.provider].key,
      "fixture-write-only-key",
    );
    assert.doesNotMatch(
      JSON.stringify(runtime.listProviderAuth()),
      /fixture-write-only-key/u,
    );
    const reloaded = await ModelRuntime.create(options);
    assert.equal(
      (await reloaded.getAuth(model.provider))?.auth.apiKey,
      "fixture-write-only-key",
    );
    await runtime.saveModelConfiguration(
      sessionId,
      (await readModelConfigurations(directory)).revision,
      {
        ...model,
        baseUrl: "http://127.0.0.1:10/v1",
        name: "Updated current model",
      },
    );
    assert.equal(session.model.baseUrl, "http://127.0.0.1:10/v1");
    assert.equal(session.model.name, "Updated current model");
    session.isStreaming = true;
    await assert.rejects(
      runtime.saveProviderKey(sessionId, model.provider, "busy"),
      /idle/u,
    );
    session.isStreaming = false;
    await assert.rejects(
      runtime.saveProviderKey("stale", model.provider, "stale"),
      /idle/u,
    );
    assert.equal(
      JSON.parse(await readFile(options.authPath, "utf8"))[model.provider].key,
      "fixture-write-only-key",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
