import assert from "node:assert/strict";
import test from "node:test";
import {
  configureHttpDispatcher,
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
} from "../../web/http-dispatcher.ts";

test("configures the Web dispatcher with the requested idle timeout", async () => {
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
});

test("dispatcher leases release idempotently", async () => {
  const lease = configureHttpDispatcher();
  await lease.release();
  await lease.release();
});
