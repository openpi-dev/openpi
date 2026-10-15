import assert from "node:assert/strict";
import test from "node:test";
import {
  pb,
  type ProtoMessage,
} from "../../../extensions/ai-providers/cursor/protobuf.ts";

interface StringMapMessage extends ProtoMessage {
  values: Record<string, string>;
}

const StringMap = pb<StringMapMessage>("test.StringMap", [
  { kind: "map", no: 1, name: "values", K: "string", V: "string" },
]);

test("protobuf maps do not decode beyond a declared entry boundary", () => {
  const valid = Uint8Array.from([
    0x0a, 0x0a, 0x0a, 0x03, 0x75, 0x72, 0x6c, 0x12, 0x03, 0x66, 0x6f, 0x6f,
  ]);
  const malformed = Uint8Array.from(valid);
  malformed[1] = 9;

  assert.equal(StringMap.decode(valid).values.url, "foo");
  assert.throws(
    () => StringMap.decode(malformed),
    /Unexpected EOF reading bytes/,
  );
});
