import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import {
  discoverProviderModels,
  validProviderDiscovery,
} from "../../web/runtime/provider-model-discovery.ts";

test("built-in model discovery reuses native credentials only for the registered connection", async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fixture" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let authBaseUrl = baseUrl;
    const runtime = Object.assign(
      Object.create(PiWebRuntime.prototype) as object,
      {
        runtime: {
          session: { sessionManager: { getSessionId: () => "s" } },
          services: {
            modelRuntime: {
              getModels: () => [
                {
                  provider: "builtin-fixture",
                  id: "fixture",
                  api: "openai-responses",
                  baseUrl,
                },
              ],
              getAuth: async () => ({
                auth: { apiKey: "native-fixture", baseUrl: authBaseUrl },
              }),
            },
          },
        },
      },
    ) as unknown as PiWebRuntime;
    const connection = {
      provider: "builtin-fixture",
      baseUrl,
      api: "openai-responses" as const,
    };
    await runtime.discoverProviderModels(
      "s",
      connection,
      AbortSignal.timeout(2000),
    );
    await runtime.discoverProviderModels(
      "s",
      { ...connection, baseUrl: `${baseUrl}/other` },
      AbortSignal.timeout(2000),
    );
    await runtime.discoverProviderModels(
      "s",
      {
        ...connection,
        baseUrl: `${baseUrl}/other`,
        apiKey: "explicit-fixture",
      },
      AbortSignal.timeout(2000),
    );
    assert.deepEqual(seen, [
      "Bearer native-fixture",
      undefined,
      "Bearer explicit-fixture",
    ]);
    authBaseUrl = `${baseUrl}/changed`;
    await assert.rejects(
      runtime.discoverProviderModels(
        "s",
        connection,
        AbortSignal.timeout(2000),
      ),
      /endpoint changed/,
    );
    await assert.rejects(
      runtime.discoverProviderModels(
        "another-session",
        connection,
        AbortSignal.timeout(2000),
      ),
      /Session changed/,
    );
    assert.equal(seen.length, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("discovery preserves explicit capabilities and leaves missing metadata unknown", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          { id: "bare" },
          {
            id: "rich",
            context_length: 1000000,
            top_provider: {
              context_length: 256000,
              max_completion_tokens: 32000,
            },
            architecture: { input_modalities: ["text", "image", "audio"] },
            supported_parameters: ["reasoning"],
          },
          {
            id: "explicit",
            contextWindow: 128000,
            maxTokens: 16384,
            input: ["text"],
            reasoning: false,
            supported_parameters: ["reasoning_effort"],
          },
          {
            id: "invalid",
            context_length: -1,
            max_output_tokens: 100000001,
            input: [false],
            reasoning: "true",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await discoverProviderModels(
      {
        provider: "fixture",
        baseUrl: `http://127.0.0.1:${address.port}`,
        api: "openai-completions",
      },
      {},
      AbortSignal.timeout(2000),
    );
    assert.deepEqual(result.models, [
      { id: "bare", name: "bare" },
      {
        id: "explicit",
        name: "explicit",
        contextWindow: 128000,
        maxTokens: 16384,
        input: ["text"],
        reasoning: false,
      },
      { id: "invalid", name: "invalid" },
      {
        id: "rich",
        name: "rich",
        contextWindow: 256000,
        maxTokens: 32000,
        input: ["text", "image"],
        reasoning: true,
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("catalog discovery is bounded, filters unsupported records, and never follows authenticated redirects", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url!);
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    if (request.url === "/redirect/models") {
      response.writeHead(302, { Location: "/stolen" });
      response.end();
      return;
    }
    if (request.url === "/large/models") {
      response.end("x".repeat(1024 * 1024 + 1));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        data: [
          { id: "second", display_name: "Second" },
          { id: "first" },
          { id: "second", name: "Updated" },
          { id: "bad\n" },
          { name: "missing-id" },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const connection = {
      provider: "fixture",
      baseUrl,
      api: "openai-completions" as const,
    };
    const headers = { Authorization: "Bearer fixture-key" };
    const result = await discoverProviderModels(
      connection,
      headers,
      AbortSignal.timeout(2000),
    );
    assert.deepEqual(result.models, [
      { id: "first", name: "first" },
      { id: "second", name: "Updated" },
    ]);
    assert.equal(result.truncated, false);
    await discoverProviderModels(
      { ...connection, api: "anthropic-messages" },
      headers,
      AbortSignal.timeout(2000),
    );
    await discoverProviderModels(
      { ...connection, baseUrl: `${baseUrl}/v1`, api: "anthropic-messages" },
      headers,
      AbortSignal.timeout(2000),
    );
    assert.deepEqual(seen.slice(-2), ["/v1/models", "/v1/models"]);
    await assert.rejects(
      discoverProviderModels(
        { ...connection, baseUrl: `${baseUrl}/redirect` },
        headers,
        AbortSignal.timeout(2000),
      ),
    );
    assert.ok(!seen.includes("/stolen"));
    await assert.rejects(
      discoverProviderModels(
        { ...connection, baseUrl: `${baseUrl}/large` },
        headers,
        AbortSignal.timeout(2000),
      ),
      /too large/,
    );
    for (const patch of [
      { baseUrl: "https://user:password@example.com" },
      { baseUrl: "file:///tmp/models" },
      { apiKey: "bad\r\nheader" },
      { extra: true },
    ])
      assert.equal(validProviderDiscovery({ ...connection, ...patch }), false);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      discoverProviderModels(connection, headers, controller.signal),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
