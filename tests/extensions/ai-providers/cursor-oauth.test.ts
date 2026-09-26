import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { getGlobalDispatcher, Pool, setGlobalDispatcher } from "undici";
import { pollCursorAuth } from "../../../extensions/ai-providers/cursor/oauth.ts";

test("Cursor auth polling releases pending responses before the next request", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (requests === 1) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("pending".repeat(65_536));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ accessToken: "access", refreshToken: "refresh" }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const pool = new Pool(origin, { connections: 1 });
  const originalDispatcher = getGlobalDispatcher();
  try {
    setGlobalDispatcher(pool);
    const tokens = await pollCursorAuth(
      "test-id",
      "test-verifier",
      AbortSignal.timeout(2_000),
      { pollUrl: `${origin}/poll`, maxAttempts: 2, baseDelayMs: 50 },
    );
    assert.deepEqual(tokens, {
      accessToken: "access",
      refreshToken: "refresh",
    });
    assert.equal(requests, 2);
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await pool.destroy();
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("Cursor auth polling releases failed responses without changing its retry limit", async () => {
  let requests = 0;
  let cancellations = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      requests++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
          },
        }),
        { status: 503 },
      );
    }) as typeof fetch;
    await assert.rejects(
      pollCursorAuth("test-id", "test-verifier", undefined, {
        baseDelayMs: 0,
      }),
      /Too many consecutive errors during Cursor authentication polling/,
    );
    assert.equal(requests, 3);
    assert.equal(cancellations, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cursor auth polling preserves pending status when body cleanup fails", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      requests++;
      if (requests <= 3) {
        return new Response(
          new ReadableStream({
            cancel() {
              throw new Error("body already failed");
            },
          }),
          { status: 404 },
        );
      }
      return Response.json({ accessToken: "access", refreshToken: "refresh" });
    }) as typeof fetch;
    assert.deepEqual(
      await pollCursorAuth("test-id", "test-verifier", undefined, {
        maxAttempts: 4,
        baseDelayMs: 0,
      }),
      { accessToken: "access", refreshToken: "refresh" },
    );
    assert.equal(requests, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
