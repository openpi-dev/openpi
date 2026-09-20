// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
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
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    focus() {}
    dispose() {}
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
