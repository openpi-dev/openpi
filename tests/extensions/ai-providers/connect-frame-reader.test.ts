import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectFrameReader } from "../../../extensions/ai-providers/cursor/connect-frame-reader.ts";

function frame(text: string, flags = 0) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

test("Connect framing preserves every split, empty frames and coalesced boundaries", () => {
  const bytes = Buffer.concat([frame("hello", 1), frame(""), frame("世界", 2)]);
  for (let split = 0; split <= bytes.length; split++) {
    const reader = new ConnectFrameReader(100);
    const seen: Array<[number, string]> = [];
    const receive = (flags: number, data: Buffer) =>
      seen.push([flags, data.toString()]);
    reader.push(bytes.subarray(0, split), receive);
    reader.push(bytes.subarray(split), receive);
    assert.deepEqual(seen, [
      [1, "hello"],
      [0, ""],
      [2, "世界"],
    ]);
    assert.equal(reader.incomplete, false);
  }
});

test("Connect reader distinguishes partial headers and payloads and rejects oversized headers", () => {
  const reader = new ConnectFrameReader(5);
  const bytes = frame("hello");
  const seen: string[] = [];
  const receive = (_flags: number, data: Buffer) => seen.push(data.toString());
  reader.push(bytes.subarray(0, 4), receive);
  assert.equal(reader.incomplete, true);
  assert.equal(reader.awaitingPayload, false);
  reader.push(bytes.subarray(4, 7), receive);
  assert.equal(reader.awaitingPayload, true);
  reader.push(bytes.subarray(7), receive);
  assert.deepEqual(seen, ["hello"]);
  assert.equal(reader.incomplete, false);
  const tooBig = frame("123456");
  assert.throws(
    () => reader.push(tooBig.subarray(0, 5), receive),
    /exceeds 5 bytes/,
  );
});

test("fragmented Connect payload copying is linear in wire bytes", () => {
  const bytes = frame("x".repeat(1024 * 1024));
  const reader = new ConnectFrameReader(bytes.length);
  const originalConcat = Buffer.concat;
  const originalCopy = Buffer.prototype.copy;
  let copied = 0;
  let delivered = 0;
  Buffer.concat = (list, length) => {
    copied += length ?? list.reduce((sum, item) => sum + item.length, 0);
    return originalConcat(list, length);
  };
  Buffer.prototype.copy = function (...args: Parameters<Buffer["copy"]>) {
    const count = originalCopy.apply(this, args);
    copied += count;
    return count;
  };
  try {
    for (let i = 0; i < bytes.length; i += 1024) {
      reader.push(bytes.subarray(i, i + 1024), (_flags, data) => {
        assert.equal(data.length, 1024 * 1024);
        delivered++;
      });
    }
  } finally {
    Buffer.concat = originalConcat;
    Buffer.prototype.copy = originalCopy;
  }
  assert.equal(delivered, 1);
  assert.ok(
    copied <= bytes.length * 2,
    `${copied} copied bytes for ${bytes.length} wire bytes`,
  );
});

test("completed payload buffers are not reused by later frames", () => {
  const reader = new ConnectFrameReader(100);
  const retained: Buffer[] = [];
  for (const text of ["first", "second"]) {
    const bytes = frame(text);
    for (const byte of bytes)
      reader.push(Buffer.from([byte]), (_flags, data) => retained.push(data));
  }
  assert.deepEqual(
    retained.map((data) => data.toString()),
    ["first", "second"],
  );
  assert.equal(reader.incomplete, false);
});
