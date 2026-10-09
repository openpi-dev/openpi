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
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  readModelConfigurations,
  saveModelConfiguration,
  saveModelConfigurations,
  validModelConfiguration,
  changeProviderConfiguration,
  validProviderConfigurationChange,
} from "../../web/runtime/model-configuration.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import type { WebModelConfiguration } from "../../web/runtime/types.ts";
import { validProviderDiscovery } from "../../web/runtime/provider-model-discovery.ts";

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

test("model, provider and discovery APIs require literal string identities", () => {
  for (const api of [
    "openai-responses",
    "openai-completions",
    "anthropic-messages",
  ]) {
    const valid = { ...model, api };
    const provider = (apiValue: unknown) => ({
      action: "save",
      configuration: {
        provider: model.provider,
        name: "Fixture",
        baseUrl: model.baseUrl,
        api: apiValue,
        models: [valid],
      },
    });
    assert.equal(validModelConfiguration(valid), true);
    assert.equal(validProviderConfigurationChange(provider(api)), true);
    assert.equal(
      validProviderDiscovery({
        provider: model.provider,
        baseUrl: model.baseUrl,
        api,
      }),
      true,
    );
    for (const malformed of [[api], null, {}, 1]) {
      assert.equal(
        validModelConfiguration({ ...model, api: malformed }),
        false,
      );
      assert.equal(
        validProviderConfigurationChange(provider(malformed)),
        false,
      );
      assert.equal(
        validProviderDiscovery({
          provider: model.provider,
          baseUrl: model.baseUrl,
          api: malformed,
        }),
        false,
      );
    }
  }
});

test("a malformed API cannot rewrite native model configuration bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-model-api-type-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models.json");
  const original = '{"providers":{},"future":{"keep":true}}\n';
  await writeFile(path, original);
  const before = await readModelConfigurations(directory);
  const malformed = {
    ...model,
    api: [model.api],
  } as unknown as WebModelConfiguration;
  await assert.rejects(
    saveModelConfiguration(directory, before.revision, malformed),
    /Invalid model configurations/u,
  );
  assert.equal(await readFile(path, "utf8"), original);
});

