import { expect, it } from "vitest";
import { compactPath } from "../../web/ui/src/lib/format.ts";

it("keeps the identifying tail of a long workspace path", () => {
  expect(compactPath("/Users/admin/.codex/worktrees/a377/openpi")).toBe(
    "…/a377/openpi",
  );
  expect(compactPath("C:\\work\\openpi")).toBe("…/work/openpi");
  expect(compactPath("/repos/openpi")).toBe("/repos/openpi");
});
