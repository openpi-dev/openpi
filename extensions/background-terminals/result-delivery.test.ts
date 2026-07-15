import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";

test("a result consumed by a kill/status is not delivered", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    output: string;
  }>();

  delivery.defer({ id: "bt-1", output: "done" });
  delivery.consume(["bt-1"]);

  assert.deepEqual(delivery.drain(), []);
});

test("unconsumed results are delivered once in settlement order", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const first = { id: "bt-1" };
  const second = { id: "bt-2" };

  delivery.defer(first);
  delivery.defer(second);

  assert.deepEqual(delivery.drain(), [first, second]);
  assert.deepEqual(delivery.drain(), []);
});

test("re-deferring the same id replaces rather than duplicates", () => {
  const delivery = createDeferredResultDelivery<{ id: string; n: number }>();
  delivery.defer({ id: "bt-1", n: 1 });
  delivery.defer({ id: "bt-1", n: 2 });
  assert.deepEqual(delivery.drain(), [{ id: "bt-1", n: 2 }]);
});

test("a drained result can be retained for retry after delivery fails", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const result = { id: "bt-1" };
  delivery.defer(result);

  for (const drained of delivery.drain()) delivery.defer(drained);

  assert.deepEqual(delivery.drain(), [result]);
});
