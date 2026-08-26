import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  encodeCompleteJson,
  safeStringify,
  writeFileAtomic,
} from "../../../extensions/workflows/serialization.ts";

test("complete JSON encoding stops reading arrays at the first hard limit", () => {
  let reads = 0;
  const values = new Proxy(new Array(1_000_000).fill("value"), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });

  const encoded = encodeCompleteJson(values, {
    maxBytes: 1_024,
    maxDepth: 8,
    maxNodes: 5,
    maxStringBytes: 128,
  });

  assert.deepEqual(encoded.ok ? undefined : encoded.limit, "nodes");
  assert.ok(reads <= 4, `read ${reads} array elements after the node budget`);
});

test("complete JSON encoding charges escaped UTF-8 bytes before reading values", () => {
  let lateValueRead = false;
  const value = Object.defineProperties(
    {},
    {
      ['"\n'.repeat(40)]: {
        enumerable: true,
        get: () => "first",
      },
      late: {
        enumerable: true,
        get: () => {
          lateValueRead = true;
          throw new Error("late value must not be read");
        },
      },
    },
  );

  const encoded = encodeCompleteJson(value, {
    maxBytes: 96,
    maxDepth: 8,
    maxNodes: 20,
    maxStringBytes: 1_024,
  });

  assert.equal(encoded.ok, false);
  assert.equal(encoded.ok ? undefined : encoded.limit, "bytes");
  assert.equal(lateValueRead, false);
});

test("complete JSON encoding preserves supported values within its exact cap", () => {
  const value: Record<string, unknown> = {
    emoji: "你好🙂",
    quote: '"\\\n',
    bigint: 42n,
    number: Number.NaN,
  };
  value.self = value;

  const encoded = encodeCompleteJson(value, {
    maxBytes: 512,
    maxDepth: 8,
    maxNodes: 20,
    maxStringBytes: 128,
  });

  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.equal(encoded.bytes, Buffer.byteLength(encoded.json, "utf8"));
  assert.ok(encoded.bytes <= 512);
  const parsed = JSON.parse(encoded.json) as Record<string, unknown>;
  assert.equal(parsed.emoji, "你好🙂");
  assert.equal(parsed.quote, '"\\\n');
  assert.equal(parsed.bigint, "42n");
  assert.equal(parsed.number, "[number: NaN]");
  assert.equal(parsed.self, "[circular: $root]");
});

test("lossy serialization also stops collection reads at the node limit", () => {
  let reads = 0;
  const values = new Proxy(new Array(1_000_000).fill("value"), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });

  const text = safeStringify(values, {
    maxBytes: 1_024,
    maxDepth: 8,
    maxNodes: 5,
    maxStringBytes: 128,
  });

  assert.doesNotThrow(() => JSON.parse(text));
  assert.match(text, /truncated/);
  assert.ok(reads <= 4, `read ${reads} array elements after the node budget`);
});

test("complete JSON encoding contains object enumeration failures", () => {
  const value = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("fixture ownKeys failure");
      },
    },
  );

  const encoded = encodeCompleteJson(value, {
    maxBytes: 512,
    maxDepth: 8,
    maxNodes: 20,
    maxStringBytes: 128,
  });

  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.match(encoded.json, /unreadable object.*fixture ownKeys failure/);
  assert.doesNotThrow(() => JSON.parse(encoded.json));
});

test("complete JSON encoding charges sparse array slots to the node budget", () => {
  let lengthReads = 0;
  let hasChecks = 0;
  const values = new Proxy(new Array(10_000), {
    get(target, property, receiver) {
      if (property === "length") lengthReads++;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      hasChecks++;
      return Reflect.has(target, property);
    },
  });

  const encoded = encodeCompleteJson(values, {
    maxBytes: 1024 * 1024,
    maxDepth: 8,
    maxNodes: 5,
    maxStringBytes: 128,
  });

  assert.equal(encoded.ok, false);
  assert.equal(encoded.ok ? undefined : encoded.limit, "nodes");
  assert.equal(lengthReads, 1);
  assert.ok(hasChecks <= 4, `checked ${hasChecks} slots after the node budget`);
});

test("complete JSON encoding rejects non-finite budget configuration", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        encodeCompleteJson("value", {
          maxBytes: invalid,
          maxDepth: 8,
          maxNodes: 10,
          maxStringBytes: 128,
        }),
      /maxBytes must be a finite integer/i,
    );
  }
});

test("oversized object keys fail before their values are read", () => {
  let valueRead = false;
  const key = "k".repeat(1024 * 1024);
  const value = Object.defineProperty({}, key, {
    enumerable: true,
    get() {
      valueRead = true;
      return "unreachable";
    },
  });

  const encoded = encodeCompleteJson(value, {
    maxBytes: 2 * 1024 * 1024,
    maxDepth: 8,
    maxNodes: 10,
    maxStringBytes: 128,
  });

  assert.equal(encoded.ok, false);
  if (encoded.ok) return;
  assert.equal(encoded.limit, "string");
  assert.equal(valueRead, false);
  assert.ok(Buffer.byteLength(encoded.path, "utf8") <= 256);
});

test("safeStringify handles cycles, bigint, depth, and size", () => {
  const value: Record<string, unknown> = {
    bigint: 42n,
    nested: { deeper: { deepest: true } },
    large: "x".repeat(20_000),
  };
  value.self = value;

  const text = safeStringify(value, {
    maxBytes: 2_048,
    maxDepth: 2,
    maxStringBytes: 512,
  });
  assert.ok(Buffer.byteLength(text, "utf8") <= 2_048);
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object");
  assert.match(text, /42n/);
  assert.match(text, /circular/);
  assert.match(text, /truncated/);
});

test("atomic writes leave complete readable content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');
    writeFileAtomic(file, '{"value":2}');
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
