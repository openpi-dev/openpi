import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readNativeSearchEvidence } from "../../../extensions/web-search/native.ts";
import { webSearchConnection } from "../../../extensions/web-search/support.ts";

const root = mkdtempSync(join(tmpdir(), "openpi-native-search-"));
process.env.PI_CODING_AGENT_DIR = root;
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { default: webSearch } = await import(
  "../../../extensions/web-search/index.ts"
);
after(() => rmSync(root, { recursive: true, force: true }));

test("native Pi requests use the current model/auth, gate search, persist/reload replay, isolate Sessions and abort conflicting tools", async (t) => {
  const requests: Record<string, unknown>[] = [];
  const auth: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as Record<string, unknown>;
    requests.push(payload);
    auth.push(request.headers.authorization ?? "");
    const id = String(requests.length);
    const tools = payload.tools as { type: string }[];
    const native = tools.some((tool) => tool.type === "web_search");
    const output = [
      ...(native
        ? [
            {
              type: "web_search_call",
              id: `ws_${id}`,
              status: "completed",
              action: { type: "search", query: `query-${id}` },
            },
          ]
        : []),
      {
        type: "message",
        id: `msg_${id}`,
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Slovenia.",
            annotations: native
              ? [
                  {
                    type: "url_citation",
                    start_index: 0,
                    end_index: 9,
                    url: "https://www.iana.org/domains/root/db/si.html",
                    title: "IANA",
                  },
                ]
              : [],
          },
        ],
      },
    ];
    const events = [
      { type: "response.created", response: { id: `resp_${id}` } },
      ...output.map((item, output_index) => ({
        type: "response.output_item.done",
        output_index,
        item,
      })),
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
  modelRuntime.registerProvider("native-search-fixture", {
    api: "openai-responses",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models: ["current", "other", "gpt-5"].map((id) => ({
      id,
      name: id,
      reasoning: id === "gpt-5",
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  await modelRuntime.setRuntimeApiKey("native-search-fixture", "fixture-key");
  const model = modelRuntime.getModel("native-search-fixture", "current")!;
  const configure = (
    enabled: boolean,
    declared = false,
    selectedModel = model,
  ) =>
    writeFileSync(
      join(root, "my-pi-setup.json"),
      JSON.stringify({
        webSearch: {
          enabled,
          modelSupport: declared
            ? [{ ...webSearchConnection(selectedModel), supported: true }]
            : [],
        },
      }),
    );
  const makeSession = async (
    manager = SessionManager.create(root, join(root, "sessions")),
    extra?: ExtensionFactory,
  ) => {
    const settingsManager = SettingsManager.inMemory(
      { retry: { enabled: false }, compaction: { enabled: false } },
      { projectTrusted: false },
    );
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      extensionFactories: [webSearch, ...(extra ? [extra] : [])],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      modelRuntime,
      model,
    });
    await session.bindExtensions({ mode: "print" });
    t.after(() => session.dispose());
    return session;
  };
  const session = await makeSession();
  const hasNativeTool = (request: Record<string, unknown>) =>
    (request.tools as { type: string }[]).some(
      (tool) => tool.type === "web_search",
    );
  configure(false);
  assert.deepEqual(session.getActiveToolNames(), [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  await session.prompt("off");
  assert.equal(hasNativeTool(requests.at(-1)!), false);
  configure(true);
  await session.prompt("unknown connection");
  assert.equal(hasNativeTool(requests.at(-1)!), false);
  configure(true, true);
  await session.prompt("search");
  assert.equal(hasNativeTool(requests.at(-1)!), true);
  assert.equal(requests.at(-1)!.model, "current");
  const searched = session.messages.at(-1)!;
  assert.equal(
    readNativeSearchEvidence(searched)?.activities[0]?.status,
    "completed",
  );
  assert.match(JSON.stringify(searched), /\[IANA\]/u);
  const file = session.sessionManager.getSessionFile();
  assert.ok(file);
  configure(false, true);
  await session.prompt("disabled after search");
  assert.equal(hasNativeTool(requests.at(-1)!), false);
  assert.match(JSON.stringify(requests.at(-1)!.input), /web_search_call/u);
  const restored = await makeSession(SessionManager.open(file));
  await restored.prompt("restored history");
  assert.match(JSON.stringify(requests.at(-1)!.input), /web_search_call/u);
  await restored.setModel(
    modelRuntime.getModel("native-search-fixture", "other")!,
  );
  configure(true, true);
  await restored.prompt("changed current model");
  assert.equal(requests.at(-1)!.model, "other");
  assert.equal(hasNativeTool(requests.at(-1)!), false);
  assert.doesNotMatch(
    JSON.stringify(requests.at(-1)!.input),
    /web_search_call/u,
  );
  const otherSession = await makeSession();
  await Promise.all([
    session.prompt("session one"),
    otherSession.prompt("session two"),
  ]);
  const left = readNativeSearchEvidence(session.messages.at(-1));
  const right = readNativeSearchEvidence(otherSession.messages.at(-1));
  assert.ok(left && right);
  assert.notEqual(left.activities[0]?.id, right.activities[0]?.id);
  const conflict = await makeSession(undefined, (pi) =>
    pi.registerTool({
      name: "web_search",
      label: "Conflict",
      description: "fixture",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "must not run" }],
          details: {},
        };
      },
    }),
  );
  const before = requests.length;
  await conflict.prompt("must fail closed");
  assert.equal(requests.length, before);
  const last = conflict.messages.at(-1);
  assert.ok(last?.role === "assistant");
  assert.equal(last.stopReason, "error");
  assert.match(last.errorMessage ?? "", /Another extension owns/u);
  const minimalModel = modelRuntime.getModel("native-search-fixture", "gpt-5")!;
  await restored.setModel(minimalModel);
  restored.setThinkingLevel("minimal");
  configure(true, true, minimalModel);
  await restored.prompt("minimal reasoning cannot search");
  assert.equal(requests.at(-1)!.model, "gpt-5");
  assert.deepEqual(requests.at(-1)!.reasoning, {
    effort: "minimal",
    summary: "auto",
  });
  assert.equal(hasNativeTool(requests.at(-1)!), false);
  assert.ok(auth.every((header) => header === "Bearer fixture-key"));
});
