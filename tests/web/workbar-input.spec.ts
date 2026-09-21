// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "../../web/ui/src/components/PaneResizeHandle.tsx";
import { EmbeddedBrowserPanel } from "../../web/ui/src/features/workbar/EmbeddedBrowserPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function browserPanel() {
  const state = {
    sessionId: "session-1",
    url: "https://example.com/",
    title: "Input fixture",
    width: 800,
    height: 600,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  vi.spyOn(WebClient.prototype, "browserState").mockResolvedValue(state);
  vi.spyOn(WebClient.prototype, "browserFrame").mockResolvedValue(null);
  vi.spyOn(WebClient.prototype, "streamBrowserFrames").mockImplementation(
    (_id, signal) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const action = vi
    .spyOn(WebClient.prototype, "browserAction")
    .mockResolvedValue(state);
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(EmbeddedBrowserPanel, {
        sessionId: "session-1",
        active: true,
      }),
    ),
  );
  return {
    state,
    viewport: await screen.findByRole("application", { name: "Input fixture" }),
    action,
  };
}

it("forwards pasted Unicode text into the embedded page", async () => {
  const { viewport, action } = await browserPanel();
  fireEvent.paste(viewport, {
    clipboardData: { getData: () => "hello 中文\nworld" },
  });
  expect(action).toHaveBeenCalledWith("session-1", {
    type: "text",
    text: "hello 中文\nworld",
  });
});

it("coalesces wheel deltas while an input request is in flight", async () => {
  const { viewport, action, state } = await browserPanel();
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
  let complete!: (value: typeof state) => void;
  action.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  fireEvent.wheel(viewport, { clientX: 10, clientY: 10, deltaY: 10 });
  fireEvent.wheel(viewport, { clientX: 20, clientY: 20, deltaY: 20 });
  fireEvent.wheel(viewport, { clientX: 30, clientY: 30, deltaY: 30 });
  expect(action).toHaveBeenCalledTimes(1);
  await act(async () => complete(state));
  expect(action).toHaveBeenCalledTimes(2);
  expect(action).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({
      type: "mouse",
      event: "wheel",
      deltaY: 50,
      x: 30,
      y: 30,
    }),
  );
});

it("preserves Shift when navigating the embedded page backwards", async () => {
  const { viewport, action } = await browserPanel();
  fireEvent.keyDown(viewport, { key: "Tab", code: "Tab", shiftKey: true });
  expect(action).toHaveBeenCalledWith(
    "session-1",
    expect.objectContaining({ type: "key", key: "Tab", modifiers: 8 }),
  );
  fireEvent.keyUp(viewport, { key: "Tab", code: "Tab", shiftKey: true });
  expect(action).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({ event: "up", modifiers: 8 }),
  );
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
