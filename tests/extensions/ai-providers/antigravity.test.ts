/**
 * Behavioral tests for the Antigravity provider: request envelope shape,
 * SSE-to-event mapping, endpoint failover, and credential codec. fetch is
 * mocked; no network access.
 */

import assert from "node:assert/strict";
import * as http from "node:http";
import { after, before, test } from "node:test";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai/compat";
import {
  type AntigravityCredentials,
  decodeApiKey,
  encodeApiKey,
} from "../../../extensions/ai-providers/antigravity/credentials.ts";
import { fetchAntigravityModels } from "../../../extensions/ai-providers/antigravity/discovery.ts";
import {
  convertMessages,
  isThinkingPart,
  mapStopReasonString,
  retainThoughtSignature,
} from "../../../extensions/ai-providers/antigravity/google-conversion.ts";
import { ANTIGRAVITY_MODELS } from "../../../extensions/ai-providers/antigravity/models.ts";
import {
  loginAntigravity,
  refreshAntigravityToken,
} from "../../../extensions/ai-providers/antigravity/oauth.ts";
import {
  buildRequestBody,
  sanitizeSchemaForCca,
  streamAntigravity,
} from "../../../extensions/ai-providers/antigravity/provider.ts";
import { collapseAntigravityModels } from "../../../extensions/ai-providers/antigravity/routing.ts";

const GEMINI_MODEL: Model<Api> = {
  id: "gemini-3.1-pro",
  name: "Gemini 3.1 Pro (Antigravity)",
  api: "antigravity-cloudcode",
  provider: "google-antigravity",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 64_000,
};

const CLAUDE_MODEL: Model<Api> = {
  ...GEMINI_MODEL,
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6 (Antigravity)",
};

const SIMPLE_CONTEXT: Context = {
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

const API_KEY = encodeApiKey({
  refresh: "r",
  access: "tok",
  expires: 0,
  projectId: "proj-1",
});

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sseResponse(events: unknown[]): Response {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

async function collectEvents(stream: AssistantMessageEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function getStatus(url: URL): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const request = http.get(url, (response) => {
    response.resume();
    response.once("end", () => resolve(response.statusCode ?? 0));
  });
  request.once("error", reject);
  return promise;
}

// --- credentials -----------------------------------------------------------

test("credentials codec round-trips and tolerates bare tokens", () => {
  const encoded = encodeApiKey({
    refresh: "r",
    access: "a",
    expires: 1,
    projectId: "p",
  });
  assert.deepEqual(decodeApiKey(encoded), { token: "a", projectId: "p" });
  assert.deepEqual(decodeApiKey("bare-token"), { token: "bare-token" });
  assert.deepEqual(decodeApiKey("{not json"), { token: "{not json" });
});

test("local Google conversion preserves only valid same-model signatures", () => {
  const contents = convertMessages(GEMINI_MODEL, {
    messages: [
      {
        role: "assistant",
        api: GEMINI_MODEL.api,
        provider: GEMINI_MODEL.provider,
        model: GEMINI_MODEL.id,
        content: [
          { type: "text", text: "", textSignature: "YWJjZA==" },
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "not-base64",
          },
        ],
        usage: ZERO_USAGE,
        stopReason: "stop",
        timestamp: 0,
      },
    ],
  });

  assert.deepEqual(contents, [
    {
      role: "model",
      parts: [
        { text: "", thoughtSignature: "YWJjZA==" },
        { thought: true, text: "reasoning" },
      ],
    },
  ]);

  const crossModel = convertMessages(GEMINI_MODEL, {
    messages: [
      {
        role: "assistant",
        api: GEMINI_MODEL.api,
        provider: GEMINI_MODEL.provider,
        model: "another-model",
        content: [
          {
            type: "thinking",
            thinking: "reasoning",
            thinkingSignature: "YWJjZA==",
          },
          {
            type: "toolCall",
            id: "call|with spaces",
            name: "read_file",
            arguments: {},
            thoughtSignature: "YWJjZA==",
          },
        ],
        usage: ZERO_USAGE,
        stopReason: "toolUse",
        timestamp: 0,
      },
      {
        role: "toolResult",
        toolCallId: "call|with spaces",
        toolName: "read_file",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
      },
    ],
  });
  assert.deepEqual(crossModel, [
    {
      role: "model",
      parts: [
        { text: "reasoning" },
        {
          functionCall: {
            id: "call_with_spaces",
            name: "read_file",
            args: {},
          },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call_with_spaces",
            name: "read_file",
            response: { output: "ok" },
          },
        },
      ],
    },
  ]);
});

