import { expect, it } from "vitest";
import { buildTrajectory } from "../../web/ui/src/features/trajectory/trajectory.ts";
import type { WebLiveMessage } from "../../web/protocol/types.ts";
function entry(id: string, message: WebLiveMessage) {
  return {
    id,
    type: "message" as const,
    timestamp: "2026-09-07T00:00:00Z",
    message,
  };
}
const call = (id: string) => ({
  role: "assistant",
  content: "",
  parts: [
    {
      type: "toolCall" as const,
      id,
      name: "bash",
      arguments: '{"command":"pwd"}',
    },
  ],
});
const result = (id: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: "/ws",
  isError: false,
});
it("retains repeated prompts and empty-text calls and pairs only their exact results", () => {
  const nodes = buildTrajectory([
    entry("u1", { role: "user", content: "again" }),
    entry("a1", call("t1")),
    entry("r1", result("t1")),
    entry("u2", { role: "user", content: "again" }),
    entry("a2", call("t2")),
    entry("r2", result("t2")),
  ]);
  expect(nodes.map((n) => n.key)).toEqual([
    "u1",
    "a1:call:0",
    "u2",
    "a2:call:0",
  ]);
  expect(
    nodes.filter((n) => n.kind === "call").map((n) => n.result?.toolCallId),
  ).toEqual(["t1", "t2"]);
});
it("keeps clipped-prefix results and ambiguous duplicate ids without claiming running", () => {
  const nodes = buildTrajectory([
    entry("r0", result("old")),
    entry("a1", call("same")),
    entry("a2", call("same")),
    entry("r1", result("same")),
    entry("a3", call("missing")),
  ]);
  expect(nodes.map((n) => n.key)).toEqual([
    "r0",
    "a1:call:0",
    "a2:call:0",
    "r1",
    "a3:call:0",
  ]);
  expect(
    nodes
      .filter((n) => n.kind === "call")
      .every((n) => n.outcome === "unknown" && !n.result),
  ).toBe(true);
});
it("does not pair duplicate results or a different tool name", () => {
  const nodes = buildTrajectory([
    entry("a", call("t")),
    entry("r1", result("t")),
    entry("r2", result("t")),
    entry("b", call("u")),
    entry("r3", { ...result("u"), toolName: "read" }),
  ]);
  expect(nodes.filter((n) => n.kind === "result")).toHaveLength(3);
  expect(nodes.filter((n) => n.kind === "call").every((n) => !n.result)).toBe(
    true,
  );
});
it("retains non-message events without inventing their payload", () => {
  expect(
    buildTrajectory([{ id: "compact", type: "compaction", timestamp: "now" }]),
  ).toEqual([
    { key: "compact", kind: "event", title: "compaction", timestamp: "now" },
  ]);
});
it("does not pair a result that precedes its only retained call", () => {
  const nodes = buildTrajectory([
    entry("r", result("t")),
    entry("a", call("t")),
  ]);
  expect(nodes.map((node) => node.kind)).toEqual(["result", "call"]);
  expect(nodes[1]?.result).toBeUndefined();
});
