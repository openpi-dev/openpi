import assert from "node:assert/strict";
import test from "node:test";
import {
  pb,
  type ProtoMessage,
} from "../../../extensions/ai-providers/cursor/protobuf.ts";

interface Counter extends ProtoMessage {
  count: number;
}

const Counter = pb<Counter>("test.Counter", [
  { kind: "uint32", no: 1, name: "count" },
]);

test("uint32 rejects a terminating fifth byte that exceeds 32 bits", () => {
  assert.equal(
    Counter.decode(Uint8Array.from([0x08, 0xff, 0xff, 0xff, 0xff, 0x0f])).count,
    0xffff_ffff,
  );
  assert.throws(
    () => Counter.decode(Uint8Array.from([0x08, 0x80, 0x80, 0x80, 0x80, 0x10])),
    /Varint exceeds 32 bits/,
  );
});
