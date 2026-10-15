import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  type FakeProvider,
  PROVIDER_PORT,
  startFakeProvider,
} from "./provider-e2e-support.ts";

test("dynamic fake providers keep independent endpoints and cleanup with the legacy port occupied", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" ? resolve() : reject(error),
    );
    blocker.listen(PROVIDER_PORT, "127.0.0.1", resolve);
  });
  let first: FakeProvider | undefined;
  let second: FakeProvider | undefined;
  const send = (provider: FakeProvider, model: string) =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model }),
    }).then((response) => response.text());
  try {
    first = await startFakeProvider(undefined, { port: 0 });
    second = await startFakeProvider(undefined, { port: 0 });
    assert.notEqual(first.baseUrl, second.baseUrl);
    for (const provider of [first, second])
      assert.notEqual(new URL(provider.baseUrl).port, String(PROVIDER_PORT));
    assert.match(await send(first, "first-model"), /first-model/u);
    assert.match(await send(second, "second-model"), /second-model/u);
    assert.deepEqual(
      first.requests.map((request) => request.body),
      [{ model: "first-model" }],
    );
    assert.deepEqual(
      second.requests.map((request) => request.body),
      [{ model: "second-model" }],
    );
    const closed = first;
    await closed.close();
    first = undefined;
    await assert.rejects(send(closed, "closed-model"));
    assert.match(await send(second, "still-live"), /still-live/u);
    assert.equal(second.requests.length, 2);
  } finally {
    await first?.close();
    await second?.close();
    if (blocker.listening)
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
