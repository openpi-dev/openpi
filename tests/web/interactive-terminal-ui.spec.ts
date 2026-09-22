// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { InteractiveTerminal } from "../../web/ui/src/features/workbar/InteractiveTerminal.tsx";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

const input = vi.hoisted(() => ({ send: (_data: string) => {} }));
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
    attachCustomKeyEventHandler() {}
    focus() {
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

it.each([false, true])(
  "a delayed restart respects the current focus owner (moved: %s)",
  async (moved) => {
    const create = vi
      .spyOn(WebClient.prototype, "createInteractiveTerminal")
      .mockResolvedValue({
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
    const main = screen.getByRole("textbox", { name: "Main prompt" });
    if (moved) main.focus();
    await act(async () => closed({ closed: true }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
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
