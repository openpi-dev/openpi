import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  discoverProviderModels,
  validProviderDiscovery,
} from "../../web/runtime/provider-model-discovery.ts";

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
