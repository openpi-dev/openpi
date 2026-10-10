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
import { createElement, useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { WebInteractiveTerminalEvent } from "../../web/protocol/types.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { InteractiveTerminal } from "../../web/ui/src/features/workbar/InteractiveTerminal.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import {
  WorkbarReadingContext,
  type WorkbarReadingState,
} from "../../web/ui/src/features/workbar/workbar-reading-state.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

type TerminalRecord = {
  options: { disableStdin: boolean };
  textarea?: HTMLTextAreaElement;
  writes: string[];
  resets: number;
  disposed: boolean;
  send: (data: string) => void;
  buffer: { active: { baseY: number; viewportY: number } };
  scroll: (viewport: number) => void;
  scrolls: number[];
};

const terminals = vi.hoisted(() => ({ instances: [] as TerminalRecord[] }));
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
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options,
  ) {
    const modal = document.querySelector("dialog[open]");
    if (modal && !modal.contains(this)) return;
    elementFocus.call(this, options);
  });
});
afterAll(() => {
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = { disableStdin: true };
    textarea?: HTMLTextAreaElement;
    writes: string[] = [];
    resets = 0;
    disposed = false;
    send = (_data: string) => {};
    buffer = { active: { baseY: 50, viewportY: 50 } };
    scroll = (_viewport: number) => {};
    scrolls: number[] = [];
    constructor() {
      terminals.instances.push(this);
    }
    loadAddon() {}
    open(host: HTMLElement) {
      this.textarea = document.createElement("textarea");
      this.textarea.setAttribute("aria-label", "Terminal input");
      host.append(this.textarea);
    }
    attachCustomKeyEventHandler() {}
    focus() {
      const modal = document.querySelector("dialog[open]");
      if (modal && !modal.contains(this.textarea ?? null)) return;
      this.textarea?.focus();
    }
    dispose() {
      this.disposed = true;
      this.textarea?.remove();
    }
    reset() {
      this.resets++;
    }
    write(data: string, callback?: () => void) {
      this.writes.push(data);
      callback?.();
    }
    onData(callback: (data: string) => void) {
      this.send = callback;
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    onScroll(callback: (viewport: number) => void) {
      this.scroll = (viewport) => {
        this.buffer.active.viewportY = viewport;
        callback(viewport);
      };
      return { dispose() {} };
    }
    scrollToLine(viewport: number) {
      const clamped = Math.max(0, Math.min(viewport, this.buffer.active.baseY));
      this.scrolls.push(clamped);
      this.scroll(clamped);
    }
    scrollToBottom() {
      this.scrollToLine(this.buffer.active.baseY);
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
  terminals.instances.length = 0;
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function terminalInfo(sessionId = "a", id = "terminal-a", cwd = "/workspace") {
  return {
    id,
    sessionId,
    cwd,
    exited: false,
    exitCode: null,
  };
}

type StreamAttempt = {
  sessionId: string;
  id: string;
  offset: number | undefined;
  signal: AbortSignal;
  onEvent: (event: WebInteractiveTerminalEvent) => void;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

function fixture() {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const create = vi
    .spyOn(WebClient.prototype, "createInteractiveTerminal")
    .mockResolvedValue(terminalInfo());
  const read = vi
    .spyOn(WebClient.prototype, "interactiveTerminal")
    .mockResolvedValue(terminalInfo());
  const close = vi
    .spyOn(WebClient.prototype, "closeInteractiveTerminal")
    .mockResolvedValue({ closed: true });
  const write = vi
    .spyOn(WebClient.prototype, "writeInteractiveTerminal")
    .mockResolvedValue({ written: true });
  vi.spyOn(WebClient.prototype, "resizeInteractiveTerminal").mockResolvedValue({
    resized: true,
  });
  const attempts: StreamAttempt[] = [];
  const stream = vi
    .spyOn(WebClient.prototype, "streamInteractiveTerminal")
    .mockImplementation((sessionId, id, offset, signal, onEvent) => {
      const pending = deferred<void>();
      attempts.push({
        sessionId,
        id,
        offset,
        signal,
        onEvent,
        resolve: () => pending.resolve(),
        reject: pending.reject,
      });
      return pending.promise;
    });
  return { create, read, close, write, stream, attempts };
}

function tree(sessionId = "a", cwd = "/workspace") {
  return createElement(
    Providers,
    null,
    createElement(
      "div",
      null,
      createElement("input", { "aria-label": "Main prompt" }),
      createElement(InteractiveTerminal, { sessionId, cwd }),
    ),
  );
}

it("the plus keeps the current terminal visible and its menu creates an independent terminal tab", async () => {
  const client = fixture();
  client.create
    .mockResolvedValueOnce(terminalInfo())
    .mockResolvedValueOnce(terminalInfo("a", "terminal-b"));
  const reading: WorkbarReadingState = {};
  const view = render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "terminal",
        requestRevision: 0,
        sessionId: "a",
        sessionPath: "/workspace/a.jsonl",
        cwd: "/workspace",
        capabilities: {},
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onClose: () => {},
        readingState: reading,
      }),
    ),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const first = terminals.instances[0]!;
  act(() =>
    client.attempts[0]!.onEvent({
      type: "output",
      data: "server stays running",
      offset: 20,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("openTools") }));
  const launcher = await screen.findByRole("menu", {
    name: i18n.t("openTools"),
  });
  expect(within(launcher).getAllByRole("menuitem")).toHaveLength(5);
  expect(screen.getByRole("textbox", { name: "Terminal input" })).toBe(
    first.textarea,
  );
  expect(client.attempts[0]!.signal.aborted).toBe(false);
  fireEvent.click(
    within(launcher).getByRole("menuitem", {
      name: new RegExp(`^${i18n.t("workbarNewTerminal")}`),
    }),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  expect(client.create.mock.calls[0]?.[4]).toBe("terminal:0");
  expect(client.create.mock.calls[1]?.[4]).toMatch(/^terminal:[a-f0-9-]+:0$/u);
  expect(terminals.instances).toHaveLength(2);
  const second = terminals.instances[1]!;
  act(() =>
    client.attempts[1]!.onEvent({
      type: "output",
      data: "test output",
      offset: 11,
    }),
  );
  await act(async () => second.send("test\r"));
  expect(client.write).toHaveBeenLastCalledWith("a", "terminal-b", "test\r");
  await act(async () => first.send("hidden-must-not-run\r"));
  expect(client.write).toHaveBeenCalledOnce();
  const toolbar = screen.getByRole("toolbar", { name: i18n.t("openTools") });
  fireEvent.click(
    within(toolbar).getByRole("button", {
      name: i18n.t("terminal"),
    }),
  );
  await act(async () => first.send("server\r"));
  expect(client.write).toHaveBeenLastCalledWith("a", "terminal-a", "server\r");
  expect(first.writes).toEqual(["server stays running"]);
  expect(second.writes).toEqual(["test output"]);
  expect(client.create).toHaveBeenCalledTimes(2);
  expect(client.attempts.every((attempt) => !attempt.signal.aborted)).toBe(
    true,
  );
  const close = within(toolbar).getByRole("button", {
    name: i18n.t("workbarEndTerminal", { name: i18n.t("terminal") }),
  });
  await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
  close.focus();
  fireEvent.click(close);
  await waitFor(() =>
    expect(client.close).toHaveBeenCalledExactlyOnceWith("a", "terminal-a"),
  );
  await waitFor(() =>
    expect(
      view.container.querySelectorAll('[data-tool="terminal"]'),
    ).toHaveLength(1),
  );
  expect(first.disposed).toBe(true);
  expect(second.disposed).toBe(false);
  expect(client.attempts[1]!.signal.aborted).toBe(false);
  expect(client.create).toHaveBeenCalledTimes(2);
  expect(
    Object.values(reading.terminals ?? {}).map((terminal) => terminal.id),
  ).toEqual(["terminal-b"]);
});

it("renames a terminal tab and retains its title while new output changes its viewport", async () => {
  const client = fixture();
  const reading: WorkbarReadingState = {};
  render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "terminal",
        requestRevision: 0,
        sessionId: "a",
        sessionPath: "/workspace/a.jsonl",
        cwd: "/workspace",
        capabilities: {},
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onClose: () => {},
        readingState: reading,
      }),
    ),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const tab = within(screen.getByRole("toolbar")).getByRole("button", {
    name: i18n.t("terminal"),
  });
  fireEvent.doubleClick(tab);
  const dialog = await screen.findByRole("dialog", {
    name: i18n.t("renameTerminal"),
  });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: i18n.t("terminalName") }),
    { target: { value: "Dev server" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: i18n.t("save") }));
  expect(
    within(screen.getByRole("toolbar")).getByRole("button", {
      name: "Dev server",
    }),
  ).toBeTruthy();
  act(() => terminals.instances[0]!.scroll(12));
  expect(reading.terminals?.terminal).toEqual({
    id: "terminal-a",
    title: "Dev server",
    viewport: 12,
    atBottom: false,
  });
  expect(client.create).toHaveBeenCalledOnce();
});