test("local Google conversion repairs orphaned calls and routes tool images", () => {
  const orphaned = convertMessages(GEMINI_MODEL, {
    messages: [
      {
        role: "assistant",
        api: GEMINI_MODEL.api,
        provider: GEMINI_MODEL.provider,
        model: GEMINI_MODEL.id,
        content: [
          { type: "toolCall", id: "call-1", name: "capture", arguments: {} },
        ],
        usage: ZERO_USAGE,
        stopReason: "toolUse",
        timestamp: 0,
      },
      { role: "user", content: "continue", timestamp: 1 },
    ],
  });
  assert.deepEqual(orphaned[1], {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "call-1",
          name: "capture",
          response: { error: "No result provided" },
        },
      },
    ],
  });

  const imageResult = {
    role: "toolResult" as const,
    toolCallId: "call-2",
    toolName: "capture",
    content: [{ type: "image" as const, mimeType: "image/png", data: "AA==" }],
    isError: false,
    timestamp: 0,
  };
  const gemini3 = convertMessages(GEMINI_MODEL, { messages: [imageResult] });
  assert.deepEqual(gemini3[0]?.parts[0]?.functionResponse?.parts, [
    { inlineData: { mimeType: "image/png", data: "AA==" } },
  ]);

  const gemini2 = convertMessages(
    { ...GEMINI_MODEL, id: "gemini-2.5-pro" },
    { messages: [imageResult] },
  );
  assert.equal(gemini2.length, 2);
  assert.equal(gemini2[0]?.parts[0]?.functionResponse?.parts, undefined);
  assert.deepEqual(gemini2[1], {
    role: "user",
    parts: [
      { text: "Tool result image:" },
      { inlineData: { mimeType: "image/png", data: "AA==" } },
    ],
  });
});

test("local Google stream helpers preserve protocol semantics", () => {
  assert.equal(
    isThinkingPart({ thought: true, thoughtSignature: "sig" }),
    true,
  );
  assert.equal(isThinkingPart({ thoughtSignature: "sig" }), false);
  assert.equal(retainThoughtSignature("old", undefined), "old");
  assert.equal(retainThoughtSignature("old", "new"), "new");
  assert.equal(mapStopReasonString("STOP"), "stop");
  assert.equal(mapStopReasonString("MAX_TOKENS"), "length");
  assert.equal(mapStopReasonString("SAFETY"), "error");
});

