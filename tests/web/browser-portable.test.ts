import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(
  new URL("../../web/browser-extension/portable-control.js", import.meta.url),
  "utf8",
).replaceAll("export ", "");

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) =>
      listeners.delete(listener),
    emit: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
    listeners,
  };
}

function fixture() {
  const messages: Record<string, unknown>[] = [];
  const onConnect = event<[unknown]>();
  const onCommitted = event<[{ tabId: number; frameId: number }]>();
  const onRemoved = event<[number]>();
  const onActivated = event<[{ windowId: number }]>();
  const onMessage = event<[Record<string, unknown>]>();
  const onDisconnect = event<[]>();
  const port = {
    name: "openpi-native-page",
    sender: { tab: { id: 7 }, frameId: 0, url: "https://fixture.invalid/" },
    onMessage,
    onDisconnect,
    postMessage: (message: Record<string, unknown>) => messages.push(message),
    disconnect: () => onDisconnect.emit(),
  };
  const documentId = randomUUID();
  const peer = {
    native: true,
    id: "page",
    nonce: "peer",
    documentId,
    refs: undefined as Set<string> | undefined,
  };
  const owner = {
    origin: "http://127.0.0.1:30144",
    peers: new Map([[peer.nonce, peer]]),
    pages: new Set([peer.id]),
    control: undefined as { cancelled: boolean } | undefined,
  };
  const tabs = {
    onRemoved,
    onActivated,
    update: async () => ({ windowId: 2 }),
    query: async () => [{ id: 7 }],
    captureVisibleTab: async () => "data:image/png;base64,fixture",
  };
  const runtime = runInNewContext(
    `${source}\n({ controlBrowser, cancelBrowserControl, portableDocuments });`,
    {
      browser: { runtime: { onConnect }, webNavigation: { onCommitted }, tabs },
      crypto: { randomUUID },
      setTimeout,
      clearTimeout,
      URL,
    },
  ) as {
    controlBrowser: (
      tabId: number,
      boundOwner: typeof owner,
      boundPeer: typeof peer,
      requestId: string,
      request: Record<string, unknown>,
      current: () => boolean,
    ) => Promise<{ image?: string }>;
    cancelBrowserControl: (
      boundOwner: typeof owner,
      requestId?: string,
    ) => void;
    portableDocuments: Map<number, unknown>;
  };
  onConnect.emit(port);
  onMessage.emit({ type: "document", nonce: documentId });
  const start = (request: Record<string, unknown>) =>
    runtime.controlBrowser(7, owner, peer, "operation", request, () => true);
  const respond = (result: unknown) => {
    const message = messages.at(-1)!;
    onMessage.emit({
      type: "result",
      id: message.id,
      document: documentId,
      result,
    });
  };
  const observe = async () => {
    const result = start({ operation: "observe" });
    respond({ nodes: [{ ref: "@e1" }], text: "fixture" });
    await result;
  };
  return {
    ...runtime,
    owner,
    peer,
    tabs,
    port,
    onConnect,
    onCommitted,
    onRemoved,
    onMessage,
    documentId,
    messages,
    start,
    respond,
    observe,
  };
}

test("cancellation stops the remaining batch and reports uncertain delivery", async () => {
  const f = fixture();
  await f.observe();
  const result = f.start({
    operation: "act",
    actions: [
      { action: "setText", ref: "@e1", text: "first" },
      { action: "press", ref: "@e1" },
    ],
  });
  f.cancelBrowserControl(f.owner, "unrelated-operation");
  assert.equal(f.owner.control?.cancelled, false);
  f.cancelBrowserControl(f.owner, "operation");
  f.respond({ delivered: true });
  await assert.rejects(result, /revoked or changed.*uncertain/);
  assert.equal(f.messages.filter((m) => m.operation === "act").length, 1);
  assert.equal(f.peer.refs, undefined);
  assert.equal(f.owner.control, undefined);
});

test("a committed navigation or removed tab rejects outstanding work and invalidates refs", async () => {
  for (const removed of [false, true]) {
    const f = fixture();
    const result = f.start({ operation: "observe" });
    if (removed) f.onRemoved.emit(7);
    else f.onCommitted.emit({ tabId: 7, frameId: 0 });
    await assert.rejects(result, /document disconnected.*uncertain/);
    assert.equal(f.portableDocuments.has(7), false);
    const delivered = f.messages.length;
    await assert.rejects(
      f.start({ operation: "act", actions: [{ action: "press", ref: "@e1" }] }),
      /revoked or changed/,
    );
    assert.equal(f.messages.length, delivered);
  }
});

test("a replacement content document cannot inherit an old document's capability", async () => {
  const f = fixture();
  await f.observe();
  const replacement = event<[Record<string, unknown>]>();
  f.onConnect.emit({ ...f.port, onMessage: replacement });
  replacement.emit({ type: "document", nonce: randomUUID() });
  const delivered = f.messages.length;
  await assert.rejects(
    f.start({ operation: "act", actions: [{ action: "press", ref: "@e1" }] }),
    /revoked or changed/,
  );
  assert.equal(f.messages.length, delivered);
});

test("capture discards an image when the user switches tabs, even if they switch back", async () => {
  const f = fixture();
  f.tabs.captureVisibleTab = async () => {
    f.tabs.onActivated.emit({ windowId: 2 });
    return "data:image/png;base64,wrong-tab";
  };
  const result = f.start({ operation: "observe", image: true });
  f.respond({ nodes: [], text: "fixture" });
  await assert.rejects(result, /Screenshot discarded/);
  assert.equal(f.tabs.onActivated.listeners.size, 0);
  assert.equal(f.owner.control, undefined);
});

test("a grant revoked during capture prevents screenshot delivery", async () => {
  const f = fixture();
  f.tabs.captureVisibleTab = async () => {
    f.owner.pages.clear();
    return "data:image/png;base64,revoked";
  };
  const result = f.start({ operation: "observe", image: true });
  f.respond({ nodes: [], text: "fixture" });
  await assert.rejects(result, /revoked or changed/);
  assert.equal(f.tabs.onActivated.listeners.size, 0);
});