it("failed terminal close keeps its tab and native ID available for an explicit retry", async () => {
  const client = fixture();
  client.close.mockRejectedValueOnce(new Error("Close was not confirmed"));
  render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "terminal",
        requestRevision: 0,
        sessionId: "a",
        sessionPath: "/workspace/a.jsonl",
        cwd: "/workspace",
        capabilities: {},
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onClose: () => {},
      }),
    ),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const close = within(screen.getByRole("toolbar")).getByRole("button", {
    name: i18n.t("workbarEndTerminal", { name: i18n.t("terminal") }),
  });
  await waitFor(() => expect(close.hasAttribute("disabled")).toBe(false));
  fireEvent.click(close);
  await screen.findByRole("alert");
  expect(terminals.instances[0]!.disposed).toBe(false);
  expect(client.attempts[0]!.signal.aborted).toBe(false);
  expect(client.create).toHaveBeenCalledOnce();
  fireEvent.click(close);
  await waitFor(() => expect(client.close).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: i18n.t("openTools") }),
    ).toBeTruthy(),
  );
  expect(client.close.mock.calls).toEqual([
    ["a", "terminal-a"],
    ["a", "terminal-a"],
  ]);
  expect(terminals.instances[0]!.disposed).toBe(true);
});

it("restored terminal metadata in a viewed Session cannot start, attach or close native processes", async () => {
  const client = fixture();
  const reading: WorkbarReadingState = {
    tabs: {
      tabs: ["terminal"],
      active: "terminal",
      launcherOpen: false,
      activationHistory: ["terminal"],
    },
    requestRevision: 0,
    terminals: {
      terminal: {
        id: "native-from-earlier-session",
        title: "Server",
        viewport: 12,
        atBottom: false,
      },
    },
  };
  render(
    createElement(
      Providers,
      null,
      createElement(WorkbarPanel, {
        visible: true,
        requestedTool: "terminal",
        requestRevision: 0,
        sessionId: "viewed",
        sessionPath: "/workspace/copied.jsonl",
        cwd: "/workspace",
        capabilities: {},
        canControl: false,
        review: {
          result: null,
          loading: false,
          error: null,
          refresh: async () => {},
        },
        conversationCollapsed: false,
        onRestoreConversation: () => {},
        onClose: () => {},
        readingState: reading,
      }),
    ),
  );
  expect(screen.getByText(i18n.t("toolsRequireCurrentSession"))).toBeTruthy();
  expect(terminals.instances).toHaveLength(0);
  const close = within(screen.getByRole("toolbar")).getByRole("button", {
    name: `${i18n.t("close")} Server`,
  });
  expect(close.hasAttribute("disabled")).toBe(false);
  fireEvent.click(close);
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: i18n.t("openTools") }),
    ).toBeTruthy(),
  );
  expect(client.create).not.toHaveBeenCalled();
  expect(client.read).not.toHaveBeenCalled();
  expect(client.close).not.toHaveBeenCalled();
});

