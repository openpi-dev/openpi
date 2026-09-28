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
import {
  WEB_BROWSER_TEXT_MAX_LENGTH,
  type WebBrowserFrame,
  type WebEmbeddedBrowserState,
} from "../../web/protocol/types.ts";
import { PaneResizeHandle } from "../../web/ui/src/components/PaneResizeHandle.tsx";
import { EmbeddedBrowserPanel } from "../../web/ui/src/features/workbar/EmbeddedBrowserPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function browserPanel(
  restore?: Promise<void>,
  inputTarget?: WebEmbeddedBrowserState["inputTarget"],
) {
  const state: WebEmbeddedBrowserState = {
    sessionId: "session-1",
    url: "https://example.com/",
    title: "Input fixture",
    width: 800,
    height: 600,
    loading: false,
    canGoBack: true,
    canGoForward: false,
    inputTarget,
  };
  vi.spyOn(WebClient.prototype, "browserState").mockImplementation(async () => {
    await restore;
    return state;
  });
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
  const viewport = await screen.findByRole("application", {
    name: "Input fixture",
  });
  // A visible DOM commit can precede passive effects such as the native wheel
  // listener. Settle React before the fixture starts dispatching input.
  await act(async () => {});
  return {
    state,
    viewport,
    action,
    read: vi.mocked(WebClient.prototype.browserState),
    stream: vi.mocked(WebClient.prototype.streamBrowserFrames),
    rerender: (active: boolean) =>
      view.rerender(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(EmbeddedBrowserPanel, {
            sessionId: "session-1",
            active,
          }),
        ),
      ),
    unmount: view.unmount,
  };
}

const editableTarget = {
  owner: "native-document:focused-field:1",
  kind: "textarea",
  anchorRect: { x: 10, y: 20, width: 300, height: 40 },
} satisfies NonNullable<WebEmbeddedBrowserState["inputTarget"]>;

function enablePointer(viewport: HTMLElement) {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
}

it("uses the text proxy only after the latest native editable pointer receipt", async () => {
  const { viewport, action, state } = await browserPanel();
  enablePointer(viewport);
  let finish!: (value: typeof state) => void;
  action.mockResolvedValueOnce(state).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.pointerDown(viewport, {
    button: 0,
    buttons: 1,
    clientX: 20,
    clientY: 30,
  });
  fireEvent.pointerUp(viewport, { button: 0, clientX: 20, clientY: 30 });
  expect(document.activeElement).toBe(viewport);
  let proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  expect(proxy.disabled).toBe(true);
  await act(async () => finish({ ...state, inputTarget: editableTarget }));
  expect(proxy.isConnected).toBe(false);
  proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  expect(proxy.disabled).toBe(false);
  expect(document.activeElement).toBe(proxy);
  fireEvent.input(proxy, { target: { value: "中文" } });
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "text",
    text: "中文",
    owner: editableTarget.owner,
  });
});

it.each([null, undefined])(
  "does not claim an editable target for a %s native receipt",
  async (inputTarget) => {
    const { viewport, state, action } = await browserPanel();
    enablePointer(viewport);
    action.mockResolvedValue({ ...state, inputTarget });
    fireEvent.pointerDown(viewport, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 30,
    });
    fireEvent.pointerUp(viewport, { button: 0, clientX: 20, clientY: 30 });
    await act(async () => {});
    expect(document.activeElement).toBe(viewport);
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: "Input fixture",
      }).disabled,
    ).toBe(true);
  },
);

it("does not let a late editable receipt steal address focus", async () => {
  const { viewport, action, state } = await browserPanel();
  enablePointer(viewport);
  let finish!: (value: typeof state) => void;
  action.mockResolvedValueOnce(state).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.pointerDown(viewport, {
    button: 0,
    buttons: 1,
    clientX: 20,
    clientY: 30,
  });
  fireEvent.pointerUp(viewport, { button: 0, clientX: 20, clientY: 30 });
  const address = screen.getByRole("textbox", {
    name: i18n.t("browserAddress"),
  });
  act(() => address.focus());
  await act(async () => finish({ ...state, inputTarget: editableTarget }));
  expect(document.activeElement).toBe(address);
  expect(
    screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Input fixture" })
      .disabled,
  ).toBe(true);
});