test("OAuth callback ignores a wrong state without consuming the real waiter", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3_600,
      });
    }
    if (url.includes("v1internal:loadCodeAssist")) {
      return Response.json({
        currentTier: { id: "free-tier" },
        cloudaicompanionProject: "project",
      });
    }
    if (url.includes("googleapis.com/oauth2/v1/userinfo")) {
      return Response.json({ email: "user@example.test" });
    }
    throw new Error(`Unexpected OAuth fetch: ${url}`);
  }) as typeof fetch;

  const authReady = Promise.withResolvers<string>();
  const manualReady = Promise.withResolvers<AbortSignal>();
  const login = loginAntigravity({
    onAuth(info) {
      authReady.resolve(info.url);
    },
    onDeviceCode() {},
    async onPrompt() {
      return "";
    },
    async onSelect() {
      return undefined;
    },
    onManualCodeInput(signal) {
      assert.ok(signal);
      manualReady.resolve(signal);
      return new Promise<string>((_resolve, reject) => {
        const onAbort = () => reject(new Error("manual prompt cancelled"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const authUrl = new URL(await authReady.promise);
  const manualSignal = await manualReady.promise;
  const state = authUrl.searchParams.get("state");
  const redirect = authUrl.searchParams.get("redirect_uri");
  assert.ok(state && redirect);
  assert.equal(manualSignal.aborted, false);

  const wrong = new URL(redirect);
  wrong.searchParams.set("code", "wrong-code");
  wrong.searchParams.set("state", "wrong-state");
  assert.equal(await getStatus(wrong), 400);
  assert.equal(manualSignal.aborted, false);

  const valid = new URL(redirect);
  valid.searchParams.set("code", "valid-code");
  valid.searchParams.set("state", state);
  assert.equal(await getStatus(valid), 200);
  const credentials = await login;
  assert.equal(manualSignal.aborted, true);
  assert.equal(credentials.access, "access");
  assert.equal(credentials.refresh, "refresh");
  assert.equal(credentials.projectId, "project");
});

test("OAuth refresh preserves provider metadata and the old refresh token", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input, init) => {
      assert.equal(init?.method, "POST");
      const body = init?.body;
      assert.ok(body instanceof URLSearchParams);
      assert.equal(body.get("refresh_token"), "old-refresh");
      return new Response(
        JSON.stringify({ access_token: "new-access", expires_in: 3_600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const refreshed = await refreshAntigravityToken(
      {
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        projectId: "project-1",
        email: "user@example.com",
      } satisfies AntigravityCredentials,
      new AbortController().signal,
    );
    assert.equal(refreshed.access, "new-access");
    assert.equal(refreshed.refresh, "old-refresh");
    assert.equal((refreshed as { projectId?: string }).projectId, "project-1");
    assert.equal((refreshed as { email?: string }).email, "user@example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- schema sanitization ---------------------------------------------------

test("sanitizeSchemaForCca strips CCA-rejected keywords recursively", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, pattern: "^/" },
      lines: { type: "array", items: { type: "string", format: "uri" } },
    },
    $schema: "http://json-schema.org/draft-07/schema#",
    additionalProperties: false,
  };
  assert.deepEqual(sanitizeSchemaForCca(schema), {
    type: "object",
    properties: {
      path: { type: "string", description: '{minLength: 1, pattern: "^/"}' },
      lines: {
        type: "array",
        items: { type: "string", description: '{format: "uri"}' },
      },
    },
  });
});

test("sanitizeSchemaForCca preserves property names that match schema keywords", () => {
  assert.deepEqual(
    sanitizeSchemaForCca({
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern",
          pattern: "^[a-z]+$",
        },
        format: { type: "string" },
      },
      required: ["pattern"],
    }),
    {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: 'Search pattern\n\n{pattern: "^[a-z]+$"}',
        },
        format: { type: "string" },
      },
      required: ["pattern"],
    },
  );
});

test("buildRequestBody strips CCA-rejected keywords and spills constraints into description", () => {
  const contextWithTools = {
    ...SIMPLE_CONTEXT,
    tools: [
      {
        name: "write_files",
        description: "d",
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "paths",
              items: { type: "string", deprecated: true },
              uniqueItems: true,
            },
            mode: { type: "string", readOnly: false },
            pattern: { type: "string", description: "Search pattern" },
            $id: { type: "string", description: "User-defined property" },
          },
        },
      },
    ],
  };
  const body = buildRequestBody(
    CLAUDE_MODEL,
    contextWithTools as never,
    undefined,
    "p",
  ) as {
    request: {
      tools: {
        functionDeclarations: { parameters: Record<string, unknown> }[];
      }[];
    };
  };
  const parameters = body.request.tools[0]!.functionDeclarations[0]!
    .parameters as {
    properties: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(parameters.properties.files, {
    type: "array",
    description: "paths\n\n{uniqueItems: true}",
    items: { type: "string" },
  });
  assert.deepEqual(parameters.properties.mode, { type: "string" });
  assert.deepEqual(parameters.properties.pattern, {
    type: "string",
    description: "Search pattern",
  });
  assert.deepEqual(parameters.properties.$id, {
    type: "string",
    description: "User-defined property",
  });
});

