import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach } from "node:test";
import type { QuestionOwner } from "../../web/host/questions.ts";

const directory = mkdtempSync(join(tmpdir(), "openpi-browser-broker-"));
process.env.PI_CODING_AGENT_DIR = directory;
writeFileSync(
  join(directory, "my-pi-setup.json"),
  JSON.stringify({ browser: { control: true } }),
);
const { WebBrowserBroker, validBrowserPages } = await import(
  "../../web/host/browser-control.ts"
);
after(() => rmSync(directory, { force: true, recursive: true }));
afterEach(() =>
  writeFileSync(
    join(directory, "my-pi-setup.json"),
    JSON.stringify({ browser: { control: true } }),
  ),
);
const owner: QuestionOwner = {
  workspace: "/workspace",
  sessionId: "session",
  commandId: "turn",
  epoch: 1,
  controllerId: "795239cc-8ff9-49cb-9894-e16b3ba86af7",
};
const page = {
  id: "frame-1",
  document: "795239cc-8ff9-49cb-9894-e16b3ba86af8",
  url: "https://example.com/",
  title: "Example",
};
const observed = {
  nodes: [{ ref: "@e1", role: "textbox", name: "Editor" }],
  text: "Example page",
  truncated: false,
};

const configure = (browser: Record<string, unknown>) =>
  writeFileSync(
    join(directory, "my-pi-setup.json"),
    JSON.stringify({ browser: { control: true, ...browser } }),
  );
const identity = (
  browser: "chrome" | "edge" = "chrome",
  profileId = "795239cc-8ff9-49cb-9894-e16b3ba86afa",
) => ({ browser, profileId, extensionId: "a".repeat(32), version: "0.3.0" });

test("default, explicit browser and an existing root preserve the user's exact browser selection", async () => {
  configure({
    defaultBrowser: "chrome",
    externalBrowsers: ["chrome", "edge", "brave"],
  });
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const chrome = broker.connect(owner.controllerId, identity());
  const edge = broker.connect("edge-controller", identity("edge"));
  const chromePage = {
    ...page,
    id: `${chrome.connectionId}/11`,
    title: "Chrome",
  };
  const edgePage = { ...page, id: `${edge.connectionId}/22`, title: "Edge" };
  broker.pollNative(chrome.connectionId, [chromePage]);
  broker.pollNative(edge.connectionId, [edgePage]);
  assert.match(
    JSON.stringify((await broker.execute({ operation: "tabs" })).details),
    /Chrome/,
  );
  assert.match(
    JSON.stringify(
      (await broker.execute({ operation: "tabs", browser: "" })).details,
    ),
    /Chrome/,
  );
  assert.match(
    JSON.stringify(
      (await broker.execute({ operation: "tabs", browser: "edge" })).details,
    ),
    /Edge/,
  );
  assert.match(
    JSON.stringify(
      (await broker.execute({ operation: "tabs", browser: "embedded" }))
        .details,
    ),
    /frame-1/,
  );
  await assert.rejects(
    broker.execute({ operation: "tabs", browser: "brave" }),
    /not connected/,
  );
  await assert.rejects(
    broker.execute({ operation: "tabs", browser: "chromium" }),
    /not allowed/,
  );
  const reading = broker.execute({ operation: "observe", root: edgePage.id });
  assert.equal(
    broker.pollNative(chrome.connectionId, [chromePage]).pending,
    null,
  );
  const pending = broker.pollNative(edge.connectionId, [edgePage]).pending!;
  assert.equal(
    broker.resultNative(chrome.connectionId, pending.requestId, observed),
    false,
  );
  assert.equal(
    broker.resultNative(edge.connectionId, pending.requestId, observed),
    true,
  );
  assert.equal(
    (await reading).details &&
      (await broker.execute({ operation: "browsers" })).content[0]?.type,
    "text",
  );
  await assert.rejects(
    broker.execute({
      operation: "observe",
      root: edgePage.id,
      browser: "chrome",
    }),
    /exact connected/,
  );
  broker.dispose();
});

test("multiple native profiles require an explicit connection ID and never silently choose a browser", async () => {
  configure({ externalBrowsers: ["chrome"] });
  const broker = new WebBrowserBroker(() => owner);
  const first = broker.connect("first", identity());
  const second = broker.connect("second", identity("chrome", page.document));
  broker.pollNative(first.connectionId, [
    { ...page, id: `${first.connectionId}/1` },
  ]);
  broker.pollNative(second.connectionId, [
    { ...page, id: `${second.connectionId}/1` },
  ]);
  await assert.rejects(
    broker.execute({ operation: "tabs", browser: "chrome" }),
    /Multiple chrome profiles/,
  );
  const selected = await broker.execute({
    operation: "tabs",
    browser: second.connectionId,
  });
  assert.match(
    JSON.stringify(selected.details),
    new RegExp(second.connectionId),
  );
  assert.doesNotMatch(
    JSON.stringify(selected.details),
    new RegExp(first.connectionId),
  );
  broker.dispose();
});

