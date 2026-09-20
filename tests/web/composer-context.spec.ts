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
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { FileReferenceDialog } from "../../web/ui/src/features/composer/FileReferenceDialog.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { compactSummary } from "../../web/ui/src/lib/format.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import {
  createWebStore,
  type WebStoreState,
} from "../../web/ui/src/store/web-store.ts";

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function snapshot(
  id = "session-1",
  path = "/tmp/workspace/one.jsonl",
): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-18T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: id,
    workspaces: [{ path: "/tmp/workspace", name: "Workspace", current: true }],
    sessions: [
      {
        id,
        path,
        cwd: "/tmp/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        name: id === "session-1" ? "First task" : "Second task",
        modified: "2026-09-18T00:00:00Z",
        created: "2026-09-18T00:00:00Z",
        messageCount: 0,
        firstMessage: "",
      },
    ],
    selectedSession: {
      id,
      path,
      cwd: "/tmp/workspace",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2 * 1024 * 1024,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
    },
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const store = createWebStore();
  const sendPrompt = vi.fn(async (_content: string) => true);
  const discoverCommands = vi.fn(async () => {});
  const props = {
    workspaceDraft: false,
    createdSession: null as WebStoreState["createdSession"],
    snapshot: snapshot(),
    selectedPath: "/tmp/workspace/one.jsonl",
    selectedWorkspace: "/tmp/workspace",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPrompt, discoverCommands },
    ...overrides,
  };
  const node = (next = props) =>
    createElement(I18nextProvider, { i18n }, createElement(Composer, next));
  const view = render(node());
  return { ...view, node, props, sendPrompt, discoverCommands };
}

it("shows the snapshot target and unified context actions", async () => {
  const { discoverCommands, sendPrompt } = setup();
  expect(screen.getByText("First task")).toBeTruthy();
  expect(screen.getByText("Workspace")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  expect(screen.getByRole("menuitem", { name: /^Add images/u })).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: /Reference workspace file/u }),
  ).toBeTruthy();
  expect(
    screen.getByRole("menuitem", { name: i18n.t("commands") }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("commands") }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.value).toBe("/");
  expect(input.selectionStart).toBe(1);
  expect(discoverCommands).toHaveBeenCalledOnce();
  expect(sendPrompt).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(document.activeElement).toBe(input);
});

it("bounds a prompt-derived target while retaining the complete identity", () => {
  const longTitle =
    "Inspect every workspace interaction and explain all retained evidence without losing the current draft";
  const data = snapshot();
  data.sessions[0] = {
    ...data.sessions[0]!,
    name: undefined,
    firstMessage: longTitle,
  };
  setup({ snapshot: data });

  expect(screen.getByText(compactSummary(longTitle, 48))).toBeTruthy();
  expect(screen.getByTitle(`Workspace / ${longTitle}`)).toBeTruthy();
  expect(screen.queryByText(longTitle)).toBeNull();
});

it("keeps a nonempty draft and its exact text-only prompt contract", async () => {
  const { sendPrompt } = setup();
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "  Review this\ncarefully  " } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  expect(
    screen
      .getByRole("menuitem", { name: /Slash commands/u })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  input.focus();
  fireEvent(
    input,
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    }),
  );
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(sendPrompt).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).toHaveBeenCalledWith("  Review this\ncarefully  ");
  await waitFor(() => expect(input.value).toBe(""));
});

