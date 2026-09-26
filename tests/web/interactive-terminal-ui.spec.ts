// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { InteractiveTerminal } from "../../web/ui/src/features/workbar/InteractiveTerminal.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

const input = vi.hoisted(() => ({ send: (_data: string) => {} }));
const elementFocus = HTMLElement.prototype.focus;
const dialogMethods = new Map(
  ["showModal", "close"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  ]),
);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
      this.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && this.contains(focused))
        focused.blur();
    },
  });
});
afterAll(() => {
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options,
  ) {
    const modal = document.querySelector("dialog[open]");
    if (modal && !modal.contains(this)) return;
    elementFocus.call(this, options);
  });
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { disableStdin: true };
    textarea?: HTMLTextAreaElement;
    loadAddon() {}
    open(host: HTMLElement) {
      this.textarea = document.createElement("textarea");
      this.textarea.setAttribute("aria-label", "Terminal input");
      host.append(this.textarea);
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.textarea?.addEventListener("keydown", (event) => {
        if (
          handler(event) &&
          !this.options.disableStdin &&
          event.key === "Escape"
        )
          input.send("\x1b");
      });
    }
    focus() {
      const modal = document.querySelector("dialog[open]");
      if (modal && !modal.contains(this.textarea ?? null)) return;
      this.textarea?.focus();
    }
    dispose() {
      this.textarea?.remove();
    }
    reset() {}
    write() {}
    onData(callback: (data: string) => void) {
      input.send = callback;
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps Escape in the terminal input while respecting child-consumed and header Escape", async () => {
  const create = vi
    .spyOn(WebClient.prototype, "createInteractiveTerminal")
    .mockResolvedValue({
      id: "terminal-a",
      sessionId: "a",
      cwd: "/workspace",
      exited: false,
      exitCode: null,
    });
  vi.spyOn(WebClient.prototype, "resizeInteractiveTerminal").mockResolvedValue({
    resized: true,
  });
  vi.spyOn(WebClient.prototype, "streamInteractiveTerminal").mockImplementation(
    (_session, _id, _offset, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const write = vi
    .spyOn(WebClient.prototype, "writeInteractiveTerminal")
    .mockResolvedValue({ written: true });
  const stop = vi.spyOn(WebClient.prototype, "closeInteractiveTerminal");
  const close = vi.fn();
  const view = render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "terminal",
        requestRevision: 0,
        sessionId: "a",
        cwd: "/workspace",
        capabilities: {},
        messages: [],
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onBeforeArtifactOpen: () => {},
        onClose: close,
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.queryByText(i18n.t("terminalConnecting"))).toBeNull(),
  );
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(write).toHaveBeenCalledWith("a", "terminal-a", "\x1b"),
  );
  expect(close).not.toHaveBeenCalled();
  const opener = screen.getByRole("button", {
    name: i18n.t("restartTerminal"),
  });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", {
    name: i18n.t("restartTerminalTitle"),
  });
  const cancel = within(dialog).getByRole("button", { name: i18n.t("cancel") });
  cancel.focus();
  fireEvent.keyDown(cancel, { key: "Escape" });
  expect(close).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
  expect(create).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();

  const tab = screen.getByRole("button", {
    name: i18n.t("terminal"),
  });
  const consumed = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  consumed.preventDefault();
  fireEvent(tab, consumed);
  fireEvent.keyDown(tab, { key: "Escape", isComposing: true });
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(tab, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(stop).not.toHaveBeenCalled();
});

