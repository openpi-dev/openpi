import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
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

async function withAnthropicCatalog(
  handler: RequestListener,
  run: (
    discover: (
      signal?: AbortSignal,
    ) => ReturnType<typeof discoverProviderModels>,
  ) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const runtime = Object.assign(
      Object.create(PiWebRuntime.prototype) as object,
      {
        runtime: {
          session: { sessionManager: { getSessionId: () => "fixture" } },
        },
      },
    ) as unknown as PiWebRuntime;
    await run((signal = AbortSignal.timeout(2000)) =>
      runtime.discoverProviderModels(
        "fixture",
        {
          provider: "fixture",
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          apiKey: "dummy-fixture-key",
        },
        signal,
      ),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("Anthropic discovery follows the cursor through the production caller", async () => {
  const seen: string[] = [];
  await withAnthropicCatalog(
    (request, response) => {
      seen.push(request.url!);
      assert.equal(request.headers["x-api-key"], "dummy-fixture-key");
      assert.equal(request.headers["anthropic-version"], "2023-06-01");
      assert.equal(request.headers.authorization, undefined);
      response.end(
        JSON.stringify(
          seen.length === 1
            ? {
                data: Array.from({ length: 20 }, (_, i) => ({
                  id: `first-${i}`,
                })),
                has_more: true,
                last_id: "first-19",
              }
            : {
                data: [
                  {
                    id: "later-model",
                    display_name: "Later model",
                    reasoning: true,
                  },
                ],
                has_more: false,
                last_id: "later-model",
              },
        ),
      );
    },
    async (discover) => {
      const result = await discover();
      assert.equal(result.models.length, 21);
      assert.deepEqual(
        result.models.find((m) => m.id === "later-model"),
        { id: "later-model", name: "Later model", reasoning: true },
      );
      assert.equal(result.truncated, false);
      assert.deepEqual(seen, ["/v1/models", "/v1/models?after_id=first-19"]);
    },
  );
});

for (const [secondCount, hasMore, truncated] of [
  [250, false, false],
  [251, false, true],
  [250, true, true],
] as const) {
  test(`Anthropic shares the 500-model cap across pages: ${secondCount}/${hasMore}`, async () => {
    let requests = 0;
    await withAnthropicCatalog(
      (_request, response) => {
        const first = ++requests === 1;
        response.end(
          JSON.stringify({
            data: Array.from({ length: first ? 250 : secondCount }, (_, i) => ({
              id: `model-${(first ? i : i + 250).toString().padStart(3, "0")}`,
            })),
            has_more: first || hasMore,
            last_id: first ? "model-249" : "model-499",
          }),
        );
      },
      async (discover) => {
        const result = await discover();
        assert.equal(requests, 2);
        assert.equal(result.models.length, 500);
        assert.equal(result.models.at(-1)?.id, "model-499");
        assert.equal(result.truncated, truncated);
      },
    );
  });
}

for (const cursor of [undefined, "", "repeat", "bad\n", "x".repeat(257)]) {
  test(`Anthropic rejects a missing, invalid or repeated cursor: ${JSON.stringify(cursor?.slice(0, 10))}`, async () => {
    let requests = 0;
    await withAnthropicCatalog(
      (_request, response) => {
        requests++;
        response.end(
          JSON.stringify({
            data: [{ id: "repeat" }],
            has_more: true,
            last_id: cursor,
          }),
        );
      },
      async (discover) => {
        await assert.rejects(discover(), /pagination/i);
        assert.equal(requests, cursor === "repeat" ? 2 : 1);
      },
    );
  });
}

test("Anthropic discovery shares the byte budget across pages", async () => {
  let requests = 0;
  await withAnthropicCatalog(
    (_request, response) => {
      requests++;
      response.end(
        JSON.stringify({
          data: [{ id: `model-${requests}` }],
          padding: "x".repeat(600_000),
          has_more: requests === 1,
          last_id: "model-1",
        }),
      );
    },
    async (discover) => {
      await assert.rejects(discover(), /too large/);
      assert.equal(requests, 2);
    },
  );
});

for (const status of [503, 302]) {
  test(`Anthropic rejects later-page HTTP ${status} without returning partial success`, async () => {
    const seen: string[] = [];
    await withAnthropicCatalog(
      (request, response) => {
        seen.push(request.url!);
        if (seen.length === 1)
          response.end(
            JSON.stringify({
              data: [{ id: "first" }],
              has_more: true,
              last_id: "first",
            }),
          );
        else {
          response.writeHead(status, { Location: "/not-followed" });
          response.end("private fixture detail");
        }
      },
      async (discover) => {
        await assert.rejects(
          discover(),
          status === 503 ? /HTTP 503/ : /fetch failed/,
        );
        assert.deepEqual(seen, ["/v1/models", "/v1/models?after_id=first"]);
      },
    );
  });
}

test("Anthropic retains the caller's cancellation through a later response body", async () => {
  const controller = new AbortController();
  let requests = 0;
  await withAnthropicCatalog(
    (_request, response) => {
      if (++requests === 1)
        response.end(
          JSON.stringify({
            data: [{ id: "first" }],
            has_more: true,
            last_id: "first",
          }),
        );
      else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"data":[');
        controller.abort();
      }
    },
    async (discover) => {
      await assert.rejects(
        discover(
          AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
        ),
        { name: "AbortError" },
      );
      assert.equal(requests, 2);
    },
  );
});

test("Anthropic encodes opaque cursors and deduplicates validated models across pages", async () => {
  const seen: string[] = [];
  const cursor = "next/&?x=1";
  await withAnthropicCatalog(
    (request, response) => {
      seen.push(request.url!);
      response.end(
        JSON.stringify(
          seen.length === 1
            ? {
                data: [{ id: "first" }, { id: "bad\n" }],
                has_more: true,
                last_id: cursor,
              }
            : {
                data: [
                  { id: "first", display_name: "Updated" },
                  { id: "second" },
                  { name: "missing id" },
                ],
                has_more: false,
              },
        ),
      );
    },
    async (discover) => {
      const result = await discover();
      assert.deepEqual(result, {
        models: [
          { id: "first", name: "Updated" },
          { id: "second", name: "second" },
        ],
        truncated: false,
      });
      assert.equal(seen.length, 2);
      const next = new URL(seen[1]!, "http://127.0.0.1");
      assert.equal(next.pathname, "/v1/models");
      assert.deepEqual([...next.searchParams], [["after_id", cursor]]);
    },
  );
});

test("Anthropic rejects an empty continuation page", async () => {
  let requests = 0;
  await withAnthropicCatalog(
    (_request, response) => {
      requests++;
      response.end(
        JSON.stringify({ data: [], has_more: true, last_id: "empty" }),
      );
    },
    async (discover) => {
      await assert.rejects(discover(), /pagination/);
      assert.equal(requests, 1);
    },
  );
});

test("Anthropic keeps the original deadline while waiting for the next page", async () => {
  let requests = 0;
  await withAnthropicCatalog(
    (_request, response) => {
      if (++requests === 1)
        response.end(
          JSON.stringify({
            data: [{ id: "first" }],
            has_more: true,
            last_id: "first",
          }),
        );
      // Leave the next response pending until the caller's one deadline expires.
    },
    async (discover) => {
      await assert.rejects(discover(AbortSignal.timeout(1000)), {
        name: "TimeoutError",
      });
      assert.equal(requests, 2);
    },
  );
});