it.each([12, 50])(
  "detaches a terminal stream and reattaches its identity and viewport %s without restarting it",
  async (viewport) => {
    const client = fixture();
    const reading: WorkbarReadingState = {};
    const node = () =>
      createElement(WorkbarReadingContext.Provider, { value: reading }, tree());
    const first = render(node());
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const signal = client.attempts[0]!.signal;
    expect(reading.terminal?.id).toBe("terminal-a");
    act(() => terminals.instances[0]!.scroll(viewport));
    expect(reading.terminal).toEqual({
      id: "terminal-a",
      viewport,
      atBottom: viewport === 50,
    });
    first.unmount();
    expect(signal.aborted).toBe(true);
    expect(client.close).not.toHaveBeenCalled();
    const second = render(node());
    await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.read).toHaveBeenCalledExactlyOnceWith(
      "a",
      "terminal-a",
      expect.any(AbortSignal),
    );
    const terminal = terminals.instances[1]!;
    terminal.buffer.active.baseY = 75;
    act(() =>
      client.attempts[1]!.onEvent({
        type: "output",
        reset: true,
        data: "replayed output\r\n",
        offset: 100,
      }),
    );
    expect(terminal.scrolls).toEqual([viewport === 50 ? 75 : 12]);
    act(() =>
      client.attempts[1]!.onEvent({
        type: "output",
        data: "next output\r\n",
        offset: 120,
      }),
    );
    expect(terminal.scrolls).toHaveLength(1);
    second.unmount();
    expect(client.close).not.toHaveBeenCalled();
  },
);

