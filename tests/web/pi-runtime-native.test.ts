import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
  return { runtime, session, events };
}

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
