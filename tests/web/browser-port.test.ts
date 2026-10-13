import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { listenBrowserPort } from "../../web/host/browser-port.ts";

test("explicit browser-blocked ports fail without opening a listener", async () => {
  for (const port of [6000, 6667, 10080]) {
    const server = createServer();
    await assert.rejects(
      listenBrowserPort(server, port, "127.0.0.1"),
      /blocked by browsers/u,
    );
    assert.equal(server.listening, false);
    assert.equal(server.listenerCount("error"), 0);
  }
});

test("synchronous listen failures release the temporary error listener", async () => {
  const server = createServer();
  await assert.rejects(listenBrowserPort(server, -1, "127.0.0.1"), {
    code: "ERR_SOCKET_BAD_PORT",
  });
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount("error"), 0);
});

test("automatic allocation releases a blocked port and retains the usable retry", async (t) => {
  const server = createServer((_request, response) => response.end("ready"));
  const address = server.address.bind(server);
  let samples = 0;
  t.mock.method(server, "address", () => {
    const current = address();
    assert.ok(current && typeof current !== "string");
    return ++samples === 1 ? { ...current, port: 6000 } : current;
  });
  try {
    const port = await listenBrowserPort(server, 0, "127.0.0.1");
    assert.ok(samples >= 2);
    assert.equal(server.listenerCount("error"), 0);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      "ready",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("automatic allocation has a finite retry bound and closes its final listener", async (t) => {
  const server = createServer();
  let attempts = 0;
  t.mock.method(server, "address", () => {
    attempts++;
    return { address: "127.0.0.1", family: "IPv4", port: 6000 };
  });
  await assert.rejects(
    listenBrowserPort(server, 0, "127.0.0.1"),
    /after 8 attempts/u,
  );
  assert.equal(attempts, 8);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount("error"), 0);
});

test("an occupied explicit port preserves the bind error without retry", async () => {
  const occupied = createServer();
  const port = await listenBrowserPort(occupied, 0, "127.0.0.1");
  const contender = createServer();
  try {
    await assert.rejects(listenBrowserPort(contender, port, "127.0.0.1"), {
      code: "EADDRINUSE",
    });
    assert.equal(contender.listening, false);
    assert.equal(contender.listenerCount("error"), 0);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