it("keeps the newest field owner when two pointer receipts complete out of order", async () => {
  const { viewport, action, state } = await browserPanel();
  enablePointer(viewport);
  let finishOld!: (value: typeof state) => void;
  let finishNew!: (value: typeof state) => void;
  action
    .mockResolvedValueOnce(state)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValueOnce(state)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishNew = resolve;
      }),
    );
  for (const x of [20, 60]) {
    fireEvent.pointerDown(viewport, {
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: 30,
    });
    fireEvent.pointerUp(viewport, { button: 0, clientX: x, clientY: 30 });
  }
  const newest = {
    ...editableTarget,
    owner: "native-document:focused-field:2",
  };
  await act(async () => finishNew({ ...state, inputTarget: newest }));
  await act(async () => finishOld({ ...state, inputTarget: editableTarget }));
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  expect(document.activeElement).toBe(proxy);
  fireEvent.input(proxy, { target: { value: "新字段" } });
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "text",
    text: "新字段",
    owner: newest.owner,
  });
});

it("keeps ASCII key semantics and releases a forwarded key once on host blur", async () => {
  const { viewport, action } = await browserPanel(undefined, editableTarget);
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  act(() => proxy.focus());
  fireEvent.keyDown(proxy, { key: "/", code: "Slash" });
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "key",
    event: "down",
    key: "/",
    code: "Slash",
    modifiers: 0,
    text: "/",
  });
  act(() =>
    screen.getByRole("textbox", { name: i18n.t("browserAddress") }).focus(),
  );
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "key",
    event: "up",
    key: "/",
    code: "Slash",
    modifiers: 0,
  });
  const count = action.mock.calls.length;
  fireEvent.keyUp(viewport, { key: "/", code: "Slash" });
  expect(action).toHaveBeenCalledTimes(count);
});

it("moves the real text host to a newly confirmed Tab target and pairs its keyup", async () => {
  const { state, action } = await browserPanel(undefined, editableTarget);
  const old = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  act(() => old.focus());
  const next = { ...editableTarget, owner: "native-document:tab-field:2" };
  action.mockResolvedValue({ ...state, inputTarget: next });
  fireEvent.keyDown(old, { key: "Tab", code: "Tab" });
  await act(async () => {});
  const current = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  expect(old.isConnected).toBe(false);
  expect(current).not.toBe(old);
  expect(document.activeElement).toBe(current);
  fireEvent.keyUp(current, { key: "Tab", code: "Tab" });
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "key",
    event: "up",
    key: "Tab",
    code: "Tab",
    modifiers: 0,
  });
});

it("uses a confirmed existing editable target when keyboard focus enters the viewport", async () => {
  const { viewport, action } = await browserPanel(undefined, editableTarget);
  act(() => viewport.focus());
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  expect(document.activeElement).toBe(proxy);
  fireEvent.input(proxy, { target: { value: "键盘进入" } });
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "text",
    text: "键盘进入",
    owner: editableTarget.owner,
  });
});

it("keeps a proxy editing key pair bound to its original owner across navigation", async () => {
  const { state, action } = await browserPanel(undefined, editableTarget);
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  act(() => proxy.focus());
  let finishDown!: (value: typeof state) => void;
  const next = {
    ...state,
    inputTarget: { ...editableTarget, owner: "new-document:field" },
  };
  action
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishDown = resolve;
      }),
    )
    .mockResolvedValue(next);
  act(() =>
    proxy.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    ),
  );
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "key",
    event: "down",
    key: "Backspace",
    code: "Backspace",
    owner: editableTarget.owner,
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("browserReload") }),
  );
  await act(async () => {});
  await act(async () => finishDown(state));
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "key",
    event: "up",
    key: "Backspace",
    code: "Backspace",
    owner: editableTarget.owner,
  });
  expect(proxy.isConnected).toBe(false);
});