// --- request envelope ------------------------------------------------------

test("buildRequestBody produces the Antigravity envelope", () => {
  const body = buildRequestBody(
    CLAUDE_MODEL,
    SIMPLE_CONTEXT,
    { reasoning: "medium" },
    "proj-1",
  ) as {
    project: string;
    model: string;
    userAgent: string;
    requestType: string;
    request: {
      contents: unknown[];
      systemInstruction: { role: string; parts: { text: string }[] };
      toolConfig: { functionCallingConfig: { mode: string } };
      generationConfig: {
        maxOutputTokens: number;
        thinkingConfig: Record<string, unknown>;
      };
      labels: Record<string, string>;
      sessionId: string;
    };
  };
  assert.equal(body.project, "proj-1");
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.userAgent, "antigravity");
  assert.equal(body.requestType, "agent");
  assert.equal(body.request.systemInstruction.role, "user");
  assert.equal(
    body.request.systemInstruction.parts[0].text,
    "You are helpful.",
  );
  assert.ok(Array.isArray(body.request.contents));
  assert.ok(body.request.contents.length > 0);
  // Claude routes force VALIDATED even with no tools.
  assert.equal(body.request.toolConfig.functionCallingConfig.mode, "VALIDATED");
  // Claude reasoning models take a token budget, not a thinking level.
  assert.equal(
    body.request.generationConfig.thinkingConfig.includeThoughts,
    true,
  );
  assert.equal(
    typeof body.request.generationConfig.thinkingConfig.thinkingBudget,
    "number",
  );
  assert.equal(body.request.labels.used_claude, "true");
  assert.ok(body.request.sessionId.length > 0);
});

test("buildRequestBody routes Gemini 3.1 high away from the broken deployment", () => {
  const body = buildRequestBody(
    GEMINI_MODEL,
    SIMPLE_CONTEXT,
    { reasoning: "high" },
    "p",
  ) as {
    model: string;
    request: { generationConfig: { thinkingConfig: Record<string, unknown> } };
  };
  assert.equal(body.model, "gemini-pro-agent");
  assert.equal(
    body.request.generationConfig.thinkingConfig.thinkingBudget,
    10_001,
  );
});

test("buildRequestBody keeps mandatory Gemini 3.7 thinking enabled", () => {
  const body = buildRequestBody(
    { ...GEMINI_MODEL, id: "gemini-3.7-flash" },
    SIMPLE_CONTEXT,
    undefined,
    "p",
  ) as {
    model: string;
    request: { generationConfig: { thinkingConfig: Record<string, unknown> } };
  };
  assert.equal(body.model, "gemini-3.7-flash-low");
  assert.equal(
    body.request.generationConfig.thinkingConfig.thinkingLevel,
    "LOW",
  );
});

test("buildRequestBody explicitly suppresses optional Claude thinking when off", () => {
  const body = buildRequestBody(
    CLAUDE_MODEL,
    SIMPLE_CONTEXT,
    undefined,
    "p",
  ) as {
    request: { generationConfig: { thinkingConfig: Record<string, unknown> } };
  };
  assert.deepEqual(body.request.generationConfig.thinkingConfig, {
    includeThoughts: false,
    thinkingBudget: 0,
  });
});

