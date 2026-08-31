import assert from "node:assert/strict";
import test from "node:test";
import {
  registerWebCapability,
  subscribeWebCapabilities,
  webCapabilitySnapshot,
} from "../../extensions/shared/web-observer-registry.ts";

test("connects listeners to providers registered after the observer", () => {
  let changes = 0;
  let providerListener: (() => void) | undefined;
  const unsubscribeObserver = subscribeWebCapabilities(() => changes++);
  const unregister = registerWebCapability({
    kind: "subagents",
    snapshot: () => [{ id: "agent-1", status: "running" }],
    subscribe: (listener) => {
      providerListener = listener;
      return () => {
        providerListener = undefined;
      };
    },
  });

  assert.equal(changes, 1);
  assert.deepEqual(webCapabilitySnapshot(), {
    subagents: [{ id: "agent-1", status: "running" }],
  });
  providerListener?.();
  assert.equal(changes, 2);

  unregister();
  assert.equal(changes, 3);
  assert.deepEqual(webCapabilitySnapshot(), {});
  assert.equal(providerListener, undefined);
  unsubscribeObserver();
});

test("disconnects provider subscriptions when the observer closes", () => {
  let disconnected = false;
  const unregister = registerWebCapability({
    kind: "background-terminals",
    snapshot: () => [],
    subscribe: () => () => {
      disconnected = true;
    },
  });
  const unsubscribeObserver = subscribeWebCapabilities(() => {});

  unsubscribeObserver();
  assert.equal(disconnected, true);
  unregister();
});