it("validates and inserts a workspace file reference at the caret", async () => {
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockResolvedValue({ handle: "artifact-1" });
  const metadata = vi
    .spyOn(WebClient.prototype, "artifactMetadata")
    .mockResolvedValue({ identity: "stable" });
  const release = vi
    .spyOn(WebClient.prototype, "releaseArtifact")
    .mockResolvedValue({});
  setup();
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.change(input, { target: { value: "Review carefully" } });
  input.setSelectionRange(7, 7);
  fireEvent.select(input);

  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: /Reference workspace file/u }),
  );
  const reference = "web/ui/src/app/App.tsx";
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("fileReferenceLabel") }),
    { target: { value: reference } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("insertReference") }),
  );

  await waitFor(() =>
    expect(input.value).toBe("Review `web/ui/src/app/App.tsx` carefully"),
  );
  expect(resolve).toHaveBeenCalledWith(
    "session-1",
    reference,
    undefined,
    expect.any(AbortSignal),
  );
  expect(metadata).toHaveBeenCalledWith(
    "session-1",
    "artifact-1",
    expect.any(AbortSignal),
  );
  await waitFor(() =>
    expect(release).toHaveBeenCalledWith("session-1", "artifact-1"),
  );
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(`Review \`${reference}\``.length);
});

it("keeps a failed active-session reference editable", async () => {
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockRejectedValue(
    new WebApiError("Host message", 403, "ARTIFACT_DENIED"),
  );
  setup();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: /Reference workspace file/u }),
  );
  const reference = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("fileReferenceLabel"),
  });
  fireEvent.change(reference, { target: { value: "missing.ts" } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("insertReference") }),
  );

  expect((await screen.findByRole("alert")).textContent).toContain(
    i18n.t("fileReferenceDenied"),
  );
  expect(reference.value).toBe("missing.ts");
  expect(
    screen.getByRole("dialog", { name: i18n.t("fileReferenceTitle") }),
  ).toBeTruthy();
});

it("allows cancelling a file reference while validation is pending", async () => {
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockImplementation(() => new Promise(() => {}));
  setup();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: /Reference workspace file/u }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("fileReferenceLabel") }),
    { target: { value: "README.md" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("insertReference") }),
  );
  const cancel = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("cancel"),
  });
  expect(cancel.disabled).toBe(false);
  fireEvent.click(cancel);
  expect(resolve.mock.calls[0]?.[3]?.aborted).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["session-change", "unmount"])(
  "never inserts a pending file reference after %s",
  async (boundary) => {
    let finish!: (value: { handle: string }) => void;
    const resolve = vi
      .spyOn(WebClient.prototype, "resolveArtifact")
      .mockImplementation(
        () =>
          new Promise((done) => {
            finish = done;
          }),
      );
    vi.spyOn(WebClient.prototype, "artifactMetadata").mockResolvedValue({
      identity: "stable",
    });
    const release = vi
      .spyOn(WebClient.prototype, "releaseArtifact")
      .mockResolvedValue({});
    const onInsert = vi.fn();
    const node = (sessionId: string) =>
      createElement(
        I18nextProvider,
        { i18n },
        createElement(FileReferenceDialog, {
          open: true,
          sessionId,
          onClose: vi.fn(),
          onInsert,
        }),
      );
    const view = render(node("a"));
    fireEvent.change(
      screen.getByRole("textbox", { name: i18n.t("fileReferenceLabel") }),
      { target: { value: "README.md" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("insertReference") }),
    );
    if (boundary === "unmount") view.unmount();
    else view.rerender(node("b"));
    const cancelled = resolve.mock.calls[0]?.[3]?.aborted;
    await act(async () => finish({ handle: "old-handle" }));
    expect(cancelled).toBe(true);
    expect(onInsert).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("a", "old-handle");
  },
);

it("can add a visible file path to the first message of a new session", async () => {
  const resolve = vi.spyOn(WebClient.prototype, "resolveArtifact");
  setup({ workspaceDraft: true });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  // Astryx commits menu focus on the next animation frame.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: /^Add images/u }),
    ),
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: /Reference workspace file/u }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("fileReferenceLabel") }),
    { target: { value: "README.md" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("insertReference") }),
  );

  await waitFor(() => expect(input.value).toBe("`README.md`"));
  expect(resolve).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(input));
});

it("does not submit with Enter while a model choice is unconfirmed", () => {
  const { sendPrompt } = setup({ modelSelectionPending: true });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "keep me" } });
  expect(screen.getByText(i18n.t("thinkingModelPendingHint"))).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(input.value).toBe("keep me");
});

