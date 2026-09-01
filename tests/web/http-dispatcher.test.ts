import assert from "node:assert/strict";
import test from "node:test";
import { getGlobalDispatcher } from "undici";
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
    assert.equal(leases[1].timeoutMs, DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    assert.equal(leases[2].timeoutMs, DEFAULT_HTTP_IDLE_TIMEOUT_MS);
    assert.throws(
      () => configureHttpDispatcher(-1),
      /Invalid HTTP idle timeout/,
    );
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
  const replacement = configureHttpDispatcher(12.9);
  try {
    assert.equal(replacement.timeoutMs, 12);
  } finally {
    await replacement.release();
  }
});

test("dispatcher leases release idempotently", async () => {
  const lease = configureHttpDispatcher();
  await lease.release();
  await lease.release();
});

test("one runtime lease cannot close the shared dispatcher", async () => {
  const first = configureHttpDispatcher();
  const dispatcher = getGlobalDispatcher();
  const second = configureHttpDispatcher();
  try {
    assert.equal(getGlobalDispatcher(), dispatcher);
    await second.release();
    assert.equal(getGlobalDispatcher(), dispatcher);
  } finally {
    await first.release();
    await second.release();
  }
});
