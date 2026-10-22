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
import { afterEach, expect, it, vi } from "vitest";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

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
    focus() {
      this.textarea?.focus();
    }
    dispose() {
      this.textarea?.remove();
    }
    attachCustomKeyEventHandler() {}
    onData() {
      return { dispose() {} };
    }
    onScroll() {
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
  vi.doUnmock("../../web/ui/src/features/workbar/InteractiveTerminal.tsx");
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(savedId?: string) {
  vi.resetModules();
  const load = deferred();
  const loadModule = vi.fn(async (importOriginal: () => Promise<unknown>) => {
    await load.promise;
    return importOriginal();
  });
  vi.doMock(
    "../../web/ui/src/features/workbar/InteractiveTerminal.tsx",
    loadModule,
  );
  const { WorkbarPanel } = await import(
    "../../web/ui/src/features/workbar/WorkbarPanel.tsx"
  );
  // resetModules gives the dynamically imported terminal its own client module.
  const { WebClient: Client } = await import(
    "../../web/ui/src/protocol/client.ts"
  );
  const create = vi
    .spyOn(Client.prototype, "createInteractiveTerminal")
    .mockResolvedValue({
      id: "terminal-a",
      sessionId: "a",
      cwd: "/workspace",
      exited: false,
      exitCode: null,
    });
  vi.spyOn(Client.prototype, "resizeInteractiveTerminal").mockResolvedValue({
    resized: true,
  });
  vi.spyOn(Client.prototype, "streamInteractiveTerminal").mockImplementation(
    (_session, _id, _offset, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const close = vi
    .spyOn(Client.prototype, "closeInteractiveTerminal")
    .mockResolvedValue({ closed: true });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const props = {
    visible: true,
    requestedTool: "terminal" as const,
    requestRevision: 0,
    sessionId: "a",
    cwd: "/workspace",
    sessionPath: "/workspace/session.jsonl",
    capabilities: {},
    readingState: savedId
      ? {
          terminals: { terminal: { id: savedId, viewport: 0, atBottom: true } },
        }
      : undefined,
    review: {
      result: null,
      loading: false,
      error: null,
      refresh: async () => {},
    },
    conversationCollapsed: false,
    onRestoreConversation: () => {},
    onClose: () => {},
  };
  const tree = (visible = true) =>
    createElement(
      Providers,
      null,
      createElement("textarea", { "aria-label": "Chat input" }),
      createElement(WorkbarPanel, { ...props, visible }),
    );
  const view = render(tree());
  await waitFor(() => expect(loadModule).toHaveBeenCalledOnce());
  return { load, loadModule, create, close, tree, view };
}

it.each([false, true])(
  "delayed terminal code preserves focus intent (moved to chat: %s)",
  async (moved) => {
    const { load, create } = await fixture();
    expect(screen.getByText(i18n.t("terminalConnecting"))).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    const chat = screen.getByRole("textbox", { name: "Chat input" });
    if (moved) chat.focus();
    await act(async () => load.resolve());
    const input = await screen.findByRole("textbox", {
      name: "Terminal input",
    });
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(document.activeElement).toBe(moved ? chat : input);
  },
);

it("does not start a terminal after its loading panel unmounts", async () => {
  const { load, create, view } = await fixture();
  view.unmount();
  await act(async () => load.resolve());
  expect(create).not.toHaveBeenCalled();
});

it("keeps a failed code load closeable and offers explicit page refresh", async () => {
  const { load, create } = await fixture();
  const closeButton = screen.getByRole("button", {
    name: i18n.t("workbarEndTerminal", { name: i18n.t("terminal") }),
  });
  expect(closeButton.hasAttribute("disabled")).toBe(true);
  await act(async () => load.reject(new Error("Module unavailable")));
  expect(await screen.findByText(i18n.t("terminalLoadError"))).toBeTruthy();
  expect(closeButton.hasAttribute("disabled")).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: i18n.t("reloadPage") }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: i18n.t("reconnectTerminal") }),
  ).toBeNull();
});

it("can end a restored terminal when its code fails to load", async () => {
  const { load, create, close } = await fixture("restored-terminal");
  await act(async () => load.reject(new Error("Module unavailable")));
  const closeButton = screen.getByRole("button", {
    name: i18n.t("workbarEndTerminal", { name: i18n.t("terminal") }),
  });
  await waitFor(() => expect(closeButton.hasAttribute("disabled")).toBe(false));
  fireEvent.click(closeButton);
  await waitFor(() =>
    expect(close).toHaveBeenCalledWith("a", "restored-terminal"),
  );
  expect(create).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByText(i18n.t("terminalLoadError"))).toBeNull(),
  );
});