it("retains the first draft when opening a control prepares an empty Session", () => {
  const empty = snapshot();
  delete empty.selectedSession;
  delete empty.currentSessionId;
  const { props, node, rerender, sendPrompt } = setup({
    workspaceDraft: true,
    snapshot: empty,
  });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "do not lose my first draft" } });
  rerender(node({ ...props, sessionSwitching: true }));
  rerender(
    node({
      ...props,
      workspaceDraft: false,
      snapshot: snapshot(),
      createdSession: {
        epoch: 1,
        sessionId: "session-1",
        sessionPath: "/tmp/workspace/one.jsonl",
        workspacePath: "/tmp/workspace",
      },
    }),
  );
  expect(input.value).toBe("do not lose my first draft");
  expect(sendPrompt).not.toHaveBeenCalled();
});

function pendingImage(name = "delayed.png") {
  const file = new File(["pending"], name, { type: "image/png" });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
  let finish!: (bytes: ArrayBuffer) => void;
  const reading = new Promise<ArrayBuffer>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(file, "arrayBuffer", { value: () => reading });
  return { file, finish: () => finish(bytes) };
}

it("waits for an in-progress attachment before either send gesture", async () => {
  const { container, sendPrompt } = setup();
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "Inspect the attached image" } });
  const image = pendingImage();
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [image.file] },
  });
  const send = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("send"),
  });
  expect(send.disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).not.toHaveBeenCalled();
  await act(async () => image.finish());
  expect(send.disabled).toBe(false);
  fireEvent.click(send);
  expect(sendPrompt).toHaveBeenCalledWith("Inspect the attached image", [
    expect.objectContaining({ mimeType: "image/png", name: "delayed.png" }),
  ]);
});

it("discards an attachment that finishes reading after switching sessions", async () => {
  const { container, node, props, rerender } = setup();
  const image = pendingImage();
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [image.file] },
  });
  rerender(
    node({
      ...props,
      snapshot: snapshot("session-2", "/tmp/workspace/two.jsonl"),
      selectedPath: "/tmp/workspace/two.jsonl",
    }),
  );
  await act(async () => image.finish());
  expect(screen.queryByText("delayed.png")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("send") })
      .disabled,
  ).toBe(true);
});

it("does not let an old import settle a newer import after returning to the same session", async () => {
  const { container, node, props, rerender } = setup();
  const old = pendingImage("old.png");
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [old.file] },
  });
  rerender(
    node({
      ...props,
      snapshot: snapshot("session-2", "/tmp/workspace/two.jsonl"),
      selectedPath: "/tmp/workspace/two.jsonl",
    }),
  );
  rerender(node(props));
  const current = pendingImage("current.png");
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [current.file] },
  });
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "new draft" },
  });
  await act(async () => old.finish());
  expect(screen.queryByText("old.png")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("send") })
      .disabled,
  ).toBe(true);
  await act(async () => current.finish());
  expect(screen.getByText("current.png")).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("send") })
      .disabled,
  ).toBe(false);
});

it("does not transfer a settled submission into a different session", async () => {
  let resolve!: (accepted: boolean) => void;
  const receipt = new Promise<boolean>((done) => {
    resolve = done;
  });
  const sendPrompt = vi.fn(() => receipt);
  const { node, props, rerender } = setup({
    actions: { ...createWebStore().getState().actions, sendPrompt },
  });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "old draft" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendPrompt).toHaveBeenCalledWith("old draft");

  rerender(
    node({
      ...props,
      snapshot: snapshot("session-2", "/tmp/workspace/two.jsonl"),
      selectedPath: "/tmp/workspace/two.jsonl",
    }),
  );
  expect(screen.getByText("Second task")).toBeTruthy();
  fireEvent.change(input, { target: { value: "new draft" } });
  await act(async () => {
    resolve(true);
    await receipt;
  });
  expect(input.value).toBe("new draft");
});
