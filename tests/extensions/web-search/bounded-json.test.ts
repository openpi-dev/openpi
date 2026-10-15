import assert from "node:assert/strict";
import test from "node:test";
import { admittedJsonBytes } from "../../../extensions/web-search/bounded-json.ts";

test("admission agrees with JSON UTF8 bytes at escaped and surrogate boundaries", () => {
  for (const value of [
    null,
    true,
    -12.5,
    { quote: '"\\\n\t', text: "界😀\ud800\udfff", nested: [null, {}, []] },
    Array.from({ length: 1000 }, (_, i) => ({ index: i, text: "é界😀" })),
  ]) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    assert.equal(admittedJsonBytes(value, bytes), bytes);
    assert.equal(admittedJsonBytes(value, bytes - 1), undefined);
  }
});

test("admission rejects cycles, accessors, non-JSON objects and deep or huge structures", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  let called = false;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      called = true;
      throw new Error("must not run");
    },
  });
  let deep: unknown = {};
  for (let i = 0; i < 600; i++) deep = [deep];
  for (const value of [
    cyclic,
    accessor,
    new Date(),
    deep,
    { value: "界".repeat(1000000) },
    { ["x".repeat(1000000)]: true },
  ])
    assert.equal(admittedJsonBytes(value, 256 * 1024), undefined);
  assert.equal(called, false);
});

test("array admission rejects extra enumerable data before it can be cloned", () => {
  const content: unknown[] & { extra?: string } = [];
  content.extra = "x".repeat(10 * 1024 * 1024);
  const item = { type: "web_search_call", content };
  assert.equal(admittedJsonBytes(item, 256 * 1024), undefined);
});

test("array admission never invokes indexed getters or custom iterators", () => {
  let getters = 0;
  let iterations = 0;
  const accessor = Object.defineProperty([], "0", {
    enumerable: true,
    get() {
      getters++;
      return "value";
    },
  });
  const iterable = Object.defineProperty(["value"], Symbol.iterator, {
    value() {
      iterations++;
      return ["value"][Symbol.iterator]();
    },
  });
  assert.equal(admittedJsonBytes(accessor, 256 * 1024), undefined);
  assert.equal(admittedJsonBytes(iterable, 256 * 1024), undefined);
  assert.equal(getters, 0);
  assert.equal(iterations, 0);
});

test("array admission rejects sparse, undefined and custom-prototype shapes", () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  for (const value of [
    new Array(3),
    [undefined],
    Object.setPrototypeOf([null], null),
    Object.setPrototypeOf([], Object.create(Array.prototype)),
    cyclic,
  ])
    assert.equal(admittedJsonBytes(value, 256 * 1024), undefined);
});