async function openRestart() {
  const opener = screen.getByRole("button", {
    name: i18n.t("restartTerminal"),
  });
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole("dialog", {
    name: i18n.t("restartTerminalTitle"),
  });
}

it("reconnects the existing PTY from its output offset without replacing XTerm", async () => {
  const client = fixture();
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  const textbox = terminal.textarea;
  act(() =>
    client.attempts[0]!.onEvent({
      type: "output",
      data: "before\r\n",
      offset: 71,
    }),
  );
  await act(async () => client.attempts[0]!.resolve());
  expect(terminal.options.disableStdin).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  expect(client.read).toHaveBeenCalledWith(
    "a",
    "terminal-a",
    expect.any(AbortSignal),
  );
  expect(client.create).toHaveBeenCalledOnce();
  expect(client.close).not.toHaveBeenCalled();
  expect(terminals.instances).toEqual([terminal]);
  expect(screen.getByRole("textbox", { name: "Terminal input" })).toBe(textbox);
  expect(terminal.disposed).toBe(false);
  expect(terminal.resets).toBe(0);
  expect(client.attempts[1]!.offset).toBe(71);
  act(() => {
    client.attempts[1]!.onEvent({
      type: "output",
      data: "duplicate",
      offset: 71,
    });
    client.attempts[1]!.onEvent({
      type: "output",
      data: "after\r\n",
      offset: 78,
    });
  });
  expect(terminal.writes).toEqual(["before\r\n", "after\r\n"]);
  expect(terminal.options.disableStdin).toBe(false);
});

it("keeps a failed reconnect retryable without creating or closing the existing PTY", async () => {
  const client = fixture();
  client.read.mockRejectedValueOnce(new Error("Terminal read offline"));
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  act(() =>
    client.attempts[0]!.onEvent({
      type: "output",
      data: "keep output",
      offset: 11,
    }),
  );
  await act(async () => client.attempts[0]!.resolve());
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await screen.findByText("Terminal read offline");
  expect(client.create).toHaveBeenCalledOnce();
  expect(client.close).not.toHaveBeenCalled();
  expect(terminals.instances).toEqual([terminal]);
  expect(terminal.writes).toEqual(["keep output"]);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  expect(client.read).toHaveBeenCalledTimes(2);
  expect(client.attempts[1]!.id).toBe("terminal-a");
  expect(client.attempts[1]!.offset).toBe(11);
  expect(client.create).toHaveBeenCalledOnce();
  expect(screen.queryByText("Terminal read offline")).toBeNull();
});

it("retries an initial create failure without replacing the terminal display", async () => {
  const client = fixture();
  client.create.mockRejectedValueOnce(new Error("Create receipt lost"));
  render(tree());
  await screen.findByText("Create receipt lost");
  const terminal = terminals.instances[0]!;
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  expect(client.create).toHaveBeenCalledTimes(2);
  expect(client.read).not.toHaveBeenCalled();
  expect(client.close).not.toHaveBeenCalled();
  expect(terminals.instances).toEqual([terminal]);
  expect(terminal.options.disableStdin).toBe(false);
});

it.each(["sessionId", "id", "cwd"] as const)(
  "rejects reconnect metadata with a changed %s instead of attaching another PTY",
  async (field) => {
    const client = fixture();
    client.read.mockResolvedValue({ ...terminalInfo(), [field]: "different" });
    render(tree());
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const terminal = terminals.instances[0]!;
    await act(async () => client.attempts[0]!.resolve());
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
    );
    await screen.findByText(i18n.t("inspectionChanged"));
    expect(client.stream).toHaveBeenCalledOnce();
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.close).not.toHaveBeenCalled();
    expect(terminals.instances).toEqual([terminal]);
    expect(terminal.options.disableStdin).toBe(true);
  },
);

