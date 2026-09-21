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
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  const view = render(
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
    unmount: view.unmount,
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

it.each([
  ["127.0.0.1:12345/test", "http://127.0.0.1:12345/test"],
  ["localhost:12345/test", "http://localhost:12345/test"],
  ["[::1]:12345/test", "http://[::1]:12345/test"],
  ["localhost:443", "http://localhost:443/"],
  ["127.example.com/test", "https://127.example.com/test"],
  ["https://localhost:12345/test", "https://localhost:12345/test"],
])("chooses the correct protocol and port for %s", async (input, expected) => {
  const { state } = await browserPanel();
  const open = vi
    .spyOn(WebClient.prototype, "openBrowser")
    .mockResolvedValue(state);
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
    { target: { value: input } },
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
  expect(open).toHaveBeenCalledWith(
    "session-1",
    expected,
    expect.any(Object),
    expect.any(AbortSignal),
  );
  await act(async () => {});
});

it.each([
  { metaKey: true, modifiers: 4 },
  { ctrlKey: true, modifiers: 2 },
])(
  "forwards editing shortcuts without inserting a literal letter (%j)",
  async ({ modifiers, ...keys }) => {
    const { viewport, action } = await browserPanel();
    fireEvent.keyDown(viewport, { key: "a", code: "KeyA", ...keys });
    expect(action).toHaveBeenCalledWith("session-1", {
      type: "key",
      event: "down",
      key: "a",
      code: "KeyA",
      modifiers,
    });
    fireEvent.keyUp(viewport, { key: "a", code: "KeyA", ...keys });
    expect(action).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ event: "up", modifiers }),
    );
    const count = action.mock.calls.length;
    fireEvent.keyDown(viewport, { key: "v", code: "KeyV", ...keys });
    expect(action).toHaveBeenCalledTimes(count);
  },
);

it("keeps only the newest pointer position while the host is slow", async () => {
  const { viewport, action, state } = await browserPanel();
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
  let finish!: (value: typeof state) => void;
  action.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  for (let x = 1; x <= 20; x++) {
    fireEvent.pointerMove(viewport, { clientX: x, clientY: 10 });
    await act(() => vi.advanceTimersByTimeAsync(60));
  }
  expect(action).toHaveBeenCalledTimes(1);
  await act(async () => finish(state));
  await act(() => vi.advanceTimersByTimeAsync(60));
  expect(action).toHaveBeenCalledTimes(2);
  expect(action).toHaveBeenLastCalledWith(
    "session-1",
    expect.objectContaining({ type: "mouse", event: "move", x: 20 }),
  );
});

it("drops an unsent pointer update when the browser tool closes", async () => {
  const { viewport, action, state, unmount } = await browserPanel();
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
  let finish!: (value: typeof state) => void;
  action.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.pointerMove(viewport, { clientX: 10, clientY: 10 });
  fireEvent.pointerMove(viewport, { clientX: 20, clientY: 10 });
  expect(action).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => finish(state));
  expect(action).toHaveBeenCalledTimes(1);
});

it.each(["left", "right"] as const)(
  "captures %s-button drags and releases them when capture is lost",
  async (buttonName) => {
    const { viewport, action } = await browserPanel();
    class TestPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 7;
      }
    }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const capture = vi.fn();
    Object.defineProperty(viewport, "setPointerCapture", { value: capture });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
    } as DOMRect);
    const button = buttonName === "left" ? 0 : 2;
    const buttons = buttonName === "left" ? 1 : 2;
    fireEvent.pointerDown(viewport, {
      pointerId: 7,
      button,
      buttons,
      clientX: 20,
      clientY: 20,
    });
    expect(action).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        type: "mouse",
        event: "down",
        button: buttonName,
        buttons,
      }),
    );
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(viewport, {
      pointerId: 7,
      buttons,
      clientX: 30,
      clientY: 20,
    });
    expect(action).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ event: "move", button: buttonName, buttons }),
    );
    fireEvent.lostPointerCapture(viewport, { pointerId: 7 });
    await act(async () => {});
    expect(action).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({ event: "up", button: buttonName, buttons: 0 }),
    );
  },
);

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
