// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
