import { describe, expect, it } from "vitest";
import {
  droppedItemAnchor,
  dropIsAfter,
  movedItemAnchor,
  sessionProject,
} from "../../web/ui/src/features/sessions/sidebar-order.ts";

describe("sidebar insertion anchors", () => {
  const items = [
    { path: "/same", id: "first" },
    { path: "/same", id: "replacement" },
    { path: "/third", id: "third" },
  ];
  it("preserves exact objects for keyboard moves and appends at the end", () => {
    expect(movedItemAnchor(items, 1, false)).toBe(items[0]);
    expect(movedItemAnchor(items, 0, true)).toBe(items[2]);
    expect(movedItemAnchor(items, 1, true)).toBeNull();
  });
  it("uses the target or its following anchor for a pointer drop", () => {
    expect(droppedItemAnchor(items, 1, false)).toBe(items[1]);
    expect(droppedItemAnchor(items, 1, true)).toBe(items[2]);
    expect(droppedItemAnchor(items, 2, true)).toBeNull();
    expect(dropIsAfter(25, { top: 10, height: 30 })).toBe(false);
    expect(dropIsAfter(26, { top: 10, height: 30 })).toBe(true);
  });
  it("projects original project independently of a fork's actual cwd", () => {
    expect(
      sessionProject({ workspacePath: "/project", cwd: "/managed/child" }),
    ).toBe("/project");
    expect(sessionProject({ cwd: "/project" })).toBe("/project");
  });
});
