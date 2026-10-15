import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { projectSetupOutcome } from "../../../web/protocol/setup-outcome.ts";

const root = mkdtempSync(join(tmpdir(), "openpi-response-preferences-"));
process.env.PI_CODING_AGENT_DIR = root;
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { DEFAULT_SETUP_CONFIG, saveSetupConfig, SETUP_CONFIG_PATH } =
  await import("../../../extensions/shared/setup-config.ts");
const { default: setupExtension } = await import(
  "../../../extensions/setup/index.ts"
);
after(() => rmSync(root, { recursive: true, force: true }));

test("native Pi Responses requests honor persisted preferences without replacing native fields or effort", async (t) => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    const id = String(requests.length);
    const output = [
      {
        type: "message",
        id: `msg_${id}`,
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "Fixture response.", annotations: [] },
        ],
      },
    ];
    const events = [
      { type: "response.created", response: { id: `resp_${id}` } },
      { type: "response.output_item.done", output_index: 0, item: output[0] },
      {
        type: "response.completed",
        response: {
          id: `resp_${id}`,
          status: "completed",
          output,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("response-preferences-fixture", {
    api: "openai-responses",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: [
      { id: "reasoning", name: "Reasoning", reasoning: true },
      { id: "plain", name: "Plain", reasoning: false },
    ].map((model) => ({
      ...model,
      samplingParams: {
        text: { format: { type: "text" }, verbosity: "medium" },
        metadata: { fixture: "preserved" },
      },
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  await modelRuntime.setRuntimeApiKey(
    "response-preferences-fixture",
    "fixture-key",
  );
  const model = modelRuntime.getModel(
    "response-preferences-fixture",
    "reasoning",
  )!;
  const makeSession = async (
    manager = SessionManager.create(root, join(root, "sessions")),
    ownedWriter = true,
  ) => {
    const settingsManager = SettingsManager.inMemory(
      { retry: { enabled: false }, compaction: { enabled: false } },
      { projectTrusted: false },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      additionalExtensionPaths: ownedWriter
        ? [
            fileURLToPath(
              new URL("../../../extensions/setup/index.ts", import.meta.url),
            ),
          ]
        : [],
      extensionFactories: ownedWriter ? [] : [setupExtension],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      settingsManager,
      resourceLoader,
      sessionManager: manager,
      modelRuntime,
      model,
      thinkingLevel: "high",
    });
    await session.bindExtensions({ mode: "print" });
    t.after(() => session.dispose());
    return session;
  };
  const session = await makeSession();
  assert.equal(
    session.getActiveToolNames().includes("configure_my_pi_setup"),
    false,
  );
  await session.prompt("default preferences preserve native parameters");
  assert.equal(requests.length, 1);
  assert.equal(existsSync(SETUP_CONFIG_PATH), false);
  const baseline = requests[0]!;
  assert.deepEqual(baseline.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(baseline.text, {
    format: { type: "text" },
    verbosity: "medium",
  });
  await saveSetupConfig({
    ...DEFAULT_SETUP_CONFIG,
    response: { verbosity: "high", reasoningSummary: "none" },
  });
  await session.prompt("saved high verbosity and no reasoning summary");
  const changed = requests.at(-1)!;
  assert.equal(changed.model, "reasoning");
  assert.deepEqual(changed.reasoning, { effort: "high" });
  assert.deepEqual(changed.text, {
    format: { type: "text" },
    verbosity: "high",
  });
  assert.deepEqual(changed.metadata, baseline.metadata);
  assert.deepEqual(changed.tools, baseline.tools);
  assert.deepEqual(changed.include, baseline.include);
  assert.match(
    JSON.stringify(changed.input),
    /saved high verbosity and no reasoning summary/,
  );
  assert.equal(session.thinkingLevel, "high");
  const file = session.sessionManager.getSessionFile();
  assert.ok(file);
  const restored = await makeSession(SessionManager.open(file));
  await restored.prompt("reopened Session retains preferences");
  assert.deepEqual(requests.at(-1)!.reasoning, { effort: "high" });
  assert.equal(
    (requests.at(-1)!.text as { verbosity: string }).verbosity,
    "high",
  );
  await saveSetupConfig({
    ...DEFAULT_SETUP_CONFIG,
    response: { verbosity: "default", reasoningSummary: "concise" },
  });
  await restored.prompt("summary alone preserves native verbosity");
  assert.deepEqual(requests.at(-1)!.reasoning, {
    effort: "high",
    summary: "concise",
  });
  assert.deepEqual(requests.at(-1)!.text, baseline.text);
  await restored.setModel(
    modelRuntime.getModel("response-preferences-fixture", "plain")!,
  );
  await restored.prompt("model switch does not invent reasoning support");
  assert.equal(requests.at(-1)!.model, "plain");
  assert.equal(requests.at(-1)!.reasoning, undefined);
  assert.deepEqual(requests.at(-1)!.text, baseline.text);
  await restored.setModel(model);
  restored.setThinkingLevel("high");
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  await restored.prompt("reset restores native preferences");
  assert.deepEqual(requests.at(-1)!.reasoning, baseline.reasoning);
  assert.deepEqual(requests.at(-1)!.text, baseline.text);

  await t.test(
    "Pi command preflight failures persist closed receipts without a model turn or writer activation",
    async () => {
      const rejectSetup = async (
        target: typeof session,
        command: string,
        reason: string,
        message: RegExp,
      ) => {
        const count = requests.length;
        const tools = target.getActiveToolNames();
        let starts = 0;
        const unsubscribe = target.subscribe((event) => {
          if (event.type === "agent_start") starts++;
        });
        try {
          await target.prompt(command);
        } finally {
          unsubscribe();
        }
        assert.equal(starts, 0);
        assert.equal(requests.length, count);
        assert.deepEqual(target.getActiveToolNames(), tools);
        assert.equal(
          target.getActiveToolNames().includes("configure_my_pi_setup"),
          false,
        );
        const closed = target.sessionManager.getBranch().at(-1);
        assert.ok(closed?.type === "custom_message");
        assert.equal(closed.customType, "openpi-setup-closed");
        assert.deepEqual(closed.details, { reason });
        const outcome = projectSetupOutcome(
          target.sessionManager.getBranch(),
          false,
        );
        assert.equal(outcome?.requestId, closed.id);
        assert.equal(outcome.status, "failed");
        assert.match(outcome.error ?? "", message);
        assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_VALUE/);
        assert.deepEqual(
          projectSetupOutcome(target.sessionManager.getBranch(), true),
          outcome,
        );
        const sessionFile = target.sessionManager.getSessionFile();
        assert.ok(sessionFile);
        assert.deepEqual(
          projectSetupOutcome(
            SessionManager.open(sessionFile).getBranch(),
            false,
          ),
          outcome,
        );
      };
      for (const raw of [
        '{"PRIVATE_VALUE":',
        '{"configVersion":1,"response":{"verbosity":"PRIVATE_VALUE"}}',
      ]) {
        writeFileSync(SETUP_CONFIG_PATH, raw);
        await rejectSetup(
          restored,
          "/openpi-setup response verbosity high",
          "config_read_failed",
          /Configuration writes are blocked/,
        );
        assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), raw);
      }
      rmSync(SETUP_CONFIG_PATH);
      restored.sessionManager.appendCustomEntry("my-pi-setup-plan-mode-state", {
        version: 1,
        status: "planning",
      });
      await rejectSetup(
        restored,
        "/my-pi-setup response verbosity high",
        "plan_mode_active",
        /Exit Plan mode/,
      );
      restored.sessionManager.appendCustomEntry("my-pi-setup-plan-mode-state", {
        version: 1,
        status: "inactive",
      });
      const unverified = await makeSession(SessionManager.open(file), false);
      unverified.setActiveToolsByName(["read", "bash", "edit", "write"]);
      await rejectSetup(
        unverified,
        "/openpi-setup response verbosity high",
        "writer_activation_failed",
        /owned configuration writer/,
      );
    },
  );
});