test("native credentials are scoped by connection and extension origin, and reconnect revokes them", () => {
  const broker = new WebBrowserBroker(() => owner);
  const connection = broker.connect(owner.controllerId, identity());
  const auth = `Bearer ${connection.token}`;
  assert.equal(
    broker.authenticate(
      connection.connectionId,
      auth,
      `chrome-extension://${identity().extensionId}`,
    ),
    true,
  );
  assert.equal(
    broker.authenticate(
      connection.connectionId,
      auth,
      "https://foreign.example",
    ),
    false,
  );
  assert.equal(
    broker.authenticate(
      connection.connectionId,
      `Bearer ${"b".repeat(64)}`,
      undefined,
    ),
    false,
  );
  assert.equal(broker.authenticate("other", auth, undefined), false);
  broker.connect(owner.controllerId, identity());
  assert.equal(
    broker.authenticate(connection.connectionId, auth, undefined),
    false,
  );
  broker.dispose();
});

test("revoking one browser cancels its in-flight work and consumes old observations without disabling discovery", async () => {
  configure({ externalBrowsers: ["chrome"] });
  const broker = new WebBrowserBroker(() => owner);
  const chrome = broker.connect(owner.controllerId, identity());
  const nativePage = { ...page, id: `${chrome.connectionId}/1` };
  broker.pollNative(chrome.connectionId, [nativePage]);
  const reading = broker.execute({ operation: "observe", root: nativePage.id });
  const first = broker.pollNative(chrome.connectionId, [nativePage]).pending!;
  broker.resultNative(chrome.connectionId, first.requestId, observed);
  const stateId = ((await reading).details as { stateId: string }).stateId;
  const writing = broker.execute({
    operation: "act",
    root: nativePage.id,
    stateId,
    actions: [{ action: "press", ref: "@e1" }],
  });
  const pending = broker.pollNative(chrome.connectionId, [nativePage]).pending!;
  configure({ externalBrowsers: [] });
  broker.reconcile();
  await assert.rejects(writing, /access was revoked/);
  assert.equal(
    broker.resultNative(chrome.connectionId, pending.requestId, observed),
    false,
  );
  assert.deepEqual(broker.pollNative(chrome.connectionId, [nativePage]), {
    enabled: false,
    pending: null,
  });
  assert.equal(broker.profiles()[0]?.connected, true);
  configure({ externalBrowsers: ["chrome"] });
  broker.pollNative(chrome.connectionId, [nativePage]);
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: nativePage.id,
      stateId,
      actions: [{ action: "press", ref: "@e1" }],
    }),
    /state is stale/,
  );
  broker.dispose();
});

test("native open acknowledges only a newly advertised document in its exact transport", async () => {
  configure({ defaultBrowser: "chrome", externalBrowsers: ["chrome"] });
  const broker = new WebBrowserBroker(() => owner);
  const connection = broker.connect(owner.controllerId, identity());
  broker.pollNative(connection.connectionId, []);
  const opening = broker.execute({ operation: "open", url: page.url });
  const pending = broker.pollNative(connection.connectionId, []).pending!;
  const added = { ...page, id: `${connection.connectionId}/10` };
  broker.pollNative(connection.connectionId, [added]);
  broker.resultNative(connection.connectionId, pending.requestId, {
    root: added.id,
  });
  assert.deepEqual((await opening).details, { root: added.id });
  broker.dispose();
});

test("invalid persisted permissions fail closed instead of selecting a different browser", async () => {
  const broker = new WebBrowserBroker(() => owner);
  for (const value of [
    { defaultBrowser: "safari" },
    { embedded: "true" },
    { externalBrowsers: ["chrome", "chrome"] },
  ]) {
    configure(value);
    await assert.rejects(broker.execute({ operation: "browsers" }), /enabled/);
  }
  broker.dispose();
});

test("disconnection and expired native heartbeat credentials revoke pending and future authority", async (t) => {
  configure({ externalBrowsers: ["chrome"] });
  t.mock.timers.enable({ apis: ["Date"] });
  const broker = new WebBrowserBroker(() => owner);
  const connection = broker.connect(owner.controllerId, identity());
  const auth = `Bearer ${connection.token}`;
  assert.equal(
    broker.authenticate(connection.connectionId, auth, undefined),
    true,
  );
  t.mock.timers.tick(15_001);
  assert.equal(
    broker.authenticate(connection.connectionId, auth, undefined),
    false,
  );
  assert.equal(broker.profiles().length, 0);
  broker.dispose();
});