test("buildRequestBody honors disabled and forced tool choices", () => {
  const contextWithTools = {
    ...SIMPLE_CONTEXT,
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ],
  } as Context;
  const disabled = buildRequestBody(
    GEMINI_MODEL,
    contextWithTools,
    { toolChoice: "none" } as never,
    "p",
  ) as { request: Record<string, unknown> };
  assert.equal(disabled.request.tools, undefined);
  assert.equal(disabled.request.toolConfig, undefined);

  const forced = buildRequestBody(
    GEMINI_MODEL,
    contextWithTools,
    {
      toolChoice: { mode: "ANY", allowedFunctionNames: ["read_file"] },
    } as never,
    "p",
  ) as {
    request: {
      contents: { parts?: { text?: string }[] }[];
      toolConfig: {
        functionCallingConfig: {
          mode: string;
          allowedFunctionNames: string[];
        };
      };
    };
  };
  assert.deepEqual(forced.request.toolConfig.functionCallingConfig, {
    mode: "ANY",
    allowedFunctionNames: ["read_file"],
  });
  assert.match(
    forced.request.contents.at(-1)?.parts?.[0]?.text ?? "",
    /TOOL-ONLY TURN/,
  );
});

test("discovery collapses wire variants and validates advertised capabilities", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        models: {
          "gemini-3.1-pro-low": {
            displayName: "Gemini 3.1 Pro Low",
            supportsThinking: true,
            supportsImages: true,
            maxTokens: -1,
            maxOutputTokens: 0,
          },
          "gemini-3.1-pro-high": {
            displayName: "Broken high deployment",
            supportsThinking: true,
          },
          "text-only": { supportsImages: false },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const models = await fetchAntigravityModels({
    allowNetwork: true,
    credential: {
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    },
    publish: async () => true,
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["gemini-3.1-pro", "text-only"],
  );
  assert.deepEqual(models[0]?.input, ["text", "image"]);
  assert.equal(models[0]?.contextWindow, 200_000);
  assert.equal(models[0]?.maxTokens, 64_000);
  assert.deepEqual(models[1]?.input, ["text"]);
});

test("discovery routes through the only live family member", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        models: {
          "gemini-3.7-flash-high": {
            supportsThinking: true,
            supportsImages: true,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  const [discovered] = await fetchAntigravityModels({
    allowNetwork: true,
    credential: {
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    },
    publish: async () => true,
    signal: new AbortController().signal,
  });
  assert.ok(discovered);
  const body = buildRequestBody(
    { ...GEMINI_MODEL, ...discovered },
    SIMPLE_CONTEXT,
    { reasoning: "low" },
    "p",
  );
  assert.equal(body.model, "gemini-3.7-flash-high");
});

test("variant collapse drops a family when discovery only exposes a retired member", () => {
  const collapsed = collapseAntigravityModels([
    {
      id: "gemini-3.1-pro-high",
      name: "retired",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ]);
  assert.deepEqual(collapsed, []);
});

test("Claude discovery and request output tokens are capped at 64000", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        models: {
          "claude-sonnet-4-6": {
            supportsThinking: true,
            maxOutputTokens: 65_536,
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const [discovered] = await fetchAntigravityModels({
    allowNetwork: true,
    credential: {
      type: "oauth",
      refresh: "refresh",
      access: "access",
      expires: Date.now() + 60_000,
    },
    publish: async () => true,
    signal: new AbortController().signal,
  });
  assert.ok(discovered);
  assert.equal(discovered.maxTokens, 64_000);

  const body = buildRequestBody(
    { ...CLAUDE_MODEL, ...discovered, maxTokens: 65_536 },
    SIMPLE_CONTEXT,
    { maxTokens: 65_536, reasoning: "medium" },
    "p",
  );
  assert.equal(
    (body.request as { generationConfig: { maxOutputTokens: number } })
      .generationConfig.maxOutputTokens,
    64_000,
  );
});

test("Antigravity discovery failure throws instead of replacing cached models", async () => {
  globalThis.fetch = (async () =>
    new Response("unavailable", { status: 503 })) as typeof fetch;

  await assert.rejects(
    fetchAntigravityModels({
      allowNetwork: true,
      credential: {
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      },
      publish: async () => true,
      signal: new AbortController().signal,
    }),
    /failed on all endpoints/,
  );
});

test("static GPT-OSS uses its medium wire deployment", () => {
  const model = ANTIGRAVITY_MODELS.find((entry) => entry.id === "gpt-oss-120b");
  assert.ok(model);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.contextWindow, 131_072);
  assert.equal(model.maxTokens, 32_768);
  const body = buildRequestBody(
    { ...GEMINI_MODEL, ...model },
    SIMPLE_CONTEXT,
    undefined,
    "p",
  );
  assert.equal(body.model, "gpt-oss-120b-medium");
  assert.equal(
    (body.request as { generationConfig: { maxOutputTokens: number } })
      .generationConfig.maxOutputTokens,
    32_768,
  );
});

// --- streaming -------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;
let originalVersion: string | undefined;

before(() => {
  originalFetch = globalThis.fetch;
  originalVersion = process.env.OPENPI_ANTIGRAVITY_VERSION;
  process.env.OPENPI_ANTIGRAVITY_VERSION = "2.8.0";
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalVersion === undefined) {
    delete process.env.OPENPI_ANTIGRAVITY_VERSION;
  } else {
    process.env.OPENPI_ANTIGRAVITY_VERSION = originalVersion;
  }
});

test("streamAntigravity maps SSE parts to pi events", async () => {
  const requests: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    requests.push({ url: String(input), body: String(init?.body) });
    return sseResponse([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Thinking", thought: true, thoughtSignature: "c2ln" },
                  { text: "Hi there" },
                  {
                    functionCall: { name: "bash", args: { command: "ls" } },
                    thoughtSignature: "c2ln",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            cachedContentTokenCount: 20,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 10,
            totalTokenCount: 135,
          },
        },
      },
    ]);
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(CLAUDE_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );

  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ]);

  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.reason, "toolUse");
  const message = done.message;
  assert.equal(message.provider, "google-antigravity");
  assert.equal(message.stopReason, "toolUse");
  const toolCall = message.content.find((b) => b.type === "toolCall");
  assert.ok(toolCall && toolCall.type === "toolCall");
  assert.equal(toolCall.name, "bash");
  assert.deepEqual(toolCall.arguments, { command: "ls" });
  assert.equal(message.usage.input, 100);
  assert.equal(message.usage.cacheRead, 20);
  assert.equal(message.usage.output, 15);

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /daily-cloudcode-pa\.googleapis\.com/);
  const sent = JSON.parse(requests[0].body);
  assert.equal(sent.project, "proj-1");
});