it("reports rejected focus admission without retrying or erasing its feedback", async () => {
  const { action, stream } = await browserPanel(undefined, editableTarget);
  const frame = enableFrames();
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  act(() => proxy.focus());
  action.mockRejectedValueOnce(
    new WebApiError(
      "native target rejected",
      409,
      "BROWSER_INPUT_TARGET_CHANGED",
    ),
  );
  fireEvent.input(proxy, { target: { value: "待提交" } });
  await act(async () => {});
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("browserInputTargetChanged"),
  );
  await act(async () => stream.mock.calls[0]![2](frame));
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("browserInputTargetChanged"),
  );
  expect(action).toHaveBeenCalledTimes(1);
});

it.each([
  ["before", "owned text"],
  ["after", "owned text"],
  ["before", "physical key"],
  ["after", "physical key"],
] as const)(
  "keeps an owned commit failure that arrives %s a later successful %s",
  async (timing, nextInput) => {
    const { action } = await browserPanel(undefined, editableTarget);
    const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Input fixture",
    });
    act(() => proxy.focus());
    let reject!: (error: WebApiError) => void;
    action.mockReturnValueOnce(
      new Promise((_resolve, rejectAction) => {
        reject = rejectAction;
      }),
    );
    fireEvent.input(proxy, { target: { value: "A" } });
    const failure = new WebApiError(
      "native target rejected",
      409,
      "BROWSER_INPUT_TARGET_CHANGED",
    );
    if (timing === "before") {
      await act(async () => reject(failure));
      expect(screen.getByRole("alert").textContent).toBe(
        i18n.t("browserInputTargetChanged"),
      );
    }
    await act(async () => {
      if (nextInput === "owned text") {
        fireEvent.input(proxy, { target: { value: "AB" } });
      } else {
        fireEvent.keyDown(proxy, { key: "b", code: "KeyB" });
        fireEvent.keyUp(proxy, { key: "b", code: "KeyB" });
      }
    });
    if (timing === "after") await act(async () => reject(failure));
    expect(action.mock.calls.map(([, input]) => input)).toEqual([
      { type: "text", text: "A", owner: editableTarget.owner },
      ...(nextInput === "owned text"
        ? [{ type: "text", text: "B", owner: editableTarget.owner }]
        : [
            {
              type: "key",
              event: "down",
              key: "b",
              code: "KeyB",
              modifiers: 0,
              text: "b",
            },
            {
              type: "key",
              event: "up",
              key: "b",
              code: "KeyB",
              modifiers: 0,
            },
          ]),
    ]);
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("browserInputTargetChanged"),
    );
  },
);

it.each(["navigation", "blur", "hidden"] as const)(
  "ignores an owned commit failure arriving after %s changes its scope",
  async (change) => {
    const { action, rerender } = await browserPanel(undefined, editableTarget);
    const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Input fixture",
    });
    act(() => proxy.focus());
    let reject!: (error: WebApiError) => void;
    action.mockReturnValueOnce(
      new Promise((_resolve, rejectAction) => {
        reject = rejectAction;
      }),
    );
    fireEvent.input(proxy, { target: { value: "A" } });
    await act(async () => {
      if (change === "navigation") {
        fireEvent.click(
          screen.getByRole("button", { name: i18n.t("browserReload") }),
        );
      } else if (change === "blur") {
        screen.getByRole("textbox", { name: i18n.t("browserAddress") }).focus();
      } else rerender(false);
    });
    await act(async () =>
      reject(
        new WebApiError(
          "native target rejected",
          409,
          "BROWSER_INPUT_TARGET_CHANGED",
        ),
      ),
    );
    expect(action).toHaveBeenCalledTimes(change === "navigation" ? 2 : 1);
    expect(action).toHaveBeenNthCalledWith(1, "session-1", {
      type: "text",
      text: "A",
      owner: editableTarget.owner,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("keeps a rejected character visible after an ordinary wheel operation", async () => {
  const { action, viewport } = await browserPanel(undefined, editableTarget);
  enablePointer(viewport);
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  act(() => proxy.focus());
  action.mockRejectedValueOnce(
    new WebApiError(
      "native target rejected",
      409,
      "BROWSER_INPUT_TARGET_CHANGED",
    ),
  );
  await act(async () => fireEvent.input(proxy, { target: { value: "A" } }));
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("browserInputTargetChanged"),
  );
  await act(async () => {
    fireEvent.wheel(viewport, {
      clientX: 10,
      clientY: 10,
      deltaX: 0,
      deltaY: 24,
    });
  });
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "mouse",
    event: "wheel",
    x: 10,
    y: 10,
    deltaX: 0,
    deltaY: 24,
  });
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("browserInputTargetChanged"),
  );
});

