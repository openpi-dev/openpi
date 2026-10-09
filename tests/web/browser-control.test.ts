import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
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

test("embedded page advertisements are bounded and reject credentials and duplicate identities", () => {
  assert.ok(validBrowserPages([page]));
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
