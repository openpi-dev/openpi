/** Targeted Cursor chat-only provider tests; all transport fixtures are local h2c. */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerHttp2Stream } from "node:http2";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai/compat";
import {
  AgentSession,
  type ExtensionContext,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  fetchCursorModels,
  fetchCursorUsableModels,
} from "../../../extensions/ai-providers/cursor/discovery.ts";
import { transformCursorImageInput } from "../../../extensions/ai-providers/cursor/input-images.ts";
import { CURSOR_MODELS } from "../../../extensions/ai-providers/cursor/models.ts";
import {
  generateCursorAuthParams,
  getCursorTokenExpiry,
  refreshCursorToken,
} from "../../../extensions/ai-providers/cursor/oauth.ts";
import {
  type AgentClientMessage,
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  GetUsableModelsResponseSchema,
  InteractionQueryPayloadSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  ModelDetailsSchema,
  TextDeltaUpdateSchema,
  ThinkingCompletedUpdateSchema,
  ThinkingDeltaUpdateSchema,
  ThinkingDetailsSchema,
  TokenDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../../../extensions/ai-providers/cursor/proto.ts";
import {
  create,
  fromBinary,
  toBinary,
} from "../../../extensions/ai-providers/cursor/protobuf.ts";
import {
  buildCursorRequest,
  CURSOR_CHAT_ONLY_SYSTEM_PROMPT,
  frameConnectMessage,
  streamCursor,
} from "../../../extensions/ai-providers/cursor/provider.ts";

const MODEL: Model<Api> = {
  ...CURSOR_MODELS[0]!,
  baseUrl: "",
};

const CONTEXT: Context = {
  systemPrompt: "Follow the system rule.",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const CURSOR_PROXY_VARIABLES = [
  "PI_PROXY_CURSOR",
  "PI_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

async function withCleanProxyEnvironment<T>(run: () => Promise<T>) {
  const originalEnvironment = new Map(
    CURSOR_PROXY_VARIABLES.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of CURSOR_PROXY_VARIABLES) delete process.env[name];
    return await run();
  } finally {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function piVersionAtLeast(
  version: string,
  minimum: readonly number[],
): boolean {
  const current = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index++) {
    const currentPart = current[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (currentPart !== minimumPart) return currentPart > minimumPart;
  }
  return true;
}

function localModel(baseUrl: string): Model<Api> {
  return { ...MODEL, baseUrl };
}

function frameServerMessage(message: Parameters<typeof toBinary>[1]): Buffer {
  return frameConnectMessage(
    toBinary(AgentServerMessageSchema, message as never),
  );
}

function responseUpdate(message: Parameters<typeof toBinary>[1]): Buffer {
  return frameServerMessage(
    create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: message as never,
      },
    }),
  );
}

function collectEvents(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
  return (async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
}

async function startServer(
  handler: (
    stream: ServerHttp2Stream,
    headers: Record<string, string | string[] | undefined>,
  ) => void,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer();
  server.on("stream", (stream, headers) => {
    handler(
      stream as ServerHttp2Stream,
      headers as Record<string, string | string[] | undefined>,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (server.listening) server.close();
      await once(server, "close").catch(() => undefined);
    },
  };
}

function appendChunk(buffer: Buffer, chunk: Buffer | string): Buffer {
  return Buffer.concat([
    buffer,
    typeof chunk === "string" ? Buffer.from(chunk) : chunk,
  ]);
}

const servers: Array<{ close(): Promise<void> }> = [];
const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("Cursor OAuth uses PKCE and preserves refresh token when refresh response omits it", async () => {
  const auth = await generateCursorAuthParams();
  const loginUrl = new URL(auth.loginUrl);
  assert.equal(loginUrl.origin, "https://cursor.com");
  assert.equal(loginUrl.pathname, "/loginDeepControl");
  assert.equal(loginUrl.searchParams.get("challenge"), auth.challenge);
  assert.equal(loginUrl.searchParams.get("uuid"), auth.uuid);
  assert.equal(loginUrl.searchParams.get("mode"), "login");
  assert.equal(loginUrl.searchParams.get("redirectTarget"), "cli");

  const now = Math.floor(Date.now() / 1_000);
  const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: now + 3_600 })).toString("base64url")}.sig`;
  assert.equal(getCursorTokenExpiry(token), (now + 3_600) * 1_000 - 300_000);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer old-refresh",
      );
      assert.equal(init?.body, "{}");
      return new Response(JSON.stringify({ accessToken: token }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const refreshed = await refreshCursorToken(
      { access: "old-access", refresh: "old-refresh", expires: 0 },
      new AbortController().signal,
    );
    assert.equal(refreshed.access, token);
    assert.equal(refreshed.refresh, "old-refresh");
    assert.equal(refreshed.expires, getCursorTokenExpiry(token));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cursor request encodes image content in the selected image protobuf", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 250]);
  const built = await buildCursorRequest(MODEL, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: "image/png",
          },
        ],
        timestamp: 0,
      },
    ],
  });
  const client = fromBinary(AgentClientMessageSchema, built.requestBytes);
  assert.ok(client.message.case === "runRequest");
  const action = client.message.value.action?.action;
  assert.ok(action?.case === "userMessageAction");
  const selectedImage =
    action.value.userMessage?.selectedContext?.selectedImages[0];
  assert.ok(selectedImage?.dataOrBlobId.case === "data");
  assert.deepEqual([...selectedImage.dataOrBlobId.value], [...bytes]);
  assert.equal(selectedImage.mimeType, "image/png");
});

test("Cursor pins bare Composer 2.5 to the Standard lane", async () => {
  const standard = await buildCursorRequest(
    { ...MODEL, id: "composer-2.5" },
    CONTEXT,
  );
  assert.equal(standard.request.requestedModel?.modelId, "composer-2.5");
  assert.deepEqual(
    standard.request.requestedModel?.parameters.map(({ id, value }) => ({
      id,
      value,
    })),
    [{ id: "fast", value: "false" }],
  );

  const fast = await buildCursorRequest(
    { ...MODEL, id: "composer-2.5-fast" },
    CONTEXT,
  );
  assert.deepEqual(fast.request.requestedModel?.parameters, []);
});

test("Cursor interactive input turns an explicit leading image path into ImageContent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-cursor-image-"));
  tempDirectories.push(directory);
  const imagePath = join(directory, "pasted.png");
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  await writeFile(imagePath, png);

  const result = await transformCursorImageInput(
    {
      type: "input",
      text: `${imagePath} 这个图中说了什么`,
      source: "interactive",
    },
    { model: { provider: "cursor" } } as ExtensionContext,
  );

  assert.equal(result.action, "transform");
  assert.ok(result.action === "transform");
  assert.doesNotMatch(result.text, new RegExp(directory));
  assert.match(result.text, /Attached image: "pasted\.png"/);
  assert.match(result.text, /这个图中说了什么/);
  assert.equal(result.images?.[0]?.mimeType, "image/png");
  assert.equal(result.images?.[0]?.data, png.toString("base64"));
});

test("Cursor image-path conversion is scoped to interactive Cursor input", async () => {
  const event = {
    type: "input" as const,
    text: "/does/not/exist.png describe this",
    source: "interactive" as const,
  };
  assert.deepEqual(
    await transformCursorImageInput(event, {
      model: { provider: "google-antigravity" },
    } as ExtensionContext),
    { action: "continue" },
  );
  assert.deepEqual(
    await transformCursorImageInput({ ...event, source: "rpc" }, {
      model: { provider: "cursor" },
    } as ExtensionContext),
    { action: "continue" },
  );
});

test("Cursor multi-turn request omits prior thinking outside OMP's Kimi-only replay", async () => {
  const built = await buildCursorRequest(MODEL, {
    messages: [
      { role: "user", content: "first", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private-thought" },
          { type: "text", text: "visible-answer" },
        ],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "old-call",
        toolName: "read",
        content: [{ type: "text", text: "orphan-tool-result" }],
        isError: false,
        timestamp: 1,
      },
      { role: "user", content: "second", timestamp: 2 },
    ],
  });
  const stored = [...built.blobStore.values()]
    .map((value) => new TextDecoder().decode(value))
    .join("\n");
  assert.match(stored, /This Cursor provider is running in chat-only mode/);
  assert.match(stored, /visible-answer/);
  assert.doesNotMatch(stored, /private-thought/);
  assert.doesNotMatch(stored, /orphan-tool-result/);
});

test("Cursor discovery decodes Connect unary models and preserves the HTTP/2 endpoint", async () => {
  const seenHeaders: Record<string, string | string[] | undefined>[] = [];
  const server = await startServer((stream, headers) => {
    seenHeaders.push(headers);
    stream.respond({
      ":status": 200,
      "content-type": "application/proto",
    });
    stream.on("data", () => undefined);
    const response = create(GetUsableModelsResponseSchema, {
      models: [
        create(ModelDetailsSchema, {
          modelId: "claude-sonnet-1m",
          displayName: "Claude Sonnet 1M",
          thinkingDetails: create(ThinkingDetailsSchema, {}),
        }),
        create(ModelDetailsSchema, {
          modelId: "text-only",
          displayName: "Text Only",
        }),
      ],
    });
    stream.end(toBinary(GetUsableModelsResponseSchema, response));
  });
  servers.push(server);
  const models = await fetchCursorUsableModels({
    apiKey: "discovery-token",
    baseUrl: server.baseUrl,
  });
  assert.ok(models);
  assert.deepEqual(
    models.map((model) => model.id),
    ["claude-sonnet-1m", "text-only"],
  );
  assert.equal(models[0]?.baseUrl, server.baseUrl);
  assert.equal(models[0]?.reasoning, true);
  assert.deepEqual(models[0]?.input, ["text", "image"]);
  assert.equal(models[0]?.contextWindow, 1_000_000);
  assert.equal(models[1]?.input[0], "text");
  assert.equal(
    seenHeaders[0]?.[":path"],
    "/agent.v1.AgentService/GetUsableModels",
  );
  assert.equal(seenHeaders[0]?.authorization, "Bearer discovery-token");
  assert.equal(seenHeaders[0]?.["content-type"], "application/proto");
  assert.equal(seenHeaders[0]?.["connect-protocol-version"], undefined);
});

test("Cursor discovery aligns Max Mode and uses conservative context fallbacks", async () => {
  const server = await startServer((stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "application/proto",
    });
    stream.on("data", () => undefined);
    stream.end(
      toBinary(
        GetUsableModelsResponseSchema,
        create(GetUsableModelsResponseSchema, {
          models: [
            create(ModelDetailsSchema, {
              modelId: "claude-opus-5-fast",
              displayName: "Claude Opus 5 Fast",
              maxMode: true,
            }),
            create(ModelDetailsSchema, {
              modelId: "cursor-composer-max",
              displayName: "Cursor Composer Max",
              maxMode: true,
            }),
            create(ModelDetailsSchema, {
              modelId: "composer-2.5",
              displayName: "Composer 2.5",
            }),
            create(ModelDetailsSchema, {
              modelId: "gemini-3.1-pro",
              displayName: "Gemini 3.1 Pro",
              maxMode: true,
            }),
            create(ModelDetailsSchema, {
              modelId: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              maxMode: true,
            }),
            create(ModelDetailsSchema, {
              modelId: "claude-fable-5",
              displayName: "Claude Fable 5",
            }),
            create(ModelDetailsSchema, {
              modelId: "gpt-5.6-terra",
              displayName: "GPT-5.6 Terra",
            }),
            create(ModelDetailsSchema, {
              modelId: "cursor-grok-4.6-high",
              displayName: "Grok 4.6 High",
            }),
            create(ModelDetailsSchema, {
              modelId: "moonshotai/kimi-k3",
              displayName: "Kimi K3",
            }),
            create(ModelDetailsSchema, {
              modelId: "z-ai/glm-5.2-turbo",
              displayName: "GLM 5.2 Turbo",
            }),
            create(ModelDetailsSchema, {
              modelId: "z-ai/glm-5.2-flash",
              displayName: "GLM 5.2 Flash",
            }),
          ],
        }),
      ),
    );
  });
  servers.push(server);

  const models = await fetchCursorUsableModels({
    apiKey: "discovery-token",
    baseUrl: server.baseUrl,
  });
  assert.ok(models);
  const byId = new Map(models.map((model) => [model.id, model]));
  const maxClaude = byId.get("claude-opus-5-fast");
  assert.equal(maxClaude?.cursorMaxMode, true);
  assert.equal(maxClaude?.contextWindow, 1_000_000);
  assert.equal(byId.get("cursor-composer-max")?.contextWindow, 200_000);
  assert.deepEqual(byId.get("composer-2.5")?.input, ["text", "image"]);
  assert.equal(byId.get("gemini-3.1-pro")?.contextWindow, 1_000_000);
  assert.equal(byId.get("gpt-5.6-sol")?.contextWindow, 1_000_000);
  assert.equal(byId.get("claude-fable-5")?.contextWindow, 200_000);
  assert.equal(byId.get("gpt-5.6-terra")?.contextWindow, 200_000);
  assert.equal(byId.get("cursor-grok-4.6-high")?.contextWindow, 200_000);
  assert.deepEqual(byId.get("cursor-grok-4.6-high")?.input, ["text", "image"]);
  assert.equal(byId.get("moonshotai/kimi-k3")?.contextWindow, 1_000_000);
  assert.deepEqual(byId.get("moonshotai/kimi-k3")?.input, ["text", "image"]);
  assert.equal(byId.get("z-ai/glm-5.2-turbo")?.contextWindow, 1_000_000);
  assert.equal(byId.get("z-ai/glm-5.2-flash")?.contextWindow, 200_000);
  assert.ok(maxClaude);
  const built = await buildCursorRequest(maxClaude as Model<Api>, CONTEXT);
  assert.equal(built.request.modelDetails?.maxMode, true);
  assert.equal(built.request.requestedModel?.maxMode, true);
});

test("Cursor discovery and chat HTTP/2 transports honor configured proxies", async () => {
  await withCleanProxyEnvironment(async () => {
    for (const variable of ["HTTPS_PROXY", "PI_PROXY_CURSOR"] as const) {
      for (const name of CURSOR_PROXY_VARIABLES) delete process.env[name];
      const connectTargets: string[] = [];
      const proxy = createNetServer((socket) => {
        socket.once("data", (chunk) => {
          const firstLine = chunk.toString("utf8").split("\r\n")[0] ?? "";
          const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.1$/.exec(firstLine);
          if (match?.[1]) connectTargets.push(match[1]);
          socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        });
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const address = proxy.address();
      assert.ok(address && typeof address === "object");
      process.env[variable] = `http://127.0.0.1:${address.port}`;

      try {
        const baseUrl = "https://198.51.100.7:8443";
        assert.equal(
          await fetchCursorUsableModels({
            apiKey: "token",
            baseUrl,
            timeoutMs: 1_000,
          }),
          null,
        );
        const events = await collectEvents(
          streamCursor(localModel(baseUrl), CONTEXT, { apiKey: "token" }),
        );
        assert.equal(events.at(-1)?.type, "error");
        assert.deepEqual(connectTargets, [
          "198.51.100.7:8443",
          "198.51.100.7:8443",
        ]);
      } finally {
        proxy.close();
        await once(proxy, "close").catch(() => undefined);
      }
    }
  });
});