it("ignores an old reconnect read after the terminal scope changes", async () => {
  const client = fixture();
  const read = deferred<ReturnType<typeof terminalInfo>>();
  client.read.mockReturnValue(read.promise);
  client.create
    .mockResolvedValueOnce(terminalInfo())
    .mockResolvedValueOnce(terminalInfo("b", "terminal-b", "/other-workspace"));
  const view = render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  await act(async () => client.attempts[0]!.resolve());
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  expect(client.read).toHaveBeenCalledOnce();
  view.rerender(tree("b", "/other-workspace"));
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  const main = screen.getByRole("textbox", { name: "Main prompt" });
  main.focus();
  await act(async () => read.resolve(terminalInfo()));
  expect(client.stream).toHaveBeenCalledTimes(2);
  expect(client.attempts[1]!.sessionId).toBe("b");
  expect(client.attempts[1]!.id).toBe("terminal-b");
  expect(client.attempts[1]!.signal.aborted).toBe(false);
  expect(terminals.instances[1]!.options.disableStdin).toBe(false);
  expect(document.activeElement).toBe(main);
});

it("projects a native exited PTY after reconnect without starting a replacement", async () => {
  const client = fixture();
  client.read.mockResolvedValue({
    ...terminalInfo(),
    exited: true,
    exitCode: 7,
  });
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  await act(async () => client.attempts[0]!.resolve());
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await screen.findByText(i18n.t("terminalExitCode", { code: 7 }));
  act(() => terminal.send("must-not-run\r"));
  expect(client.write).not.toHaveBeenCalled();
  expect(client.create).toHaveBeenCalledOnce();
  expect(client.close).not.toHaveBeenCalled();
  expect(terminals.instances).toEqual([terminal]);
  expect(terminal.options.disableStdin).toBe(true);
});

it("ignores late old stream output, exit and failure after reconnect succeeds", async () => {
  const client = fixture();
  const input = deferred<{ written: true }>();
  client.write.mockReturnValueOnce(input.promise);
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  act(() =>
    client.attempts[0]!.onEvent({
      type: "output",
      data: "retained",
      offset: 8,
    }),
  );
  await act(async () => terminal.send("unknown\r"));
  await act(async () => input.reject(new Error("Input outcome unknown")));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  await act(async () => {
    client.attempts[0]!.onEvent({
      type: "output",
      data: "stale output",
      offset: 99,
    });
    client.attempts[0]!.onEvent({ type: "exit", exitCode: 9 });
    client.attempts[0]!.reject(new Error("Old stream failed"));
  });
  act(() =>
    client.attempts[1]!.onEvent({
      type: "output",
      data: "current",
      offset: 15,
    }),
  );
  expect(terminal.writes).toEqual(["retained", "current"]);
  expect(terminal.options.disableStdin).toBe(false);
  expect(client.attempts[1]!.signal.aborted).toBe(false);
  expect(screen.queryByText("Old stream failed")).toBeNull();
  expect(
    screen.queryByText(i18n.t("terminalExitCode", { code: 9 })),
  ).toBeNull();
});

it.each(["resolve", "reject"] as const)(
  "does not replay queued input or let an old write %s disable a reconnected PTY",
  async (settlement) => {
    const client = fixture();
    const input = deferred<{ written: true }>();
    client.write.mockReturnValueOnce(input.promise);
    render(tree());
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const terminal = terminals.instances[0]!;
    await act(async () => terminal.send("first\r"));
    expect(client.write).toHaveBeenCalledOnce();
    act(() => terminal.send("must-not-replay\r"));
    await act(async () => client.attempts[0]!.resolve());
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
    );
    await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (settlement === "resolve") input.resolve({ written: true });
      else input.reject(new Error("Old write failed"));
    });
    expect(client.write).toHaveBeenCalledOnce();
    expect(terminal.options.disableStdin).toBe(false);
    await act(async () => terminal.send("new\r"));
    expect(client.write).toHaveBeenCalledTimes(2);
    expect(client.write.mock.calls[1]).toEqual(["a", "terminal-a", "new\r"]);
    expect(screen.queryByText("Old write failed")).toBeNull();
  },
);

it("locks duplicate reconnect and restart while read is pending without stealing later focus", async () => {
  const client = fixture();
  const read = deferred<ReturnType<typeof terminalInfo>>();
  client.read.mockReturnValue(read.promise);
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  await act(async () => client.attempts[0]!.resolve());
  const reconnect = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("reconnectTerminal"),
  });
  act(() => {
    fireEvent.click(reconnect);
    fireEvent.click(reconnect);
  });
  expect(client.read).toHaveBeenCalledOnce();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("restartTerminal"),
    }).disabled,
  ).toBe(true);
  const main = screen.getByRole("textbox", { name: "Main prompt" });
  main.focus();
  await act(async () => read.resolve(terminalInfo()));
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  expect(document.activeElement).toBe(main);
});

