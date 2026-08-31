import assert from "node:assert/strict";
import test from "node:test";
import { projectMessage } from "../../web/protocol/types.ts";

test("message projection does not create phantom text for detail-only messages", () => {
  const projected = projectMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal" },
      { type: "toolCall", name: "bash", arguments: "{}" },
    ],
  });
  assert.equal(projected.content, "");
  assert.equal(projected.parts?.length, 2);
});

test("message projection keeps text parts separated without phantom blank lines", () => {
  const projected = projectMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "visible" },
      { type: "toolCall", name: "bash", arguments: "{}" },
    ],
  });
  assert.equal(projected.content, "visible");
});