test("streamAntigravity fails over to the sandbox endpoint on 5xx", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return new Response("boom", { status: 500 });
    }
    return sseResponse([
      {
        response: {
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      },
    ]);
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(urls.length, 2);
  assert.match(urls[1], /sandbox/);
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done" && done.reason === "stop");
});

test("streamAntigravity bounds a stalled non-2xx body and fails over", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    if (requests === 1) {
      response.writeHead(503, { "Content-Type": "text/plain" });
      response.write("partial error");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"fallback"}]},"finishReason":"STOP"}]}}\n\n',
    );
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localUrl = `http://127.0.0.1:${address.port}/stream`;
  const startedAt = Date.now();
  let events;
  try {
    events = await collectEvents(
      streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
        apiKey: API_KEY,
        timeoutMs: 50,
        fetch: (_input, init) => originalFetch(localUrl, init),
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(requests, 2);
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done" && done.reason === "stop");
});

test("streamAntigravity truncates and cancels an oversized error body", async () => {
  let cancellations = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(128 * 1024)));
        },
        cancel() {
          cancellations++;
        },
      }),
      { status: 400 },
    )) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(cancellations, 1);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /\[truncated\]$/);
  assert.ok((error.error.errorMessage?.length ?? 0) < 70 * 1024);
});