it.each(["cancel", "Escape"] as const)(
  "returns focus to the restart opener after %s without stopping or creating a PTY",
  async (dismissal) => {
    const client = fixture();
    render(tree());
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const terminal = terminals.instances[0]!;
    const opener = screen.getByRole("button", {
      name: i18n.t("restartTerminal"),
    });
    const dialog = await openRestart();
    expect(
      within(dialog).getByText(i18n.t("restartTerminalDetail")),
    ).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    const main = screen.getByRole("textbox", { name: "Main prompt" });
    main.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.create).toHaveBeenCalledOnce();

    if (dismissal === "cancel")
      fireEvent.click(
        within(dialog).getByRole("button", { name: i18n.t("cancel") }),
      );
    else {
      fireEvent.keyDown(dialog, { key: "Escape" });
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
    }

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(client.close).not.toHaveBeenCalled();
    expect(client.create).toHaveBeenCalledOnce();
    expect(terminals.instances).toEqual([terminal]);
  },
);

it("locks confirmation and cancel and sends one close for same-tick restart clicks", async () => {
  const client = fixture();
  const close = deferred<{ closed: true }>();
  client.close.mockReturnValue(close.promise);
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  const dialog = await openRestart();
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: i18n.t("restartTerminal"),
  });
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  expect(client.close).toHaveBeenCalledExactlyOnceWith("a", "terminal-a");
  expect(confirm.disabled).toBe(true);
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", {
      name: i18n.t("cancel"),
    }).disabled,
  ).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(
    screen.getByRole("dialog", { name: i18n.t("restartTerminalTitle") }),
  ).toBe(dialog);
  expect(client.create).toHaveBeenCalledOnce();
  expect(terminals.instances).toEqual([terminal]);
  await act(async () => close.resolve({ closed: true }));
  await waitFor(() => expect(client.create).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a pending restart modal and its workbar visible when Escape requests native cancellation", async () => {
  const client = fixture();
  const close = deferred<{ closed: true }>();
  client.close.mockReturnValue(close.promise);
  const dismissWorkbar = vi.fn();
  function Panel() {
    const [visible, setVisible] = useState(true);
    return createElement(WorkbarPanel, {
      visible,
      requestedTool: "terminal",
      requestRevision: 0,
      sessionId: "a",
      sessionPath: "/workspace/session.jsonl",
      cwd: "/workspace",
      capabilities: {},
      review: {
        result: null,
        loading: false,
        error: null,
        refresh: async () => {},
      },
      conversationCollapsed: false,
      onRestoreConversation: () => {},
      onClose: () => {
        dismissWorkbar();
        setVisible(false);
      },
    });
  }
  const view = render(createElement(Providers, null, createElement(Panel)));
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const workbar = view.container.querySelector<HTMLElement>(".workbar-panel")!;
  const dialog = await openRestart();
  const confirm = within(dialog).getByRole("button", {
    name: i18n.t("restartTerminal"),
  });
  confirm.focus();
  fireEvent.click(confirm);
  expect(client.close).toHaveBeenCalledExactlyOnceWith("a", "terminal-a");

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(dismissWorkbar).not.toHaveBeenCalled();
  expect(workbar.hidden).toBe(false);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(workbar.hidden).toBe(false);
  expect(dismissWorkbar).not.toHaveBeenCalled();
  expect(client.create).toHaveBeenCalledOnce();

  await act(async () => close.resolve({ closed: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(client.create).toHaveBeenCalledTimes(2);
  expect(workbar.hidden).toBe(false);
  expect(dismissWorkbar).not.toHaveBeenCalled();
});

it("preserves a failed close and its output in the confirmation before retrying restart", async () => {
  const client = fixture();
  const retry = deferred<{ closed: true }>();
  client.close
    .mockRejectedValueOnce(new Error("PTY close failed"))
    .mockReturnValueOnce(retry.promise);
  client.create
    .mockResolvedValueOnce(terminalInfo())
    .mockResolvedValueOnce(terminalInfo("a", "terminal-b"));
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  act(() =>
    client.attempts[0]!.onEvent({
      type: "output",
      data: "running process",
      offset: 15,
    }),
  );
  const dialog = await openRestart();
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: i18n.t("restartTerminal"),
  });
  fireEvent.click(confirm);
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "PTY close failed",
  );
  expect(confirm.disabled).toBe(false);
  expect(client.create).toHaveBeenCalledOnce();
  expect(terminals.instances).toEqual([terminal]);
  expect(terminal.writes).toEqual(["running process"]);
  expect(terminal.disposed).toBe(false);
  fireEvent.click(confirm);
  expect(client.close.mock.calls).toEqual([
    ["a", "terminal-a"],
    ["a", "terminal-a"],
  ]);
  expect(client.create).toHaveBeenCalledOnce();
  await act(async () => retry.resolve({ closed: true }));
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  expect(client.create).toHaveBeenCalledTimes(2);
  expect(client.attempts[1]!.id).toBe("terminal-b");
  expect(terminal.disposed).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("disables restart until the first native create settles", async () => {
  const client = fixture();
  const create = deferred<ReturnType<typeof terminalInfo>>();
  client.create.mockReturnValue(create.promise);
  render(tree());
  await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
  const restart = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("restartTerminal"),
  });
  expect(restart.disabled).toBe(true);
  fireEvent.click(restart);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.close).not.toHaveBeenCalled();
  await act(async () => create.resolve(terminalInfo()));
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  expect(restart.disabled).toBe(false);
});

