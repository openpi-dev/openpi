import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  contentText,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSession,
  createAgentSessionServices,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import type { WebRuntimeEvent } from "../../web/runtime/types.ts";

async function nativeRuntime(
  t: TestContext,
  extension: ExtensionFactory,
  responses: FauxResponseStep[],
) {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-native-admission-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const provider = fauxProvider({
    provider: `native-admission-${root.split(/[/\\]/u).at(-1)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  provider.setResponses(responses);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(
      { retry: { enabled: false }, compaction: { enabled: false } },
      { projectTrusted: false },
    ),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [extension],
    },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model: provider.getModel(),
  });
  const owner = new AgentSessionRuntime(session, services, async () => {
    throw new Error("The fixture does not replace Sessions");
  });
  const runtime = Reflect.construct(PiWebRuntime, [
    owner,
    join(root, "sessions"),
    { release: async () => undefined },
    { release: async () => undefined },
    true,
  ]) as PiWebRuntime;
  t.after(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await (
    runtime as unknown as {
      startRuntimeSession(): Promise<void>;
    }
  ).startRuntimeSession();
  const events: WebRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return {
    cwd,
    agentDir,
    services,
    runtime,
    session,
    events,
    modelRuntime,
    provider: provider.provider,
  };
}

test("Web saves a Pi default without changing the active model; a fresh native Session uses it", async (t) => {
  const { runtime, session, modelRuntime, agentDir, cwd, services } =
    await nativeRuntime(t, () => undefined, []);
  const second = fauxProvider({
    provider: "second-default-fixture",
    models: [{ id: "fixture", name: "Second fixture", reasoning: false }],
  });
  modelRuntime.registerNativeProvider(second.provider);
  await modelRuntime.setRuntimeApiKey(second.provider.id, "fixture-key");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ theme: "dark", privateUnrelated: { preserved: true } }),
  );
  const original = session.model;
  const options = {
    expectedSessionId: session.sessionId,
    expectedSessionPath: `current:${session.sessionId}`,
  };
  assert.deepEqual(runtime.readModelDefaults(), { model: null });
  assert.deepEqual(
    await runtime.saveModelDefault(second.provider.id, "fixture", options),
    { model: { provider: second.provider.id, id: "fixture" } },
  );
  assert.equal(session.model, original);
  assert.equal(session.messages.length, 0);
  assert.equal(
    session.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "model_change" &&
          entry.provider === second.provider.id,
      ),
    false,
  );
  const saved = JSON.parse(
    await readFile(join(agentDir, "settings.json"), "utf8"),
  );
  assert.deepEqual(saved.privateUnrelated, { preserved: true });
  assert.equal(saved.theme, "dark");
  const fresh = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    resourceLoader: services.resourceLoader,
    settingsManager: SettingsManager.create(cwd, agentDir),
    sessionManager: SessionManager.inMemory(cwd),
    tools: [],
  });
  assert.equal(fresh.session.model?.provider, second.provider.id);
  assert.equal(fresh.session.model?.id, "fixture");
  fresh.session.dispose();
  await runtime.setModel(original!.provider, original!.id, options);
  await session.settingsManager.flush();
  assert.equal(runtime.readModelDefaults().model?.provider, second.provider.id);
  await assert.rejects(
    runtime.saveModelDefault(original!.provider, original!.id, {
      ...options,
      expectedSessionPath: "/copied.jsonl",
    }),
    { code: "SESSION_CONFLICT" },
  );
  await assert.rejects(
    runtime.saveModelDefault("not-configured", "fixture", options),
    { code: "MODEL_NOT_AVAILABLE" },
  );
  assert.equal(runtime.readModelDefaults().model?.provider, second.provider.id);
});

test("Web scopes large model search to the exact connection before bounding results", async (t) => {
  const { runtime, modelRuntime } = await nativeRuntime(t, () => undefined, []);
  for (const id of ["catalog", "catalog-extra"]) {
    const provider = fauxProvider({
      provider: id,
      models: Array.from({ length: 70 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        reasoning: false,
      })),
    });
    modelRuntime.registerNativeProvider(provider.provider);
    await modelRuntime.setRuntimeApiKey(id, "fixture-key");
  }
  const page = runtime.searchModels("", 50, "catalog-extra");
  assert.equal(page.totalAvailable, 70);
  assert.equal(page.models.length, 50);
  assert.equal(page.truncation.matchesOmitted, 20);
  assert.equal(
    page.models.every((model) => model.provider === "catalog-extra"),
    true,
  );
  const exact = runtime.searchModels("model-69", 50, "catalog");
  assert.deepEqual(
    exact.models.map(({ provider, id }) => ({ provider, id })),
    [{ provider: "catalog", id: "model-69" }],
  );
});

test("Web reports trusted project default overrides and refuses malformed native settings", async (t) => {
  const { runtime, session, agentDir, cwd, provider } = await nativeRuntime(
    t,
    () => undefined,
    [],
  );
  await mkdir(join(cwd, ".pi"));
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ defaultProvider: provider.id, defaultModel: "fixture" }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "other", defaultModel: "other-model" }),
  );
  session.settingsManager.setProjectTrusted(true);
  assert.deepEqual(runtime.readModelDefaults(), {
    model: { provider: "other", id: "other-model" },
    projectOverride: { provider: provider.id, id: "fixture" },
  });
  await writeFile(join(agentDir, "settings.json"), "{malformed");
  await assert.rejects(
    runtime.saveModelDefault(provider.id, "fixture", {
      expectedSessionId: session.sessionId,
      expectedSessionPath: `current:${session.sessionId}`,
    }),
  );
  assert.equal(
    await readFile(join(agentDir, "settings.json"), "utf8"),
    "{malformed",
  );
});

test("Web account login uses Pi's credential store, blocks competing mutations and clears through native logout", {
  timeout: 15_000,
}, async (t) => {
  const { runtime, session, modelRuntime, provider } = await nativeRuntime(
    t,
    () => undefined,
    [],
  );
  let logins = 0;
  modelRuntime.registerNativeProvider({
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        name: "Fixture account",
        isSubscription: true,
        login: async (interaction) => {
          logins++;
          const method = await interaction.prompt({
            type: "select",
            message: "Choose",
            options: [{ id: "browser", label: "Browser" }],
          });
          assert.equal(method, "browser");
          interaction.notify({
            type: "auth_url",
            url: "https://accounts.example/authorize",
          });
          const code = await interaction.prompt({
            type: "manual_code",
            message: "Callback",
          });
          assert.equal(code, "fixture-code");
          return {
            type: "oauth",
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: Date.now() + 3_600_000,
          };
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
  });
  await modelRuntime.removeRuntimeApiKey(provider.id);
  const sessionId = session.sessionManager.getSessionId();
  await assert.rejects(
    runtime.startProviderLogin("wrong-session", provider.id),
    { code: "SESSION_CONFLICT" },
  );
  const flow = await runtime.startProviderLogin(sessionId, provider.id);
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("Native login did not settle");
  };
  await waitFor(() =>
    Boolean(runtime.readProviderLogin(sessionId, flow.id)?.prompt),
  );
  await assert.rejects(runtime.setModel(provider.id, "fixture"), {
    code: "PROVIDER_LOGIN_CONFLICT",
  });
  await assert.rejects(runtime.sendPrompt("must not start during login"), {
    code: "PROVIDER_LOGIN_CONFLICT",
  });
  const select = runtime.readProviderLogin(sessionId, flow.id)!.prompt!;
  runtime.respondProviderLogin(sessionId, flow.id, select.id, "browser");
  await waitFor(
    () =>
      runtime.readProviderLogin(sessionId, flow.id)?.prompt?.type ===
      "manual_code",
  );
  const prompt = runtime.readProviderLogin(sessionId, flow.id)!.prompt!;
  runtime.respondProviderLogin(sessionId, flow.id, prompt.id, "fixture-code");
  await waitFor(
    () => runtime.readProviderLogin(sessionId, flow.id)?.status === "succeeded",
  );
  assert.equal(logins, 1);
  assert.equal(modelRuntime.isUsingSubscription(provider.id), true);
  assert.deepEqual(await modelRuntime.listCredentials(), [
    { providerId: provider.id, type: "oauth" },
  ]);
  assert.equal(
    JSON.stringify(runtime.readProviderLogin(sessionId, flow.id)).includes(
      "fixture-access",
    ),
    false,
  );
  assert.equal(session.messages.length, 0);
  await runtime.logoutProvider(sessionId, provider.id);
  assert.deepEqual(await modelRuntime.listCredentials(), []);
  assert.equal(modelRuntime.isUsingSubscription(provider.id), false);
});

test("handled input retains its native queued work until Pi settles", {
  timeout: 15_000,
}, async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inputs: string[][] = [];
  const { runtime, session, events } = await nativeRuntime(
    t,
    (pi) => {
      pi.on("input", (event) => {
        if (event.text !== "enqueue") return undefined;
        pi.sendUserMessage("queued request", { deliverAs: "followUp" });
        return { action: "handled" };
      });
    },
    [
      async (context) => {
        inputs.push(
          context.messages
            .filter((message) => message.role === "user")
            .map((message) => contentText(message.content)),
        );
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("Initial request finished.");
      },
      (context) => {
        inputs.push(
          context.messages
            .filter((message) => message.role === "user")
            .map((message) => contentText(message.content)),
        );
        return fauxAssistantMessage("Queued request finished.");
      },
    ],
  );
  try {
    await runtime.sendPrompt("initial request", { commandId: "initial" });
    await entered.promise;
    assert.deepEqual(
      await runtime.sendPrompt("enqueue", { commandId: "queued" }),
      { pendingFollowUps: 1 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(inputs.length, 1);
    assert.deepEqual(session.getFollowUpMessages(), ["queued request"]);
    assert.equal(
      events.some(
        (event) =>
          event.type === "prompt_settled" &&
          event.detail?.commandId === "queued",
      ),
      false,
    );
    release.resolve();
    await session.waitForIdle();
    assert.equal(inputs.length, 2);
    assert.ok(inputs[1]?.includes("queued request"));
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_settled" &&
          event.detail?.commandId === "initial",
      ),
      true,
    );
  } finally {
    release.resolve();
  }
});

for (const origin of ["web", "extension", "startup"] as const) {
  test(`prompt during native settlement waits for admission (${origin} run)`, {
    timeout: 15_000,
  }, async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inputs: string[][] = [];
    const { runtime, session, events } = await nativeRuntime(
      t,
      (pi) => {
        let held = false;
        pi.on("agent_settled", async () => {
          if (held) return;
          held = true;
          entered.resolve();
          await release.promise;
        });
        if (origin === "startup")
          pi.on("session_start", async () => {
            pi.sendUserMessage("initial request");
            await entered.promise;
          });
      },
      [
        fauxAssistantMessage("Initial request finished."),
        (context) => {
          inputs.push(
            context.messages
              .filter((message) => message.role === "user")
              .map((message) => contentText(message.content)),
          );
          return fauxAssistantMessage("Request during settlement finished.");
        },
      ],
    );
    let settled = false;
    let failure: unknown;
    let initialRun: Promise<unknown> | undefined;
    try {
      if (origin === "web")
        await runtime.sendPrompt("initial request", { commandId: "initial" });
      else if (origin === "extension")
        initialRun = session.sendUserMessage("initial request");
      await entered.promise;
      assert.equal(session.isIdle, true);
      const admission = runtime
        .sendPrompt("request during settlement", {
          commandId: "during-settlement",
        })
        .then(
          (receipt) => {
            settled = true;
            return receipt;
          },
          (error: unknown) => {
            settled = true;
            failure = error;
            return undefined;
          },
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        settled,
        false,
        `Request settled before native admission: ${String(failure)}`,
      );
      assert.equal(inputs.length, 0);
      release.resolve();
      assert.deepEqual(await admission, { pendingFollowUps: 0 });
      await session.waitForIdle();
      await initialRun;
      assert.equal(inputs.length, 1);
      assert.ok(inputs[0]?.includes("request during settlement"));
      assert.equal(
        events.some(
          (event) =>
            event.type === "turn_started" &&
            event.detail?.commandId === "during-settlement",
        ),
        true,
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "turn_settled" &&
            event.detail?.commandId === "during-settlement" &&
            event.detail?.outcome === "completed",
        ),
        true,
      );
    } finally {
      release.resolve();
      await initialRun;
    }
  });
}

test("Web steering preserves native handled and queued input dispositions", {
  timeout: 15_000,
}, async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const inputs: string[][] = [];
  const sources: string[] = [];
  const { runtime, session, events } = await nativeRuntime(
    t,
    (pi) => {
      pi.on("input", (event) => {
        if (event.text === "handled steering") {
          sources.push(event.source);
          return { action: "handled" };
        }
        if (event.text === "queued steering") {
          sources.push(event.source);
          return { action: "transform", text: "transformed steering" };
        }
        return undefined;
      });
    },
    [
      async () => {
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage("Initial result.");
      },
      (context) => {
        inputs.push(
          context.messages
            .filter((message) => message.role === "user")
            .map((message) => contentText(message.content)),
        );
        return fauxAssistantMessage("Steered result.");
      },
    ],
  );
  try {
    await runtime.sendPrompt("initial request", { commandId: "initial" });
    await entered.promise;
    const delivery = {
      streamingBehavior: "steer" as const,
      expectedTurnCommandId: "initial",
    };
    assert.deepEqual(
      await runtime.sendPrompt("handled steering", {
        ...delivery,
        commandId: "handled",
      }),
      {
        pendingFollowUps: 0,
        pendingSteering: 0,
        delivery: "steer",
      },
    );
    assert.deepEqual(session.getSteeringMessages(), []);
    assert.deepEqual(
      await runtime.sendPrompt("queued steering", {
        ...delivery,
        commandId: "queued",
      }),
      {
        pendingFollowUps: 0,
        pendingSteering: 1,
        delivery: "steer",
      },
    );
    assert.deepEqual(session.getSteeringMessages(), ["transformed steering"]);
    assert.deepEqual(sources, ["rpc", "rpc"]);
    release.resolve();
    await session.waitForIdle();
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0]?.includes("transformed steering"));
    assert.equal(
      events.some(
        (event) =>
          event.type === "turn_started" &&
          event.detail?.commandId === "handled",
      ),
      false,
    );
  } finally {
    release.resolve();
  }
});