test("streamAntigravity fails over after a transient error in a 200 stream", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return sseResponse([
        { response: { usageMetadata: { promptTokenCount: 2 } } },
        { error: { code: 408, message: "upstream timeout" } },
      ]);
    }
    return sseResponse([
      {
        response: {
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      },
    ]);
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(urls.length, 2);
  assert.match(urls[1], /sandbox/);
  assert.equal(events.filter((event) => event.type === "start").length, 1);
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done" && done.reason === "stop");
});

test("streamAntigravity fails over after an empty completed stream", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return sseResponse([
        { response: { candidates: [{ finishReason: "STOP" }] } },
      ]);
    }
    return sseResponse([
      {
        response: {
          candidates: [
            {
              content: { parts: [{ text: "fallback" }] },
              finishReason: "STOP",
            },
          ],
        },
      },
    ]);
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(urls.length, 2);
  assert.match(urls[1], /sandbox/);
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done" && done.reason === "stop");
});

test("streamAntigravity treats thought-only completion as empty and retries", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    if (urls.length === 1) {
      return sseResponse([
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ text: "internal only", thought: true }],
                },
                finishReason: "STOP",
              },
            ],
          },
        },
      ]);
    }
    return sseResponse([
      {
        response: {
          candidates: [
            {
              content: { parts: [{ text: "final answer" }] },
              finishReason: "STOP",
            },
          ],
        },
      },
    ]);
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(urls.length, 2);
  assert.match(urls[1], /sandbox/);
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.content.length, 1);
  assert.equal(done.message.content[0]?.type, "text");
  assert.equal(
    done.message.content[0]?.type === "text"
      ? done.message.content[0].text
      : undefined,
    "final answer",
  );
});

test("streamAntigravity treats whitespace-only completion as empty and retries", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return sseResponse([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: calls === 1 ? "   " : "answer" }],
              },
              finishReason: "STOP",
            },
          ],
        },
      },
    ]);
  }) as typeof fetch;
  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(calls, 2);
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.message.content[0]?.type, "text");
});

test("streamAntigravity bounds the first event wait and releases both bodies", async () => {
  const urls: string[] = [];
  let cancellations = 0;
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        },
        cancel() {
          cancellations++;
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
      apiKey: API_KEY,
      timeoutMs: 5,
    }),
  );
  assert.equal(urls.length, 2);
  assert.equal(cancellations, 2);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /first SSE event/);
});

test("streamAntigravity bounds the full SSE lifetime after the first event", async () => {
  const urls: string[] = [];
  let cancellations = 0;
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"response":{"usageMetadata":{"promptTokenCount":1}}}\n\n',
            ),
          );
        },
        cancel() {
          cancellations++;
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
      apiKey: API_KEY,
      timeoutMs: 5,
    }),
  );
  assert.equal(urls.length, 2);
  assert.equal(cancellations, 2);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /next SSE event/);
});

test("streamAntigravity bounds the response-header wait and fails over", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
      apiKey: API_KEY,
      timeoutMs: 5,
    }),
  );
  assert.equal(calls, 2);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /response headers/);
});

test("streamAntigravity carries session execution state across turns", async () => {
  const bodies: Record<string, unknown>[] = [];
  let responseIndex = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    responseIndex++;
    return sseResponse([
      {
        response: {
          ...(responseIndex === 1 ? { responseId: "execution-1" } : {}),
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      },
    ]);
  }) as typeof fetch;

  const options = { apiKey: API_KEY, sessionId: "session-state-test" };
  await collectEvents(streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, options));
  await collectEvents(streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, options));
  await collectEvents(streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, options));
  assert.equal(bodies.length, 3);
  const first = bodies[0] as {
    requestId: string;
    request: { labels: Record<string, string> };
  };
  const second = bodies[1] as {
    requestId: string;
    request: { labels: Record<string, string> };
  };
  const third = bodies[2] as {
    requestId: string;
    request: { labels: Record<string, string> };
  };
  assert.equal(first.request.labels.last_step_index, "1");
  assert.equal(second.request.labels.last_step_index, "2");
  assert.equal(second.request.labels.last_execution_id, "execution-1");
  assert.equal(third.request.labels.last_execution_id, undefined);
  assert.equal(first.requestId.split("/")[1], second.requestId.split("/")[1]);
  assert.equal(first.requestId.split("/")[3], second.requestId.split("/")[3]);
});