test("provider card saves and removals preserve native fields, credentials and other providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-provider-card-"));
  try {
    const path = join(directory, "models.json");
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          [model.provider]: {
            name: "Local",
            baseUrl: model.baseUrl,
            api: model.api,
            apiKey: "private-key",
            headers: { "X-Private": "private-header" },
            models: [
              {
                ...model,
                input: ["text", "image"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
              { ...model, id: "remove-me" },
            ],
          },
          untouched: {
            baseUrl: "http://localhost:9",
            apiKey: "other-private-key",
          },
        },
      }),
    );
    const before = await readModelConfigurations(directory);
    assert.equal(before.providers[0]?.editable, true);
    assert.deepEqual(before.models[0]?.input, ["text", "image"]);
    assert.doesNotMatch(
      JSON.stringify(before),
      /private-key|private-header|apiKey|headers/u,
    );
    const change = {
      action: "save" as const,
      configuration: {
        provider: model.provider,
        name: "Renamed local",
        baseUrl: model.baseUrl,
        api: model.api,
        models: [{ ...model, name: "Updated model" }],
      },
    };
    assert.equal(validProviderConfigurationChange(change), true);
    await changeProviderConfiguration(directory, before.revision, change);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.providers[model.provider].name, "Renamed local");
    assert.equal(saved.providers[model.provider].models.length, 1);
    assert.deepEqual(saved.providers[model.provider].models[0].input, [
      "text",
      "image",
    ]);
    assert.equal(saved.providers[model.provider].apiKey, "private-key");
    assert.deepEqual(saved.providers[model.provider].headers, {
      "X-Private": "private-header",
    });
    const runtime = await ModelRuntime.create({
      modelsPath: path,
      authPath: join(directory, "auth.json"),
      allowModelNetwork: false,
    });
    assert.equal(runtime.getError(), undefined);
    assert.equal(runtime.getProvider(model.provider)?.name, "Renamed local");
    assert.equal(
      runtime.getModel(model.provider, model.id)?.name,
      "Updated model",
    );
    const latest = await readModelConfigurations(directory);
    await changeProviderConfiguration(directory, latest.revision, {
      ...change,
      configuration: {
        ...change.configuration,
        models: [{ ...model, input: ["text"] }],
      },
    });
    assert.deepEqual(
      JSON.parse(await readFile(path, "utf8")).providers[model.provider]
        .models[0].input,
      ["text"],
    );
    await assert.rejects(
      changeProviderConfiguration(directory, before.revision, {
        action: "remove",
        provider: model.provider,
      }),
      /changed/,
    );
    await changeProviderConfiguration(
      directory,
      (await readModelConfigurations(directory)).revision,
      { action: "remove", provider: model.provider },
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).providers, {
      untouched: saved.providers.untouched,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clearing capacities removes native overrides and preserves unexposed model settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-provider-capacity-"));
  try {
    const before = await readModelConfigurations(directory);
    await changeProviderConfiguration(directory, before.revision, {
      action: "save",
      configuration: {
        provider: model.provider,
        name: "Capacity fixture",
        baseUrl: model.baseUrl,
        api: model.api,
        models: [{ ...model, contextWindow: 2300000, maxTokens: 32000 }],
      },
    });
    const saved = await readModelConfigurations(directory);
    assert.equal(saved.models[0]?.contextWindow, 2300000);
    const {
      contextWindow: _context,
      maxTokens: _output,
      ...inherited
    } = saved.models[0]!;
    assert.equal(validModelConfiguration(inherited), true);
    assert.equal(
      validModelConfiguration({ ...inherited, maxTokens: null }),
      false,
    );
    await changeProviderConfiguration(directory, saved.revision, {
      action: "save",
      configuration: {
        provider: model.provider,
        name: "Capacity fixture",
        baseUrl: model.baseUrl,
        api: model.api,
        models: [inherited],
      },
    });
    const path = join(directory, "models.json");
    const entry = JSON.parse(await readFile(path, "utf8")).providers[
      model.provider
    ].models[0];
    assert.equal(Object.hasOwn(entry, "contextWindow"), false);
    assert.equal(Object.hasOwn(entry, "maxTokens"), false);
    assert.equal(entry.reasoning, true);
    assert.equal(
      (await readModelConfigurations(directory)).models[0]?.contextWindow,
      undefined,
    );
    const runtime = await ModelRuntime.create({
      modelsPath: path,
      authPath: join(directory, "auth.json"),
      allowModelNetwork: false,
    });
    assert.equal(runtime.getError(), undefined);
    assert.equal(
      runtime.getModel(model.provider, model.id)?.contextWindow,
      128000,
    );
    assert.equal(runtime.getModel(model.provider, model.id)?.maxTokens, 16384);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial projections cannot silently replace unsupported native models", async () => {
  assert.equal(validModelConfiguration({ ...model, input: [] }), false);
  assert.equal(validModelConfiguration({ ...model, input: ["audio"] }), false);
  const directory = await mkdtemp(join(tmpdir(), "openpi-provider-partial-"));
  try {
    const path = join(directory, "models.json");
    const original = JSON.stringify({
      providers: {
        [model.provider]: {
          baseUrl: model.baseUrl,
          api: model.api,
          models: [model, { id: "special", api: "google-generative-ai" }],
        },
      },
    });
    await writeFile(path, original);
    const config = await readModelConfigurations(directory);
    assert.equal(config.providers[0]?.editable, false);
    await assert.rejects(
      changeProviderConfiguration(directory, config.revision, {
        action: "save",
        configuration: {
          provider: model.provider,
          name: "Local",
          baseUrl: model.baseUrl,
          api: model.api,
          models: [model],
        },
      }),
      /uneditable/,
    );
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(
      validProviderConfigurationChange({
        action: "remove",
        provider: "__proto__",
      }),
      false,
    );
    assert.equal(
      validProviderConfigurationChange({
        action: "save",
        configuration: {
          provider: model.provider,
          name: "Local",
          baseUrl: model.baseUrl,
          api: model.api,
          models: [model, model],
        },
      }),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a built-in provider can override its connection while retaining its native catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-builtin-provider-"));
  try {
    await changeProviderConfiguration(
      directory,
      (await readModelConfigurations(directory)).revision,
      {
        action: "save",
        configuration: {
          provider: "openai",
          name: "OpenAI gateway",
          baseUrl: model.baseUrl,
          api: "openai-responses",
          models: [],
        },
      },
    );
    const runtime = await ModelRuntime.create({
      modelsPath: join(directory, "models.json"),
      authPath: join(directory, "auth.json"),
      allowModelNetwork: false,
    });
    assert.equal(runtime.getError(), undefined);
    assert.ok(runtime.getModels("openai").length > 0);
    assert.equal(runtime.getModels("openai")[0]?.baseUrl, model.baseUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch model additions commit together and reject invalid or stale batches without partial writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-model-batch-"));
  try {
    const before = await readModelConfigurations(directory);
    await assert.rejects(
      saveModelConfigurations(directory, before.revision, [
        model,
        { ...model, id: "other", maxTokens: -1 },
      ]),
    );
    assert.deepEqual((await readModelConfigurations(directory)).models, []);
    await saveModelConfigurations(directory, before.revision, [
      model,
      { ...model, id: "other" },
    ]);
    assert.equal((await readModelConfigurations(directory)).models.length, 2);
    await assert.rejects(
      saveModelConfigurations(directory, before.revision, [
        { ...model, id: "third" },
      ]),
      /changed/,
    );
    assert.equal((await readModelConfigurations(directory)).models.length, 2);
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    await assert.rejects(
      runtime.changeProviderConfiguration(
        sessionId,
        (await readModelConfigurations(directory)).revision,
        { action: "remove", provider: model.provider },
      ),
      /Select another model/,
    );
    await runtime.changeProviderConfiguration(
      sessionId,
      (await readModelConfigurations(directory)).revision,
      {
        action: "save",
        configuration: {
          provider: model.provider,
          name: "Provider card",
          baseUrl: model.baseUrl,
          api: model.api,
          models: [{ ...model, name: "Provider card model", reasoning: false }],
        },
      },
    );
    assert.equal(session.model.name, "Provider card model");
    assert.deepEqual(getSupportedThinkingLevels(session.model), ["off"]);
    await runtime.changeProviderConfiguration(
      sessionId,
      (await readModelConfigurations(directory)).revision,
      {
        action: "save",
        configuration: {
          provider: model.provider,
          name: "Provider card",
          baseUrl: model.baseUrl,
          api: model.api,
          models: [model],
        },
      },
    );
    assert.ok(getSupportedThinkingLevels(session.model).includes("high"));
    session.isStreaming = true;
    await assert.rejects(
      runtime.changeProviderConfiguration(
        sessionId,
        (await readModelConfigurations(directory)).revision,
        { action: "remove", provider: "other" },
      ),
      /idle/,
    );
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
