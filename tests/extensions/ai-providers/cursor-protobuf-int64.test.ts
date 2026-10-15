import assert from "node:assert/strict";
import test from "node:test";
import {
  pb,
  type ProtoMessage,
} from "../../../extensions/ai-providers/cursor/protobuf.ts";

interface Counter extends ProtoMessage {
  count: bigint;
}

const Counter = pb<Counter>("test.Counter", [
  { kind: "int64", no: 1, name: "count" },
]);

test("int64 rejects a terminating tenth byte that exceeds 64 bits", () => {
  assert.equal(
    Counter.decode(
      Uint8Array.from([
        0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
      ]),
    ).count,
    -1n,
  );
  assert.throws(
    () =>
      Counter.decode(
        Uint8Array.from([
          0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f,
        ]),
      ),
    /Varint exceeds 64 bits/,
  );
});