test("embedded page advertisements are bounded and reject credentials and duplicate identities", () => {
  assert.ok(validBrowserPages([page]));
  assert.ok(
    validBrowserPages(
      [{ ...page, document: "C172E720FA2F839B12DE8D2D9E5709F0" }],
      64,
    ),
  );
  for (const pages of [
    [{ ...page, url: "https://user:secret@example.com/" }],
    [{ ...page, document: "" }],
    [page, page],
    Array(9).fill(page),
  ])
    assert.equal(validBrowserPages(pages), false);
});

test("the initiating controller owns discovery, result delivery and one dispatch without replay", async () => {
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  broker.poll(owner.sessionId, "sibling", [{ ...page, id: "sibling" }]);
  const tabs = await broker.execute({ operation: "tabs" });
  assert.match(JSON.stringify(tabs.details), /frame-1/);
  assert.doesNotMatch(JSON.stringify(tabs.details), /sibling/);
  const waiting = broker.execute({ operation: "observe", root: page.id });
  assert.equal(broker.poll(owner.sessionId, "sibling", [page]), null);
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  assert.ok("page" in pending);
  assert.deepEqual(broker.poll(owner.sessionId, owner.controllerId, [page]), {
    requestId: pending.requestId,
    running: true,
  });
  assert.equal(
    broker.result(owner.sessionId, "sibling", pending.requestId, observed),
    false,
  );
  assert.equal(
    broker.result(
      owner.sessionId,
      owner.controllerId,
      pending.requestId,
      observed,
    ),
    true,
  );
  assert.equal(
    broker.result(
      owner.sessionId,
      owner.controllerId,
      pending.requestId,
      observed,
    ),
    false,
  );
  assert.match(JSON.stringify((await waiting).details), /stateId/);
  broker.close();
});

test("a dispatched write consumes its state even when its result is uncertain", async () => {
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const read = broker.execute({ operation: "observe", root: page.id });
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  broker.result(
    owner.sessionId,
    owner.controllerId,
    pending.requestId,
    observed,
  );
  const result = await read;
  const stateId = (result.details as { stateId: string }).stateId;
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "typeText", text: "must not write" }],
    }),
    /require an observed ref/,
  );
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "press", ref: "@e2" }],
    }),
    /does not belong/,
  );
  const aborted = new AbortController();
  const write = broker.execute(
    {
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "setText", ref: "@e1", text: "中文" }],
    },
    aborted.signal,
  );
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  aborted.abort();
  await assert.rejects(write, /uncertain/);
  await assert.rejects(
    broker.execute({
      operation: "act",
      root: page.id,
      stateId,
      actions: [{ action: "press", ref: "@e1" }],
    }),
    /stale/,
  );
  broker.close();
});

test("opening an internal page requires a newly bound advertised root", async () => {
  const broker = new WebBrowserBroker(() => owner);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const invalid = broker.execute({ operation: "open", url: page.url });
  const missing = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  broker.result(owner.sessionId, owner.controllerId, missing.requestId, {
    root: "unbound",
  });
  await assert.rejects(invalid, /did not bind/);
  const waiting = broker.execute({ operation: "open", url: page.url });
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  broker.poll(owner.sessionId, owner.controllerId, [
    page,
    {
      ...page,
      id: "new-frame",
      document: "795239cc-8ff9-49cb-9894-e16b3ba86af9",
    },
  ]);
  broker.result(owner.sessionId, owner.controllerId, pending.requestId, {
    root: "new-frame",
  });
  assert.deepEqual((await waiting).details, { root: "new-frame" });
  broker.close();
});

test("document replacement, turn replacement, timeout and shutdown revoke pending control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active = owner;
  const broker = new WebBrowserBroker(() => active, 100);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const documentWait = broker.execute({ operation: "observe", root: page.id });
  broker.poll(owner.sessionId, owner.controllerId, [
    { ...page, document: "795239cc-8ff9-49cb-9894-e16b3ba86af9" },
  ]);
  await assert.rejects(documentWait, /closed or navigated/);
  broker.poll(owner.sessionId, owner.controllerId, [page]);
  const turnWait = broker.execute({ operation: "observe", root: page.id });
  const pending = broker.poll(owner.sessionId, owner.controllerId, [page])!;
  active = { ...owner, epoch: 2 };
  broker.reconcile();
  await assert.rejects(turnWait, /turn or Session changed/);
  assert.equal(
    broker.result(
      owner.sessionId,
      owner.controllerId,
      pending.requestId,
      observed,
    ),
    false,
  );
  const timeout = broker.execute({ operation: "observe", root: page.id });
  t.mock.timers.tick(101);
  await assert.rejects(timeout, /timed out.*uncertain/);
  const shutdown = broker.execute({ operation: "observe", root: page.id });
  broker.close();
  await assert.rejects(shutdown, /closed/);
});
