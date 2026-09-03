import assert from "node:assert/strict";
import { test } from "node:test";
import { projectText } from "../../../extensions/shared/text-projection.ts";

function lineCount(content: string) {
  if (!content) return 0;
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.length;
}

function assertWithinBudgets(
  content: string,
  maxBytes: number,
  maxLines: number,
  label: string,
) {
  assert.ok(
    Buffer.byteLength(content, "utf8") <= maxBytes,
    `${label}: exceeded ${maxBytes} bytes`,
  );
  assert.ok(
    lineCount(content) <= maxLines,
    `${label}: exceeded ${maxLines} lines`,
  );
  assert.doesNotMatch(content, /�/, `${label}: split a UTF-8 character`);
}

test("content inside both budgets passes through byte-for-byte", () => {
  for (const content of ["", "one line", "first\nsecond\n", "中文\r\n🙂"]) {
    assert.equal(
      projectText(content, {
        maxBytes: 1024,
        maxLines: 10,
        recovery: "unused",
      }),
      content,
    );
  }
});

test("zero byte or line budgets produce no projection", () => {
  const content = "🙂".repeat(100);
  assert.equal(
    projectText(content, {
      maxBytes: 0,
      maxLines: 20,
      recovery: "kept in artifacts",
    }),
    "",
  );
  assert.equal(
    projectText(content, {
      maxBytes: 2048,
      maxLines: 0,
      recovery: "kept in artifacts",
    }),
    "",
  );
});

test("tiny projections never exceed their UTF-8 byte budget", () => {
  for (const maxBytes of [1, 2, 3, 4, 5, 16]) {
    const projected = projectText("🙂".repeat(100), {
      maxBytes,
      maxLines: 20,
      recovery: "kept in artifacts",
    });
    assertWithinBudgets(projected, maxBytes, 20, `${maxBytes}-byte cap`);
    assert.match(projected, /(?:middle omitted|^\.+$)/m);
  }
});

test("line-only projections respect the hard line cap without duplicating content", () => {
  const content = Array.from({ length: 40 }, (_, index) => `L${index}`).join(
    "\n",
  );
  const projected = projectText(content, {
    maxBytes: 2048,
    maxLines: 10,
    recovery: "kept in artifacts",
  });

  assert.equal(lineCount(projected), 10);
  assert.match(projected, /^L0$/m);
  assert.match(projected, /^L39$/m);
  assert.deepEqual(
    projected.split("\n").filter((line) => /^L\d+$/.test(line)),
    ["L0", "L1", "L2", "L38", "L39"],
  );
  assert.match(projected, /\[\.\.\. middle omitted \.\.\.\]/);
  assertWithinBudgets(projected, 2048, 10, "line-only projection");
});

test("small line budgets use a visible compact omission projection", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `L${index}`);
  const content = lines.join("\n");

  for (const maxLines of [1, 2, 3, 4, 5, 6]) {
    const projected = projectText(content, {
      maxBytes: 2048,
      maxLines,
      recovery: "kept in artifacts",
    });
    assert.match(projected, /middle omitted/);
    if (maxLines >= 3) {
      assert.match(projected, /^L0$/m);
      assert.match(projected, /^L19$/m);
    }
    assertWithinBudgets(projected, 2048, maxLines, `${maxLines}-line fallback`);
  }

  assert.equal(
    projectText(content, {
      maxBytes: 2048,
      maxLines: 3,
      recovery: "kept in artifacts",
    }),
    "L0\n[... middle omitted ...]\nL19",
  );
});

test("multi-line recovery text is included in the hard line budget", () => {
  const content = Array.from({ length: 40 }, (_, index) => `L${index}`).join(
    "\n",
  );
  const projected = projectText(content, {
    maxBytes: 2048,
    maxLines: 12,
    recovery: "artifact line one\nartifact line two",
  });

  assert.equal(lineCount(projected), 12);
  assert.match(projected, /^L0$/m);
  assert.match(projected, /^L39$/m);
  assert.match(projected, /artifact line one\nartifact line two\]$/);
  assertWithinBudgets(projected, 2048, 12, "multi-line recovery");
});

test("byte-only truncation keeps valid UTF-8 at both ends", () => {
  const content = `BEGIN-${"中🙂".repeat(100)}-END`;
  const projected = projectText(content, {
    maxBytes: 256,
    maxLines: 20,
    recovery: "kept in artifacts",
  });

  assert.match(projected, /^BEGIN-/);
  assert.match(projected, /-END/);
  assert.match(projected, /\[\.\.\. middle omitted \.\.\.\]/);
  assertWithinBudgets(projected, 256, 20, "byte-only projection");
});

test("byte and line caps hold across encodings and newline styles", () => {
  const samples = [
    Array.from({ length: 40 }, (_, index) => `ASCII-${index}`).join("\n"),
    Array.from({ length: 40 }, (_, index) => `CRLF-${index}`).join("\r\n"),
    Array.from({ length: 40 }, (_, index) => `中文-${index}`).join("\n"),
    Array.from({ length: 40 }, (_, index) => `🙂-${index}`).join("\n"),
    `BEGIN-${"中🙂".repeat(100)}-END`,
  ];
  const byteLimits = [1, 4, 16, 64, 256, 2048];
  const lineLimits = [0, 1, 3, 6, 7, 10, 20];
  const recoveries = ["artifact", "artifact one\nartifact two"];
  let cases = 0;

  for (const content of samples) {
    for (const maxBytes of byteLimits) {
      for (const maxLines of lineLimits) {
        for (const recovery of recoveries) {
          const projected = projectText(content, {
            maxBytes,
            maxLines,
            recovery,
          });
          const label = JSON.stringify({
            sample: samples.indexOf(content),
            maxBytes,
            maxLines,
            recoveryLines: lineCount(recovery),
          });
          assertWithinBudgets(projected, maxBytes, maxLines, label);
          const fitsWithoutProjection =
            Buffer.byteLength(content, "utf8") <= maxBytes &&
            lineCount(content) <= maxLines;
          if (fitsWithoutProjection) {
            assert.equal(projected, content, `${label}: changed bounded input`);
          } else if (maxBytes > 0 && maxLines > 0) {
            assert.match(
              projected,
              /(?:middle omitted|^\.+$)/m,
              `${label}: silently omitted content`,
            );
          }
          cases++;
        }
      }
    }
  }

  assert.equal(cases, 420);
});