it.each([false, true])(
  "a delayed restart respects the current focus owner (moved: %s)",
  async (moved) => {
    let ready!: (value: {
      id: string;
      sessionId: string;
      cwd: string;
      exited: boolean;
      exitCode: number | null;
    }) => void;
    const create = vi
      .spyOn(WebClient.prototype, "createInteractiveTerminal")
      .mockResolvedValueOnce({
        id: "terminal-a",
        sessionId: "a",
        cwd: "/workspace",
        exited: false,
        exitCode: null,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            ready = resolve;
          }),
      );
    vi.spyOn(
      WebClient.prototype,
      "resizeInteractiveTerminal",
    ).mockResolvedValue({ resized: true });
    vi.spyOn(
      WebClient.prototype,
      "streamInteractiveTerminal",
    ).mockImplementation(
      (_session, _id, _offset, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    let closed!: (value: { closed: true }) => void;
    vi.spyOn(
      WebClient.prototype,
      "closeInteractiveTerminal",
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          closed = resolve;
        }),
    );
    render(
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "Main prompt" }),
        createElement(InteractiveTerminal, {
          sessionId: "a",
          cwd: "/workspace",
        }),
      ),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const restart = screen.getByRole("button", {
      name: i18n.t("restartTerminal"),
    });
    restart.focus();
    fireEvent.click(restart);
    const dialog = await screen.findByRole("dialog", {
      name: i18n.t("restartTerminalTitle"),
    });
    const confirm = within(dialog).getByRole("button", {
      name: i18n.t("restartTerminal"),
    });
    confirm.focus();
    fireEvent.click(confirm);
    const main = screen.getByRole("textbox", { name: "Main prompt" });
    main.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => closed({ closed: true }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    if (moved) main.focus();
    await act(async () =>
      ready({
        id: "terminal-b",
        sessionId: "a",
        cwd: "/workspace",
        exited: false,
        exitCode: null,
      }),
    );
    expect(document.activeElement).toBe(
      moved ? main : screen.getByRole("textbox", { name: "Terminal input" }),
    );
  },
);

it.each([false, true])(
  "delayed terminal readiness respects a later focus choice (moved: %s)",
  async (moved) => {
    let finish!: (value: {
      id: string;
      sessionId: string;
      cwd: string;
      exited: boolean;
      exitCode: number | null;
    }) => void;
    const create = vi
      .spyOn(WebClient.prototype, "createInteractiveTerminal")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.spyOn(
      WebClient.prototype,
      "resizeInteractiveTerminal",
    ).mockResolvedValue({ resized: true });
    const stream = vi
      .spyOn(WebClient.prototype, "streamInteractiveTerminal")
      .mockImplementation(
        (_session, _id, _offset, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      );
    render(
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "Main prompt" }),
        createElement(InteractiveTerminal, {
          sessionId: "a",
          cwd: "/workspace",
        }),
      ),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const expected = screen.getByRole("textbox", {
      name: moved ? "Main prompt" : "Terminal input",
    });
    if (moved) expected.focus();
    await act(async () =>
      finish({
        id: "terminal-a",
        sessionId: "a",
        cwd: "/workspace",
        exited: false,
        exitCode: null,
      }),
    );
    await waitFor(() => expect(stream).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(expected);
  },
);

it.each(["failure", "unmount", "disconnect"])(
  "drops unsent terminal input after %s",
  async (boundary) => {
    vi.spyOn(
      WebClient.prototype,
      "createInteractiveTerminal",
    ).mockResolvedValue({
      id: "terminal-a",
      sessionId: "a",
      cwd: "/workspace",
      exited: false,
      exitCode: null,
    });
    vi.spyOn(
      WebClient.prototype,
      "resizeInteractiveTerminal",
    ).mockResolvedValue({ resized: true });
    let disconnect!: () => void;
    vi.spyOn(
      WebClient.prototype,
      "streamInteractiveTerminal",
    ).mockImplementation(
      (_session, _id, _offset, signal) =>
        new Promise<void>((resolve) => {
          disconnect = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    let finish!: (value: { written: true }) => void;
    let fail!: (reason: Error) => void;
    const first = new Promise<{ written: true }>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const write = vi
      .spyOn(WebClient.prototype, "writeInteractiveTerminal")
      .mockReturnValueOnce(first)
      .mockResolvedValue({ written: true });
    const view = render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(InteractiveTerminal, {
          sessionId: "a",
          cwd: "/workspace",
        }),
      ),
    );
    await waitFor(() =>
      expect(
        WebClient.prototype.streamInteractiveTerminal,
      ).toHaveBeenCalledOnce(),
    );
    await act(async () => input.send("first\r"));
    expect(write).toHaveBeenCalledOnce();
    act(() => input.send("must-not-execute\r"));
    if (boundary === "unmount") view.unmount();
    if (boundary === "disconnect") await act(async () => disconnect());
    await act(async () => {
      if (boundary === "failure") fail(new Error("write outcome unknown"));
      else finish({ written: true });
    });
    expect(write).toHaveBeenCalledTimes(1);
  },
);