test("streamAntigravity aborts and cancels after a metadata-only event", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            new TextEncoder().encode(
              'data: {"response":{"usageMetadata":{"promptTokenCount":1}}}\n\n',
            ),
          );
        },
        cancel() {
          cancellations++;
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  setTimeout(() => controller.abort("test cancellation"), 5);
  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
      apiKey: API_KEY,
      signal: controller.signal,
    }),
  );
  assert.equal(cancellations, 1);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.reason, "aborted");
});

test("streamAntigravity honors provider request lifecycle options", async () => {
  let payloadCalls = 0;
  let responseCalls = 0;
  let sentBody: Record<string, unknown> | undefined;
  let sentHeaders: Headers | undefined;
  let manifestCalls = 0;
  const customFetch: typeof fetch = async (input, init) => {
    if (String(input).includes("manifest/latest-arm64-mac.yml")) {
      manifestCalls++;
      return new Response("version: 2.8.1\n", { status: 200 });
    }
    sentBody = JSON.parse(String(init?.body));
    sentHeaders = new Headers(init?.headers);
    return sseResponse([
      {
        response: {
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
        },
      },
    ]);
  };
  globalThis.fetch = (async () => {
    throw new Error("global fetch should not be used");
  }) as typeof fetch;

  const pinnedVersion = process.env.OPENPI_ANTIGRAVITY_VERSION;
  delete process.env.OPENPI_ANTIGRAVITY_VERSION;
  let events;
  try {
    events = await collectEvents(
      streamAntigravity(CLAUDE_MODEL, SIMPLE_CONTEXT, {
        apiKey: API_KEY,
        fetch: customFetch,
        headers: { "X-Probe": "present", "anthropic-beta": null },
        onPayload(payload) {
          payloadCalls++;
          return {
            ...(payload as Record<string, unknown>),
            project: "override",
          };
        },
        onResponse(response) {
          responseCalls++;
          assert.equal(response.status, 200);
        },
      }),
    );
  } finally {
    if (pinnedVersion === undefined) {
      delete process.env.OPENPI_ANTIGRAVITY_VERSION;
    } else {
      process.env.OPENPI_ANTIGRAVITY_VERSION = pinnedVersion;
    }
  }
  assert.ok(events.some((event) => event.type === "done"));
  assert.equal(manifestCalls, 1);
  assert.equal(payloadCalls, 1);
  assert.equal(responseCalls, 1);
  assert.equal(sentBody?.project, "override");
  assert.equal(sentHeaders?.get("x-probe"), "present");
  assert.equal(sentHeaders?.get("authorization"), "Bearer tok");
  assert.equal(sentHeaders?.has("anthropic-beta"), false);
});

test("streamAntigravity surfaces 4xx as an error event without failover", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;

  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, { apiKey: API_KEY }),
  );
  assert.equal(urls.length, 1);
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /400/);
});

test("streamAntigravity requires a project id", async () => {
  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
      apiKey: encodeApiKey({ refresh: "r", access: "tok", expires: 0 }),
    }),
  );
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.match(error.error.errorMessage ?? "", /project id/);
});

test("streamAntigravity reports an already-aborted request as aborted", async () => {
  const controller = new AbortController();
  controller.abort("test cancellation");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    assert.equal(init?.signal?.aborted, true);
    throw new Error("request aborted");
  }) as typeof fetch;
  const events = await collectEvents(
    streamAntigravity(GEMINI_MODEL, SIMPLE_CONTEXT, {
      apiKey: API_KEY,
      signal: controller.signal,
    }),
  );
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.reason, "aborted");
});