test("Cursor rejects malformed proxy credentials before opening a tunnel", async () => {
  await withCleanProxyEnvironment(async () => {
    let connections = 0;
    const proxy = createNetServer(() => {
      connections += 1;
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    process.env.PI_PROXY_CURSOR = `http://user%ZZ:pass@127.0.0.1:${address.port}`;

    try {
      const events = await collectEvents(
        streamCursor(localModel("https://198.51.100.7:8443"), CONTEXT, {
          apiKey: "token",
        }),
      );
      const error = events.at(-1);
      assert.ok(error?.type === "error");
      assert.match(
        error.error.errorMessage ?? "",
        /proxy credentials contain invalid percent-encoding/,
      );
      assert.equal(connections, 0);
    } finally {
      proxy.close();
      await once(proxy, "close").catch(() => undefined);
    }
  });
});

test("Cursor request timeout bounds a hanging proxy CONNECT", {
  timeout: 1_000,
}, async () => {
  await withCleanProxyEnvironment(async () => {
    const proxy = createNetServer((socket) => {
      socket.on("data", () => undefined);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert.ok(address && typeof address === "object");
    process.env.PI_PROXY_CURSOR = `http://127.0.0.1:${address.port}`;

    try {
      const startedAt = Date.now();
      const events = await collectEvents(
        streamCursor(localModel("https://198.51.100.7:8443"), CONTEXT, {
          apiKey: "token",
          timeoutMs: 20,
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      const error = events.at(-1);
      assert.ok(error?.type === "error");
      assert.match(
        error.error.errorMessage ?? "",
        /proxy tunnel timed out after 20ms/,
      );
      assert.ok(elapsedMs < 250, `request took ${elapsedMs}ms`);
    } finally {
      proxy.close();
      await once(proxy, "close").catch(() => undefined);
    }
  });
});

test("Cursor stream sends required headers and maps Connect text/thinking/done frames", async () => {
  const seenHeaders: Record<string, string | string[] | undefined>[] = [];
  const server = await startServer((stream, headers) => {
    seenHeaders.push(headers);
    stream.respond({
      ":status": 200,
      "content-type": "application/connect+proto",
    });
    let requestBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    stream.on("data", (chunk) => {
      requestBytes = appendChunk(requestBytes, chunk);
      if (requestBytes.length < 5) return;
      const length = requestBytes.readUInt32BE(1);
      if (requestBytes.length < length + 5) return;
      const client = fromBinary(
        AgentClientMessageSchema,
        requestBytes.subarray(5, length + 5),
      );
      requestBytes = requestBytes.subarray(length + 5);
      if (client.message.case !== "runRequest") return;

      const frames = [
        responseUpdate(
          create(InteractionUpdateSchema, {
            message: {
              case: "thinkingDelta",
              value: create(ThinkingDeltaUpdateSchema, { text: "think" }),
            },
          }),
        ),
        responseUpdate(
          create(InteractionUpdateSchema, {
            message: {
              case: "thinkingCompleted",
              value: create(ThinkingCompletedUpdateSchema, {
                thinkingDurationMs: 7,
              }),
            },
          }),
        ),
        responseUpdate(
          create(InteractionUpdateSchema, {
            message: {
              case: "textDelta",
              value: create(TextDeltaUpdateSchema, { text: "hello" }),
            },
          }),
        ),
        responseUpdate(
          create(InteractionUpdateSchema, {
            message: {
              case: "turnEnded",
              value: create(TurnEndedUpdateSchema, {}),
            },
          }),
        ),
      ];
      const payload = Buffer.concat(frames);
      stream.write(payload.subarray(0, 3));
      setTimeout(() => {
        stream.write(payload.subarray(3));
        stream.end();
      }, 2);
    });
  });
  servers.push(server);

  const onResponses: Array<{
    status: number;
    headers: Record<string, string>;
  }> = [];
  const events = await collectEvents(
    streamCursor(localModel(server.baseUrl), CONTEXT, {
      apiKey: "access-token",
      headers: { "x-trace-id": "trace", authorization: "caller-must-not-win" },
      onResponse(response) {
        onResponses.push(response);
      },
    }),
  );

  assert.equal(seenHeaders.length, 1);
  const headers = seenHeaders[0]!;
  assert.equal(headers[":path"], "/agent.v1.AgentService/Run");
  assert.equal(headers["content-type"], "application/connect+proto");
  assert.equal(headers["connect-protocol-version"], "1");
  assert.equal(headers.te, "trailers");
  assert.equal(headers.authorization, "Bearer access-token");
  assert.equal(headers["x-ghost-mode"], "true");
  assert.equal(headers["x-cursor-client-type"], "cli");
  assert.equal(headers["x-cursor-client-version"], "cli-2026.07.23-e383d2b");
  assert.equal(headers["x-trace-id"], "trace");
  assert.match(String(headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    onResponses.map((response) => response.status),
    [200],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ],
  );
  const done = events.at(-1);
  assert.ok(done?.type === "done");
  assert.deepEqual(done.message.content, [
    { type: "thinking", thinking: "think" },
    { type: "text", text: "hello" },
  ]);
  assert.equal(
    events.some((event) => event.type.startsWith("toolcall")),
    false,
  );
});

test("Cursor routes malformed gRPC trailer encoding to a stream error", async () => {
  const server = await startServer((stream) => {
    stream.respond(
      {
        ":status": 200,
        "content-type": "application/connect+proto",
      },
      { waitForTrailers: true },
    );
    stream.once("wantTrailers", () => {
      stream.sendTrailers({
        "grpc-status": "13",
        "grpc-message": "bad%ZZ",
      });
    });
    stream.once("data", () => stream.end());
  });
  servers.push(server);

  const events = await collectEvents(
    streamCursor(localModel(server.baseUrl), CONTEXT, { apiKey: "token" }),
  );
  const error = events.at(-1);
  assert.ok(error?.type === "error");
  assert.match(
    error.error.errorMessage ?? "",
    /gRPC error 13 contains a malformed grpc-message trailer/,
  );
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
});

test("Cursor output-only token deltas preserve Pi's real compaction boundary", async () => {
  const server = await startServer((stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "application/connect+proto",
    });
    let requestBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    stream.on("data", (chunk) => {
      requestBytes = appendChunk(requestBytes, chunk);
      if (requestBytes.length < 5) return;
      const length = requestBytes.readUInt32BE(1);
      if (requestBytes.length < length + 5) return;
      const client = fromBinary(
        AgentClientMessageSchema,
        requestBytes.subarray(5, length + 5),
      );
      requestBytes = requestBytes.subarray(length + 5);
      if (client.message.case !== "runRequest") return;
      stream.end(
        Buffer.concat([
          responseUpdate(
            create(InteractionUpdateSchema, {
              message: {
                case: "textDelta",
                value: create(TextDeltaUpdateSchema, { text: "OK" }),
              },
            }),
          ),
          responseUpdate(
            create(InteractionUpdateSchema, {
              message: {
                case: "tokenDelta",
                value: create(TokenDeltaUpdateSchema, { tokens: 2 }),
              },
            }),
          ),
          responseUpdate(
            create(InteractionUpdateSchema, {
              message: {
                case: "turnEnded",
                value: create(TurnEndedUpdateSchema, {}),
              },
            }),
          ),
        ]),
      );
    });
  });
  servers.push(server);

  const user = {
    role: "user" as const,
    content: "x".repeat(800_000),
    timestamp: 0,
  };
  const events = await collectEvents(
    streamCursor(
      localModel(server.baseUrl),
      { systemPrompt: "", messages: [user] },
      { apiKey: "token" },
    ),
  );
  const done = events.at(-1);
  assert.ok(done?.type === "done");
  assert.deepEqual(done.message.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const compactionCalls: Array<{ reason: string; willRetry: boolean }> = [];
  const session = {
    settingsManager: {
      getCompactionSettings: () => ({
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      }),
    },
    model: { ...MODEL, contextWindow: 200_000 },
    sessionManager: { getBranch: () => [] },
    agent: { state: { messages: [user, done.message] } },
    _overflowRecoveryAttempted: false,
    _emit: () => {},
    _runAutoCompaction: async (reason: string, willRetry: boolean) => {
      compactionCalls.push({ reason, willRetry });
      return true;
    },
  };
  const checkCompaction = (
    AgentSession.prototype as unknown as {
      _checkCompaction: (
        this: unknown,
        message: AssistantMessage,
      ) => Promise<boolean>;
    }
  )._checkCompaction;
  const compacted = await checkCompaction.call(session, done.message);
  const hostSupportsZeroUsageCompaction = piVersionAtLeast(
    PI_VERSION,
    [0, 84, 3],
  );

  assert.equal(compacted, hostSupportsZeroUsageCompaction);
  assert.deepEqual(
    compactionCalls,
    hostSupportsZeroUsageCompaction
      ? [{ reason: "threshold", willRetry: false }]
      : [],
  );
});

test("Cursor request_context succeeds with global rules and empty tools; other exec is thrown", {
  timeout: 1_000,
}, async () => {
  const replies: AgentClientMessage[] = [];
  const streamCloseReceived = Promise.withResolvers<void>();
  const server = await startServer((stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "application/connect+proto",
    });
    let requestBytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let sent = false;
    stream.on("data", (chunk) => {
      requestBytes = appendChunk(requestBytes, chunk);
      while (requestBytes.length >= 5) {
        const length = requestBytes.readUInt32BE(1);
        if (requestBytes.length < length + 5) return;
        const client = fromBinary(
          AgentClientMessageSchema,
          requestBytes.subarray(5, length + 5),
        );
        requestBytes = requestBytes.subarray(length + 5);
        if (client.message.case === "runRequest" && !sent) {
          sent = true;
          const contextExec = create(ExecServerMessageSchema, {
            id: 11,
            execId: "ctx",
            message: {
              case: "requestContextArgs",
              value: { $typeName: "agent.v1.RequestContextArgs" },
            },
          });
          const unsupportedExec = create(ExecServerMessageSchema, {
            id: 12,
            execId: "tool",
            message: { case: undefined },
          });
          for (const exec of [contextExec, unsupportedExec]) {
            stream.write(
              frameServerMessage(
                create(AgentServerMessageSchema, {
                  message: { case: "execServerMessage", value: exec },
                }),
              ),
            );
          }
        } else if (
          client.message.case === "execClientMessage" ||
          client.message.case === "execClientControlMessage"
        ) {
          replies.push(client);
          if (
            client.message.case === "execClientControlMessage" &&
            client.message.value.message.case === "streamClose"
          ) {
            streamCloseReceived.resolve();
            stream.write(
              responseUpdate(
                create(InteractionUpdateSchema, {
                  message: {
                    case: "turnEnded",
                    value: create(TurnEndedUpdateSchema, {}),
                  },
                }),
              ),
            );
            setTimeout(() => stream.end(), 2);
          }
        }
      }
    });
  });
  servers.push(server);

  const events = await collectEvents(
    streamCursor(localModel(server.baseUrl), CONTEXT, { apiKey: "token" }),
  );
  await streamCloseReceived.promise;
  const contextReply = replies.find(
    (reply) =>
      reply.message.case === "execClientMessage" &&
      reply.message.value.message.case === "requestContextResult",
  );
  assert.ok(contextReply?.message.case === "execClientMessage");
  const contextMessage = contextReply.message.value.message;
  assert.ok(contextMessage.case === "requestContextResult");
  assert.equal(contextMessage.value.result.case, "success");
  const requestContext = contextMessage.value.result.value.requestContext;
  assert.deepEqual(requestContext?.tools, []);
  assert.equal(requestContext?.rules[0]?.content, CONTEXT.systemPrompt);
  assert.equal(requestContext?.rules[0]?.type?.type.case, "global");
  assert.equal(
    requestContext?.rules[1]?.content,
    CURSOR_CHAT_ONLY_SYSTEM_PROMPT,
  );
  assert.equal(requestContext?.rules[1]?.fullPath, "/pi/cursor-chat-only.mdc");
  const throwReply = replies.find(
    (reply) =>
      reply.message.case === "execClientControlMessage" &&
      reply.message.value.message.case === "throw",
  );
  assert.ok(throwReply?.message.case === "execClientControlMessage");
  const throwMessage = throwReply.message.value.message;
  assert.ok(throwMessage.case === "throw");
  assert.equal(throwMessage.value.errorCode, "UNIMPLEMENTED");
  const terminal = events.at(-1);
  assert.ok(terminal?.type === "error");
  assert.match(
    terminal.error.errorMessage ?? "",
    /unavailable in chat-only mode/,
  );
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
  assert.equal(
    events.some((event) => event.type.startsWith("toolcall")),
    false,
  );
});

test("Cursor tool interaction and interactionQuery fail explicitly without a Pi toolCall", async () => {
  const cases: Array<"tool" | "query"> = ["tool", "query"];
  for (const kind of cases) {
    const server = await startServer((stream) => {
      stream.respond({
        ":status": 200,
        "content-type": "application/connect+proto",
      });
      stream.on("data", (chunk) => {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        if (bytes.length < 5) return;
        const length = bytes.readUInt32BE(1);
        if (bytes.length < length + 5) return;
        const client = fromBinary(
          AgentClientMessageSchema,
          bytes.subarray(5, length + 5),
        );
        if (client.message.case !== "runRequest") return;
        const message =
          kind === "tool"
            ? create(AgentServerMessageSchema, {
                message: {
                  case: "interactionUpdate",
                  value: create(InteractionUpdateSchema, {
                    message: { case: "toolCallStarted", value: {} },
                  }),
                },
              })
            : create(AgentServerMessageSchema, {
                message: {
                  case: "interactionQuery",
                  value: create(InteractionQuerySchema, {
                    id: 1,
                    query: {
                      case: "askQuestionInteractionQuery",
                      value: create(InteractionQueryPayloadSchema, {}),
                    },
                  }),
                },
              });
        stream.end(frameServerMessage(message));
      });
    });
    servers.push(server);
    const events = await collectEvents(
      streamCursor(localModel(server.baseUrl), CONTEXT, { apiKey: "token" }),
    );
    const error = events.find((event) => event.type === "error");
    assert.ok(error?.type === "error");
    assert.match(
      error.error.errorMessage ?? "",
      /unavailable in chat-only mode/,
    );
    assert.equal(
      events.some((event) => event.type.startsWith("toolcall")),
      false,
    );
  }
});

test("Cursor abort produces an aborted error and native fetch skips network offline", async () => {
  const controller = new AbortController();
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const server = await startServer((stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "application/connect+proto",
    });
    requestStarted();
    stream.on("data", () => undefined);
  });
  servers.push(server);
  const eventsPromise = collectEvents(
    streamCursor(localModel(server.baseUrl), CONTEXT, {
      apiKey: "token",
      signal: controller.signal,
    }),
  );
  await started;
  controller.abort();
  const events = await eventsPromise;
  const error = events.at(-1);
  assert.ok(error?.type === "error");
  assert.equal(error.reason, "aborted");

  const models = await fetchCursorModels({
    allowNetwork: false,
    publish: async () => true,
    signal: new AbortController().signal,
  });
  assert.deepEqual(models, []);
  assert.equal(CURSOR_MODELS[0]?.id, "default");
});

test("Cursor rejects custom fetch and bounds an idle HTTP/2 stream", async () => {
  const customFetchEvents = await collectEvents(
    streamCursor(MODEL, CONTEXT, {
      apiKey: "token",
      fetch: async () => new Response(),
    }),
  );
  const customFetchError = customFetchEvents.at(-1);
  assert.ok(customFetchError?.type === "error");
  assert.match(
    customFetchError.error.errorMessage ?? "",
    /does not support options\.fetch/,
  );

  const server = await startServer((stream) => {
    stream.respond({
      ":status": 200,
      "content-type": "application/connect+proto",
    });
    stream.on("data", () => undefined);
  });
  servers.push(server);
  const timeoutEvents = await collectEvents(
    streamCursor(localModel(server.baseUrl), CONTEXT, {
      apiKey: "token",
      timeoutMs: 10,
    }),
  );
  const timeoutError = timeoutEvents.at(-1);
  assert.ok(timeoutError?.type === "error");
  assert.match(
    timeoutError.error.errorMessage ?? "",
    /idle timeout after 10ms/,
  );
});