it("clears a visible input failure when an explicit valid owned paste retries", async () => {
  const { action, state } = await browserPanel(undefined, editableTarget);
  const proxy = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Input fixture",
  });
  act(() => proxy.focus());
  action.mockRejectedValueOnce(
    new WebApiError(
      "native target rejected",
      409,
      "BROWSER_INPUT_TARGET_CHANGED",
    ),
  );
  await act(async () => fireEvent.input(proxy, { target: { value: "A" } }));
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("browserInputTargetChanged"),
  );
  let finish!: (value: typeof state) => void;
  action.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.paste(proxy, {
    clipboardData: { getData: () => "corrected" },
  });
  const errorDuringPaste = screen.queryByRole("alert");
  expect(action).toHaveBeenLastCalledWith("session-1", {
    type: "text",
    text: "corrected",
    owner: editableTarget.owner,
  });
  await act(async () => finish(state));
  expect(action).toHaveBeenCalledTimes(2);
  expect(errorDuringPaste).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

function enableFrames() {
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = vi.fn(() => "blob:browser-frame");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      async decode() {}
    },
  );
  return {
    data: "AA==",
    mimeType: "image/png",
    width: 800,
    height: 600,
  } satisfies WebBrowserFrame;
}

it.each(["address", "paste"] as const)(
  "does not let a healthy frame hide a rejected %s operation",
  async (kind) => {
    const frame = enableFrames();
    const { viewport, stream, action } = await browserPanel();
    const message =
      kind === "address"
        ? i18n.t("invalidBrowserAddress")
        : i18n.t("browserPasteTooLarge", {
            count: WEB_BROWSER_TEXT_MAX_LENGTH,
          });
    if (kind === "address") {
      fireEvent.change(
        screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
        { target: { value: "https://" } },
      );
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("browserGo") }),
      );
    } else {
      fireEvent.paste(viewport, {
        clipboardData: {
          getData: () => "a".repeat(WEB_BROWSER_TEXT_MAX_LENGTH + 1),
        },
      });
      expect(action).not.toHaveBeenCalled();
    }
    expect(screen.getByText(message)).toBeTruthy();
    await act(async () => stream.mock.calls[0]![2](frame));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(message);
  },
);

it.each(["before", "during"] as const)(
  "ignores a state poll started %s navigation when its old result arrives after the receipt",
  async (timing) => {
    const polls: (() => void)[] = [];
    const browserWindow: Window = window;
    const schedule = browserWindow.setTimeout.bind(browserWindow);
    vi.spyOn(browserWindow, "setTimeout").mockImplementation(
      (handler, delay, ...args) => {
        if (delay === 1_000 && typeof handler === "function") {
          polls.push(() => handler(...args));
          return schedule(() => {}, 0);
        }
        return schedule(handler, delay, ...args);
      },
    );
    const { state, read } = await browserPanel();
    let finishPoll!: (value: typeof state) => void;
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPoll = resolve;
      }),
    );
    let finishOpen!: (value: typeof state) => void;
    vi.spyOn(WebClient.prototype, "openBrowser").mockReturnValueOnce(
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
    );
    const poll = polls.shift();
    expect(poll).toBeDefined();
    if (timing === "before") await act(async () => poll?.());
    const address = screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("browserAddress"),
    });
    fireEvent.change(address, { target: { value: "localhost:43210/new" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
    if (timing === "during") await act(async () => poll?.());
    expect(finishPoll).toBeDefined();
    await act(async () =>
      finishOpen({
        ...state,
        url: "http://localhost:43210/new",
        canGoBack: false,
      }),
    );
    expect(address.value).toBe("http://localhost:43210/new");
    expect(read.mock.calls.at(-1)?.[1]?.aborted).toBe(false);
    await act(async () => finishPoll(state));
    expect(address.value).toBe("http://localhost:43210/new");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("browserBack"),
      }).disabled,
    ).toBe(true);
  },
);

