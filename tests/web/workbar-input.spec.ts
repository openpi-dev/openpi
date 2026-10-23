// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "../../web/ui/src/components/PaneResizeHandle.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("ignores resize jitter and lets Escape restore the drag's starting width", () => {
  const change = vi.fn();
  const dragging = vi.fn();
  render(
    createElement(PaneResizeHandle, {
      side: "left",
      value: 400,
      min: 200,
      max: 600,
      defaultValue: 300,
      onChange: change,
      onDraggingChange: dragging,
    }),
  );
  const handle = screen.getByRole("separator");
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  });
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(handle, event);
  };
  pointer("pointerdown", 100);
  pointer("pointermove", 102);
  expect(change).not.toHaveBeenCalled();
  expect(dragging).not.toHaveBeenCalled();
  pointer("pointermove", 180);
  expect(change).toHaveBeenLastCalledWith(480);
  expect(dragging).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(handle, { key: "Escape" });
  expect(change).toHaveBeenLastCalledWith(400);
  expect(dragging).toHaveBeenLastCalledWith(false);
  pointer("pointermove", 250);
  expect(change).toHaveBeenCalledTimes(2);
});

it.each(["left", "right"] as const)(
  "exposes bounded keyboard resizing for the %s pane",
  (side) => {
    const change = vi.fn();
    render(
      createElement(PaneResizeHandle, {
        side,
        value: 400,
        min: 200,
        max: 600,
        defaultValue: 300,
        onChange: change,
        onDraggingChange: vi.fn(),
      }),
    );
    const handle = screen.getByRole("separator");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(change).toHaveBeenLastCalledWith(side === "left" ? 416 : 384);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(change).toHaveBeenLastCalledWith(200);
    fireEvent.keyDown(handle, { key: "End" });
    expect(change).toHaveBeenLastCalledWith(600);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(change).toHaveBeenLastCalledWith(300);
  },
);
