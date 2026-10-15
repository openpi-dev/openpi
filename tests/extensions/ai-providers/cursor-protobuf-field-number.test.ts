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

test("decoder rejects protobuf field number zero", () => {
  assert.throws(
    () => Counter.decode(Uint8Array.from([0x00, 0x00])),
    /Invalid protobuf field number 0/,
  );
});