it("keeps separate address and paste feedback through unrelated pointer receipts", async () => {
  const { viewport, action, state } = await browserPanel();
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
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("browserAddress"),
  });
  fireEvent.change(address, { target: { value: "https://" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
  fireEvent.paste(viewport, {
    clipboardData: {
      getData: () => "a".repeat(WEB_BROWSER_TEXT_MAX_LENGTH + 1),
    },
  });
  await act(async () => finish(state));
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  fireEvent.change(address, { target: { value: "https://example.com/new" } });
  expect(screen.queryByText(i18n.t("invalidBrowserAddress"))).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("browserPasteTooLarge", { count: WEB_BROWSER_TEXT_MAX_LENGTH }),
  );
  await act(async () =>
    fireEvent.paste(viewport, {
      clipboardData: { getData: () => "corrected" },
    }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not replace a newer opened page with an older navigation receipt", async () => {
  const { state, action } = await browserPanel();
  let finishBack!: (value: typeof state) => void;
  action.mockReturnValueOnce(
    new Promise((resolve) => {
      finishBack = resolve;
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserBack") }));
  vi.spyOn(WebClient.prototype, "openBrowser").mockResolvedValue({
    ...state,
    url: "http://localhost:43210/new",
    title: "New page",
    canGoBack: false,
  });
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("browserAddress"),
  });
  fireEvent.change(address, { target: { value: "localhost:43210/new" } });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") })),
  );
  await act(async () => finishBack(state));
  expect(address.value).toBe("http://localhost:43210/new");
  expect(screen.getByRole("application", { name: "New page" })).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("browserBack"),
    }).disabled,
  ).toBe(true);
});

it.each(["navigation", "resize", "close"] as const)(
  "ignores a delayed resize receipt after newer %s intent",
  async (intent) => {
    let notify!: () => void;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const timers: (() => void)[] = [];
    const browserWindow: Window = window;
    const schedule = browserWindow.setTimeout.bind(browserWindow);
    vi.spyOn(browserWindow, "setTimeout").mockImplementation(
      (handler, delay, ...args) => {
        if (delay === 160 && typeof handler === "function") {
          timers.push(() => handler(...args));
          return schedule(() => {}, 0);
        }
        return schedule(handler, delay, ...args);
      },
    );
    const { state, action, viewport, rerender } = await browserPanel();
    let width = 600;
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          left: 0,
          top: 0,
          width,
          height: 600,
        }) as DOMRect,
    );
    let finishResize!: (value: typeof state) => void;
    action.mockReturnValueOnce(
      new Promise((resolve) => {
        finishResize = resolve;
      }),
    );
    notify();
    await act(async () => timers.shift()?.());
    expect(action).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ type: "resize", width: 600 }),
      expect.any(AbortSignal),
    );
    let title = state.title;
    if (intent === "navigation") {
      title = "New native page";
      vi.spyOn(WebClient.prototype, "openBrowser").mockResolvedValue({
        ...state,
        url: "http://localhost:43210/new",
        title,
      });
      fireEvent.change(
        screen.getByRole("textbox", { name: i18n.t("browserAddress") }),
        {
          target: { value: "localhost:43210/new" },
        },
      );
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", { name: i18n.t("browserGo") }),
        ),
      );
    } else if (intent === "resize") {
      title = "Latest resize";
      width = 640;
      action.mockResolvedValueOnce({ ...state, width, title });
      notify();
      await act(async () => timers.shift()?.());
    } else {
      rerender(false);
      expect(action.mock.calls[0]![2]?.aborted).toBe(true);
      notify();
      expect(timers).toHaveLength(0);
    }
    await act(async () =>
      finishResize({ ...state, width: 600, title: "Old resize" }),
    );
    expect(screen.getByRole("application", { name: title })).toBeTruthy();
  },
);

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

