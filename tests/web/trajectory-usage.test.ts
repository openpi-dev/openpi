import assert from "node:assert/strict";
import test from "node:test";
import { projectMessage } from "../../web/protocol/types.ts";

test("per-response usage preserves reported zeros and rejects unknown or invalid fields", () => {
  const message = projectMessage({
    role: "assistant",
    content: [],
    provider: "local",
    model: "configured",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: Number.NaN,
      secret: "private",
    },
  });
  assert.deepEqual(message.usage, { input: 100, output: 20, cacheRead: 0 });
  assert.equal(message.provider, "local");
  assert.equal(message.model, "configured");
  assert.equal(
    projectMessage({ role: "assistant", content: [] }).usage,
    undefined,
  );
  assert.equal(
    projectMessage({ role: "toolResult", content: [], usage: { input: 99 } })
      .usage,
    undefined,
  );
});

test("failed provider placeholder accounting does not establish token usage", () => {
  for (const stopReason of ["error", "aborted"])
    assert.equal(
      projectMessage({
        role: "assistant",
        content: [],
        stopReason,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }).usage,
      undefined,
    );
});

test("a failed response retains nonzero provider accounting", () => {
  assert.deepEqual(
    projectMessage({
      role: "assistant",
      stopReason: "error",
      usage: { input: 120, output: 5, cacheRead: 0 },
    }).usage,
    { input: 120, output: 5, cacheRead: 0 },
  );
});
