import assert from "node:assert/strict";
import test from "node:test";
import * as undici from "undici";
import {
  configureHttpDispatcher,
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
} from "../../web/http-dispatcher.ts";

test("configures the Web dispatcher with the requested idle timeout", async () => {
  const original = undici.getGlobalDispatcher();
  const leases = [
    configureHttpDispatcher(),
    configureHttpDispatcher(0),
    configureHttpDispatcher(12.9),
  ];
  try {
    assert.equal(leases[0].timeoutMs, DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    assert.equal(leases[1].timeoutMs, 0);
    assert.equal(leases[2].timeoutMs, 12);
    assert.throws(
      () => configureHttpDispatcher(-1),
      /Invalid HTTP idle timeout/,
    );
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
  assert.equal(undici.getGlobalDispatcher(), original);
});

test("dispatcher leases release idempotently", async () => {
  const lease = configureHttpDispatcher();
  await lease.release();
  await lease.release();
});

test("dispatcher leases restore the dispatcher they replaced", async () => {
  const original = undici.getGlobalDispatcher();
  const outer = configureHttpDispatcher(100);
  const outerDispatcher = undici.getGlobalDispatcher();
  const inner = configureHttpDispatcher(200);
  assert.notEqual(undici.getGlobalDispatcher(), outerDispatcher);

  await inner.release();
  assert.equal(undici.getGlobalDispatcher(), outerDispatcher);
  await outer.release();
  assert.equal(undici.getGlobalDispatcher(), original);
});