it("keeps a newly entered address when the previous browser state arrives late", async () => {
  let restore!: () => void;
  const loading = browserPanel(
    new Promise<void>((resolve) => {
      restore = resolve;
    }),
  );
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("browserAddress"),
  });
  fireEvent.focus(address);
  fireEvent.change(address, { target: { value: "127.0.0.1:43210/new" } });
  fireEvent.blur(address);
  await act(async () => restore());
  const { state } = await loading;
  expect(address.value).toBe("127.0.0.1:43210/new");
  const open = vi
    .spyOn(WebClient.prototype, "openBrowser")
    .mockResolvedValue(state);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
  expect(open).toHaveBeenCalledWith(
    "session-1",
    "http://127.0.0.1:43210/new",
    expect.any(Object),
    expect.any(AbortSignal),
  );
  await act(async () => {});
});

it("does not restore an older address after the user already opened a new page", async () => {
  let restore!: () => void;
  const loading = browserPanel(
    new Promise<void>((resolve) => {
      restore = resolve;
    }),
  );
  vi.spyOn(WebClient.prototype, "openBrowser").mockImplementation(
    async (sessionId, url, viewport) => {
      const opened = {
        sessionId,
        url,
        ...viewport,
        title: "Input fixture",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
      vi.mocked(WebClient.prototype.browserState).mockResolvedValue(opened);
      return opened;
    },
  );
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("browserAddress"),
  });
  fireEvent.change(address, { target: { value: "localhost:43210/new" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
  await loading;
  expect(address.value).toBe("http://localhost:43210/new");
  await act(async () => restore());
  expect(address.value).toBe("http://localhost:43210/new");
});

it("ignores an older restore failure after opening and painting a new page", async () => {
  const frame = enableFrames();
  let failRestore!: (error: Error) => void;
  const loading = browserPanel(
    new Promise<void>((_resolve, reject) => {
      failRestore = reject;
    }),
  );
  vi.spyOn(WebClient.prototype, "openBrowser").mockImplementation(
    async (sessionId, url, viewport) => {
      const opened = {
        sessionId,
        url,
        ...viewport,
        title: "Input fixture",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      };
      vi.mocked(WebClient.prototype.browserState).mockResolvedValue(opened);
      return opened;
    },
  );
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("browserAddress"),
  });
  fireEvent.change(address, { target: { value: "localhost:43210/new" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
  const { stream } = await loading;
  await act(async () => stream.mock.calls[0]![2](frame));
  expect(screen.queryByRole("status")).toBeNull();
  await act(async () => failRestore(new Error("Old restore failed")));
  expect(screen.queryByRole("status")).toBeNull();
  expect(address.value).toBe("http://localhost:43210/new");
});

it.each(["open", "back", "reload"] as const)(
  "preserves a newer address draft while %s navigation finishes",
  async (navigation) => {
    const { state, action } = await browserPanel();
    let finish!: (value: typeof state) => void;
    const receipt = new Promise<typeof state>((resolve) => {
      finish = resolve;
    });
    const open = vi.spyOn(WebClient.prototype, "openBrowser");
    const address = screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("browserAddress"),
    });
    if (navigation === "open") {
      open.mockReturnValueOnce(receipt);
      fireEvent.change(address, { target: { value: "localhost:43210/first" } });
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("browserGo") }),
      );
    } else {
      action.mockReturnValueOnce(receipt);
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t(navigation === "back" ? "browserBack" : "browserReload"),
        }),
      );
    }
    fireEvent.change(address, { target: { value: "localhost:43210/second" } });
    fireEvent.blur(address);
    await act(async () =>
      finish({ ...state, url: "http://localhost:43210/first" }),
    );
    expect(address.value).toBe("localhost:43210/second");
    open.mockResolvedValue(state);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("browserGo") }));
    expect(open).toHaveBeenLastCalledWith(
      "session-1",
      "http://localhost:43210/second",
      expect.any(Object),
      expect.any(AbortSignal),
    );
    await act(async () => {});
  },
);

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
