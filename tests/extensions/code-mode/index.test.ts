import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createCodeModeExtension } from "../../../extensions/code-mode/index.ts";
import { createPiBuiltinExtensionFactories } from "../../../extensions/shared/pi-builtin-extensions.ts";
import { applySetupConfiguration } from "../../../extensions/shared/setup-apply.ts";
import { DEFAULT_SETUP_CONFIG } from "../../../extensions/shared/setup-config.ts";
import {
  childToolPolicy,
  shutdownAndDisposeChildSession,
} from "../../../extensions/shared/child-session.ts";

async function fixture(
  t: TestContext,
  options: {
    native?: boolean;
    enabled?: boolean;
    defaultTools?: string[];
    tools?: string[];
    excludeTools?: string[];
    noTools?: "all";
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-code-mode-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const settingsBytes = JSON.stringify({
    ...(options.defaultTools ? { defaultTools: options.defaultTools } : {}),
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  await writeFile(settingsPath, settingsBytes);
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  let config = {
    ...DEFAULT_SETUP_CONFIG,
    codeMode: { enabled: options.enabled ?? true },
  };
  const requests: string[] = [];
  const scripts: string[] = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("codemode-fixture", {
    api: "openai-responses",
    apiKey: "test-only",
    baseUrl: "http://127.0.0.1:1/v1",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 2048,
      },
    ],
    streamSimple(model, context) {
      requests.push(JSON.stringify(context));
      const code = scripts.shift();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: code
          ? [
              {
                type: "toolCall",
                id: `call-${requests.length}`,
                name: "codemode",
                arguments: { code },
              },
            ]
          : [{ type: "text", text: "done" }],
        stopReason: code ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: code ? "toolUse" : "stop", message });
      return stream;
    },
  });
  const events = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus: events,
    extensionFactories: [
      ...(options.native === false ? [] : createPiBuiltinExtensionFactories()),
      createCodeModeExtension(() => config),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    modelRuntime,
    model: modelRuntime.getModel("codemode-fixture", "fixture"),
    sessionManager: SessionManager.inMemory(cwd),
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
    ...(options.noTools ? { noTools: options.noTools } : {}),
  });
  t.after(async () => {
    await shutdownAndDisposeChildSession(session);
    assert.equal(await readFile(settingsPath, "utf8"), settingsBytes);
    await rm(cwd, { recursive: true, force: true });
  });
  const native = session.getToolDefinition("codemode");
  await session.bindExtensions({ mode: "print" });
  assert.equal(requests.length, 0, "activation does not request a model");
  assert.equal(
    session.getToolDefinition("codemode"),
    native,
    "keep the native executor",
  );
  return {
    cwd,
    session,
    scripts,
    requests,
    async setEnabled(enabled: boolean) {
      config = { ...config, codeMode: { enabled } };
      await applySetupConfiguration({ events });
    },
  };
}

test("default parent activation executes native scripts and applies setup without changing Pi settings", async (t) => {
  const h = await fixture(t);
  assert.deepEqual(h.session.getActiveToolNames().sort(), [
    "bash",
    "codemode",
    "edit",
    "read",
    "write",
  ]);
  await writeFile(join(h.cwd, "fixture.txt"), "native result");
  h.scripts.push('text(await tools.read({ path: "fixture.txt" }));');
  await h.session.prompt("Read the fixture.");
  const result = h.session.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.match(JSON.stringify(result.content), /native result/);
  assert.match(h.requests[0]!, /codemode/);
  await h.setEnabled(false);
  assert.equal(h.session.getActiveToolNames().includes("codemode"), false);
  await h.setEnabled(true);
  assert.equal(h.session.getActiveToolNames().includes("codemode"), true);
  await h.session.reload();
  assert.equal(
    h.session.getActiveToolNames().filter((name) => name === "codemode").length,
    1,
  );
});

test("native selection, explicit exclusions, missing factory and opt-out take precedence", async (t) => {
  for (const options of [
    { enabled: false },
    { native: false },
    { defaultTools: ["-codemode"] },
    { defaultTools: ["read"] },
    { defaultTools: [] },
    { tools: ["read"] },
    { excludeTools: ["codemode"] },
    { noTools: "all" as const },
  ]) {
    const h = await fixture(t, options);
    assert.equal(
      h.session.getActiveToolNames().includes("codemode"),
      false,
      JSON.stringify(options),
    );
  }
  for (const selection of [
    { defaultTools: ["+codemode"] },
    { tools: ["read", "codemode"] },
  ]) {
    const native = await fixture(t, { enabled: false, ...selection });
    assert.equal(
      native.session.getActiveToolNames().includes("codemode"),
      true,
      JSON.stringify(selection),
    );
    await native.setEnabled(true);
    await native.setEnabled(false);
    assert.equal(
      native.session.getActiveToolNames().includes("codemode"),
      true,
    );
  }
});

test("Code Mode keeps inherited child tool restrictions at the native execution boundary", async (t) => {
  const h = await fixture(t, childToolPolicy(["read", "codemode"]));
  assert.deepEqual(h.session.getActiveToolNames().sort(), ["codemode", "read"]);
  h.scripts.push(
    'text(await tools.write({ path: "forbidden.txt", content: "no" }));',
  );
  await h.session.prompt("Attempt a tool outside the allowlist.");
  const result = h.session.messages.find(
    (message) => message.role === "toolResult",
  );
  assert.ok(result && result.role === "toolResult");
  assert.equal(result.isError, true);
  await assert.rejects(readFile(join(h.cwd, "forbidden.txt")), {
    code: "ENOENT",
  });
});