it.each(["unmount", "scope"] as const)(
  "does not recreate or steal focus when an old close succeeds after %s changes",
  async (boundary) => {
    const client = fixture();
    const close = deferred<{ closed: true }>();
    client.close.mockReturnValue(close.promise);
    client.create
      .mockResolvedValueOnce(terminalInfo())
      .mockResolvedValueOnce(
        terminalInfo("b", "terminal-b", "/other-workspace"),
      );
    const view = render(tree());
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const dialog = await openRestart();
    fireEvent.click(
      within(dialog).getByRole("button", { name: i18n.t("restartTerminal") }),
    );
    expect(client.close).toHaveBeenCalledOnce();
    if (boundary === "unmount") view.unmount();
    else {
      view.rerender(tree("b", "/other-workspace"));
      await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
      screen.getByRole("textbox", { name: "Main prompt" }).focus();
    }
    await act(async () => close.resolve({ closed: true }));
    expect(client.create).toHaveBeenCalledTimes(boundary === "unmount" ? 1 : 2);
    if (boundary === "scope") {
      expect(client.attempts[1]!.sessionId).toBe("b");
      expect(client.attempts[1]!.id).toBe("terminal-b");
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Main prompt" }),
      );
    }
  },
);

it.each([
  ["/workspace/invoice-demo/", "invoice-demo"],
  ["C:\\Projects\\invoice-demo\\", "invoice-demo"],
  ["/", "/"],
])(
  "shows a readable native directory for %s with its full path available",
  async (cwd, name) => {
    const client = fixture();
    client.create.mockResolvedValue(terminalInfo("a", "terminal-a", cwd));
    render(tree("a", cwd));
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const header = document.querySelector(".interactive-terminal-status")!;
    const directory = within(header as HTMLElement).getByText(name, {
      exact: true,
    });
    expect(directory.getAttribute("title")).toBe(cwd);
    expect(
      within(header as HTMLElement).getByText(i18n.t("connected")),
    ).toBeTruthy();
  },
);

it("labels reconnect visibly while keeping restart on the existing confirmation path", async () => {
  const client = fixture();
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  await act(async () =>
    client.attempts[0]!.reject(new Error("temporary transport failure")),
  );
  const reconnect = screen.getByRole("button", {
    name: i18n.t("reconnectTerminal"),
  });
  expect(reconnect.textContent).toBe(i18n.t("reconnectTerminal"));
  expect(screen.queryByText(i18n.t("connected"))).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("restartTerminal") }),
  );
  await screen.findByRole("dialog", { name: i18n.t("restartTerminalTitle") });
  expect(client.close).not.toHaveBeenCalled();
  expect(client.create).toHaveBeenCalledOnce();
});

