import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
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

test("Pi Anthropic conversion assigns repeated saved answers by retained order", async (t) => {
  const { streamSimple } = await import(
    "@earendil-works/pi-ai/api/anthropic-messages"
  );
  const { normalizeContext } = await import(
    "@earendil-works/pi-ai/utils/transcript"
  );
  const { replayNativeSearch } = await import(
    "../../../extensions/web-search/native.ts"
  );
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    const events = [
      {
        type: "message_start",
        message: {
          id: "reply",
          type: "message",
          role: "assistant",
          content: [],
          model: "fixture",
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Done." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const model = {
    api: "anthropic-messages" as const,
    id: "fixture",
    name: "fixture",
    provider: "anthropic",
    baseUrl: `http://127.0.0.1:${address.port}`,
    reasoning: false,
    input: ["text" as const],
    contextWindow: 128000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const message = {
    role: "assistant" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: "text" as const, text: "Done." }],
    stopReason: "stop" as const,
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const searched = (id: string) =>
    JSON.parse(
      JSON.stringify({
        ...message,
        openpiWebSearch: {
          version: 1,
          adapter: "anthropic",
          connection: webSearchConnection(model),
          output: [
            {
              type: "server_tool_use",
              id,
              name: "web_search",
              input: { query: id },
            },
            { type: "text", text: "Done." },
          ],
          activities: [],
        },
      }),
    ) as typeof message;
  const first = searched("first"),
    second = searched("second");
  const messages = [
    { ...message, content: [{ type: "text" as const, text: " " }] },
    { ...message, stopReason: "error" as const },
    message,
    first,
    second,
  ];
  for (const retained of [messages, [second]]) {
    const stream = streamSimple(
      model,
      normalizeContext({ messages: retained }),
      {
        apiKey: "fixture",

        onPayload(payload) {
          assert.ok(
            payload && typeof payload === "object" && !Array.isArray(payload),
          );
          return replayNativeSearch(
            payload as Record<string, unknown>,
            retained,
            model,
            "anthropic",
          );
        },
      },
    );
    const reply = await stream.result();
    assert.equal(reply.stopReason, "stop");
    const rows = requests.at(-1)!.messages as {
      role: string;
      content: unknown[];
    }[];
    if (retained.length > 1) {
      assert.deepEqual(rows[0]?.content, message.content);
      assert.deepEqual(
        rows[1]?.content,
        readNativeSearchEvidence(first)?.output,
      );
      assert.deepEqual(
        rows[2]?.content,
        readNativeSearchEvidence(second)?.output,
      );
    } else
      assert.deepEqual(
        rows[0]?.content,
        readNativeSearchEvidence(second)?.output,
      );
  }

  const variants: {
    content: AssistantMessage["content"];
    patch?: Partial<AssistantMessage>;
    expected: unknown[];
  }[] = [
    {
      content: [
        {
          type: "thinking",
          thinking: "signed",
          thinkingSignature: "opaque-signature",
        },
      ],
      expected: [
        { type: "thinking", thinking: "signed", signature: "opaque-signature" },
      ],
    },
    {
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "encrypted-redacted",
          redacted: true,
        },
      ],
      expected: [{ type: "redacted_thinking", data: "encrypted-redacted" }],
    },
    {
      content: [{ type: "thinking", thinking: "unsigned" }],
      expected: [{ type: "text", text: "unsigned" }],
    },
    {
      content: [
        { type: "thinking", thinking: "cross", thinkingSignature: "ignored" },
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: "dropped",
          redacted: true,
        },
      ],
      patch: { model: "other" },
      expected: [{ type: "text", text: "cross" }],
    },
    {
      content: [
        {
          type: "toolCall",
          id: "native-call",
          name: "read",
          arguments: { path: "file", nested: [1, true] },
        },
      ],
      expected: [
        {
          type: "tool_use",
          id: "native-call",
          name: "read",
          input: { path: "file", nested: [1, true] },
        },
      ],
    },
    {
      content: [
        { type: "toolCall", id: "cross|call", name: "read", arguments: {} },
      ],
      patch: { provider: "other" },
      expected: [
        { type: "tool_use", id: "cross_call", name: "read", input: {} },
      ],
    },
    {
      content: [{ type: "text", text: "x".repeat(270000) }],
      expected: [{ type: "text", text: "x".repeat(270000) }],
    },
    {
      content: [{ type: "text", text: "Unicode\ud800😀" }],
      expected: [{ type: "text", text: "Unicode😀" }],
    },
  ];
  const boundedFirst = JSON.parse(JSON.stringify(first)) as AssistantMessage;
  readNativeSearchEvidence(boundedFirst)!.output.splice(1, 0, {
    type: "web_search_tool_result",
    tool_use_id: "first",
    content: [{ encrypted_content: "opaque".repeat(39000) }],
  });
  for (const variant of variants) {
    const retained: AssistantMessage[] = [
      { ...message, ...variant.patch, content: variant.content },
      boundedFirst,
      second,
    ];
    const reply = await streamSimple(
      model,
      normalizeContext({ messages: retained }),
      {
        apiKey: "fixture",
        onPayload(payload) {
          return replayNativeSearch(
            payload as Record<string, unknown>,
            retained,
            model,
            "anthropic",
          );
        },
      },
    ).result();
    assert.equal(reply.stopReason, "stop");
    const rows = (
      requests.at(-1)!.messages as { role: string; content: unknown[] }[]
    ).filter((row) => row.role === "assistant");
    assert.deepEqual(rows[0]?.content, variant.expected);
    assert.deepEqual(
      rows[1]?.content,
      readNativeSearchEvidence(boundedFirst)?.output,
    );
    assert.deepEqual(
      rows[2]?.content,
      readNativeSearchEvidence(second)?.output,
    );
  }
  // Load the real extension through Pi/Jiti, rather than importing its factory.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, "anthropic-auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("anthropic", {
    api: "anthropic-messages",
    baseUrl: model.baseUrl,
    models: [
      {
        id: model.id,
        name: model.name,
        reasoning: false,
        input: ["text"],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: model.cost,
      },
    ],
  });
  await modelRuntime.setRuntimeApiKey("anthropic", "fixture");
  const nativeModel = modelRuntime.getModel("anthropic", "fixture")!;
  writeFileSync(
    join(root, "my-pi-setup.json"),
    JSON.stringify({ webSearch: { enabled: false } }),
  );
  const mutator = join(root, "altered-native-history.ts");
  writeFileSync(
    mutator,
    'export default function(pi) { pi.on("before_provider_request", ({payload}) => ({...payload, messages: payload.messages.map((row) => row.role === "assistant" ? {...row, content: [...row.content, {type:"text", text:"altered"}]} : row)})); }',
  );
  for (const altered of [false, true]) {
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
      additionalExtensionPaths: [
        ...(altered ? [mutator] : []),
        fileURLToPath(
          new URL("../../../extensions/web-search/index.ts", import.meta.url),
        ),
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const manager = SessionManager.inMemory(root);
    for (const item of messages) manager.appendMessage(item);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      settingsManager,
      resourceLoader: loader,
      sessionManager: manager,
      modelRuntime,
      model: nativeModel,
    });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "print" });
    const before = requests.length;
    await session.prompt("repeat after restoring disabled search");
    if (altered) {
      assert.equal(requests.length, before);
      const last = session.messages.at(-1);
      assert.ok(last?.role === "assistant");
      assert.equal(last.stopReason, "error");
      assert.match(last.errorMessage ?? "", /altered/u);
    } else {
      assert.equal(requests.length, before + 1);
      const rows = (
        requests.at(-1)!.messages as { role: string; content: unknown[] }[]
      ).filter((row) => row.role === "assistant");
      assert.deepEqual(rows[0]?.content, message.content);
      assert.deepEqual(
        rows[1]?.content,
        readNativeSearchEvidence(first)?.output,
      );
      assert.deepEqual(
        rows[2]?.content,
        readNativeSearchEvidence(second)?.output,
      );
    }
  }
});