it("derives return-to-bottom from the native viewport and keeps manual reading during new output", async () => {
  const client = fixture();
  const reading: WorkbarReadingState = {};
  render(
    createElement(
      Providers,
      null,
      createElement(
        WorkbarReadingContext.Provider,
        { value: reading },
        createElement(InteractiveTerminal, {
          sessionId: "a",
          cwd: "/workspace",
        }),
      ),
    ),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  expect(
    screen.queryByRole("button", { name: i18n.t("terminalScrollToBottom") }),
  ).toBeNull();
  act(() => terminal.scroll(12));
  expect(reading.terminal).toMatchObject({
    id: "terminal-a",
    viewport: 12,
    atBottom: false,
  });
  expect(
    screen.getByRole("button", { name: i18n.t("terminalScrollToBottom") }),
  ).toBeTruthy();
  act(() => {
    terminal.buffer.active.baseY = 65;
    client.attempts[0]!.onEvent({
      type: "output",
      data: "more native output",
      offset: 18,
      reset: false,
    });
  });
  expect(terminal.buffer.active.viewportY).toBe(12);
  expect(terminal.scrolls).toEqual([]);
  expect(reading.terminal?.atBottom).toBe(false);
  const returnButton = screen.getByRole("button", {
    name: i18n.t("terminalScrollToBottom"),
  });
  returnButton.focus();
  fireEvent.click(returnButton);
  expect(terminal.scrolls).toEqual([65]);
  expect(reading.terminal).toMatchObject({
    id: "terminal-a",
    viewport: 65,
    atBottom: true,
  });
  expect(
    screen.queryByRole("button", { name: i18n.t("terminalScrollToBottom") }),
  ).toBeNull();
  expect(document.activeElement).toBe(terminal.textarea);
  expect(client.create).toHaveBeenCalledOnce();
  expect(client.read).not.toHaveBeenCalled();
  expect(client.close).not.toHaveBeenCalled();
  expect(client.write).not.toHaveBeenCalled();
});

it.each([8, 80])(
  "reflects restored native reading at %s and later native scrolling without a separate follow owner",
  async (viewport) => {
    const client = fixture();
    const reading: WorkbarReadingState = {
      terminals: {
        "terminal:notes": {
          id: "terminal-a",
          viewport,
          atBottom: false,
          title: "Notes",
        },
      },
    };
    render(
      createElement(
        Providers,
        null,
        createElement(
          WorkbarReadingContext.Provider,
          { value: reading },
          createElement(InteractiveTerminal, {
            sessionId: "a",
            cwd: "/workspace",
            tabId: "terminal:notes",
          }),
        ),
      ),
    );
    await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
    const terminal = terminals.instances[0]!;
    act(() =>
      client.attempts[0]!.onEvent({
        type: "output",
        data: "saved output",
        offset: 12,
        reset: true,
      }),
    );
    const restored = Math.min(viewport, terminal.buffer.active.baseY);
    expect(terminal.scrolls).toEqual([restored]);
    expect(
      Boolean(
        screen.queryByRole("button", {
          name: i18n.t("terminalScrollToBottom"),
        }),
      ),
    ).toBe(restored < terminal.buffer.active.baseY);
    expect(reading.terminals?.["terminal:notes"]).toMatchObject({
      viewport: restored,
      atBottom: restored >= terminal.buffer.active.baseY,
      title: "Notes",
    });
    act(() => terminal.scroll(terminal.buffer.active.baseY));
    expect(
      screen.queryByRole("button", { name: i18n.t("terminalScrollToBottom") }),
    ).toBeNull();
    expect(reading.terminals?.["terminal:notes"]?.atBottom).toBe(true);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  },
);

it("announces an authoritative replay reset after a known cursor without treating initial replay as loss", async () => {
  const client = fixture();
  render(tree());
  await waitFor(() => expect(client.stream).toHaveBeenCalledOnce());
  const terminal = terminals.instances[0]!;
  act(() =>
    client.attempts[0]!.onEvent({
      type: "output",
      data: "initial replay",
      offset: 14,
      reset: true,
    }),
  );
  expect(screen.queryByText(i18n.t("terminalOutputResynced"))).toBeNull();
  await act(async () =>
    client.attempts[0]!.reject(new Error("connection interrupted")),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("reconnectTerminal") }),
  );
  await waitFor(() => expect(client.stream).toHaveBeenCalledTimes(2));
  expect(client.attempts[1]!.offset).toBe(14);
  act(() =>
    client.attempts[1]!.onEvent({
      type: "output",
      data: "current native backlog",
      offset: 48,
      reset: true,
    }),
  );
  expect(screen.getByText(i18n.t("terminalOutputResynced"))).toBeTruthy();
  expect(terminal.resets).toBe(2);
  expect(terminal.writes).toEqual(["initial replay", "current native backlog"]);
  expect(terminals.instances).toHaveLength(1);
  expect(client.create).toHaveBeenCalledOnce();
  expect(client.close).not.toHaveBeenCalled();
  act(() => client.attempts[1]!.onEvent({ type: "exit", exitCode: 7 }));
  expect(
    screen.getByText(i18n.t("terminalExitCode", { code: 7 })),
  ).toBeTruthy();
  expect(screen.getByText(i18n.t("terminalOutputResynced"))).toBeTruthy();
});
