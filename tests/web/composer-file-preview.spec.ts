// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import * as draftStorage from "../../web/ui/src/features/composer/composer-draft-storage.ts";
import { DraftFilePreview } from "../../web/ui/src/features/composer/DraftFilePreview.tsx";
import type { StagedPromptFile } from "../../web/ui/src/features/composer/file-attachments.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import {
  createWebStore,
  type WebStoreActions,
} from "../../web/ui/src/store/web-store.ts";

const methods = new Map(
  ["showModal", "close"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  ]),
);
const nativeFocus = HTMLElement.prototype.focus;
const nativeScrollTo = window.scrollTo;
beforeAll(() => {
  window.scrollTo = () => undefined;
  Object.defineProperty(HTMLElement.prototype, "focus", {
    configurable: true,
    value(this: HTMLElement, options?: FocusOptions) {
      const modal = document.querySelector("dialog[open]");
      if (modal && !modal.contains(this)) return;
      nativeFocus.call(this, options);
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
      this.tabIndex = -1;
      this.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      const focused = document.activeElement;
      this.open = false;
      if (focused instanceof HTMLElement && this.contains(focused))
        focused.blur();
    },
  });
});
afterAll(() => {
  window.scrollTo = nativeScrollTo;
  HTMLElement.prototype.focus = nativeFocus;
  for (const [name, descriptor] of methods) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function file(id = "file-a", name = "notes.txt"): StagedPromptFile {
  return {
    id,
    name,
    size: 4,
    mimeType: "text/plain",
    data: "dGVzdA==",
    text: `Preview ${id}`,
    extraction: "text",
  };
}
const owner = JSON.stringify(["session", "A", "/workspace/a.jsonl"]);
function setup(files: StagedPromptFile[] = [file()]) {
  let props = { ownerKey: owner, files, onRemove: vi.fn() };
  const node = () =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "New focus" }),
        createElement(DraftFilePreview, props),
      ),
    );
  const view = render(node());
  return {
    ...view,
    onRemove: props.onRemove,
    update(patch: Partial<typeof props>) {
      props = { ...props, ...patch };
      view.rerender(node());
    },
  };
}
function open(index = 0) {
  const trigger = screen.getAllByRole("button", {
    name: `${i18n.t("previewFileAttachment")} notes.txt`,
  })[index]!;
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog") as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(dialog);
  return { trigger, dialog };
}
function cancel(dialog: HTMLDialogElement) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

it.each(["cancel", "escape", "backdrop"])(
  "closes with %s and returns focus to the same owner's file chip",
  (gesture) => {
    const view = setup();
    const { trigger, dialog } = open();
    expect(dialog.textContent).toContain("Preview file-a");
    if (gesture === "cancel") cancel(dialog);
    else if (gesture === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
    else fireEvent.click(dialog);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(view.onRemove).not.toHaveBeenCalled();
  },
);

it("invalidates a preview across exact owner paths without returning focus or reopening on return", () => {
  const view = setup();
  const { trigger, dialog } = open();
  view.update({
    ownerKey: JSON.stringify(["session", "A", "/workspace/copy.jsonl"]),
  });
  expect(dialog.open).toBe(false);
  expect(trigger.isConnected).toBe(true);
  expect(document.activeElement).toBe(document.body);
  view.update({ ownerKey: owner });
  expect(dialog.open).toBe(false);
});

it("invalidates a removed file without consuming another attachment or reopening a restored item", () => {
  const first = file();
  const second = file("file-b", "other.txt");
  const view = setup([first, second]);
  const { dialog } = open();
  view.update({ files: [second] });
  expect(dialog.open).toBe(false);
  expect(screen.getByText("other.txt")).toBeTruthy();
  expect(view.onRemove).not.toHaveBeenCalled();
  view.update({ files: [first, second] });
  expect(dialog.open).toBe(false);
});

it("keeps duplicate filenames distinct by attachment ID and returns to the selected chip", () => {
  setup([file(), file("file-b")]);
  const { trigger, dialog } = open(1);
  expect(dialog.textContent).toContain("Preview file-b");
  expect(dialog.textContent).not.toContain("Preview file-a");
  cancel(dialog);
  expect(document.activeElement).toBe(trigger);
});

it("does not steal a newer focus after native dismissal", () => {
  setup();
  const { dialog } = open();
  dialog.close();
  const input = screen.getByRole("textbox", { name: "New focus" });
  input.focus();
  cancel(dialog);
  expect(document.activeElement).toBe(input);
});

it("does not return the old trigger when dismissal and ownership handoff share one render", () => {
  const view = setup();
  const { trigger, dialog } = open();
  act(() => {
    cancel(dialog);
    view.update({
      ownerKey: JSON.stringify([
        "session",
        "created",
        "/workspace/created.jsonl",
      ]),
    });
  });
  expect(dialog.open).toBe(false);
  expect(trigger.isConnected).toBe(true);
  expect(document.activeElement).toBe(document.body);
});

function snapshot(id = "A", path = "/workspace/a.jsonl"): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-10-01T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: id,
    currentSessionPath: path,
    workspaces: [{ path: "/workspace", name: "Workspace", current: true }],
    sessions: [
      {
        id,
        path,
        cwd: "/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        name: id,
        modified: "",
        created: "",
        messageCount: 0,
        firstMessage: "",
      },
    ],
    selectedSession: {
      id,
      path,
      cwd: "/workspace",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 1,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 1,
      bytes: 0,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
    },
  };
}

it("keeps file preview focus within its owner when a pending first send completes native creation", async () => {
  vi.spyOn(draftStorage, "createBrowserComposerDraftStorage").mockReturnValue({
    async read() {
      return [
        {
          key: JSON.stringify(["workspace", "/workspace"]),
          draft: {
            prompt: "Inspect the file",
            images: [],
            files: [file()],
            caret: 0,
            revision: 0,
          },
        },
      ];
    },
    write: async () => undefined,
  });
  type Target = Awaited<ReturnType<WebStoreActions["prepareSession"]>>;
  let finish!: (value: Target) => void;
  const preparing = new Promise<Target>((resolve) => {
    finish = resolve;
  });
  const prepareSession = vi.fn(() => preparing);
  vi.spyOn(WebClient.prototype, "uploadPromptFiles").mockRejectedValue(
    new Error("Synthetic upload failure; keep unsent draft"),
  );
  const sendPrompt = vi.fn(async () => false);
  let props: ComponentProps<typeof Composer> = {
    snapshot: snapshot(),
    selectedPath: "/workspace/a.jsonl",
    selectedWorkspace: "/workspace",
    workspaceDraft: true,
    createdSession: null,
    sessionSwitching: false,
    promptAdmissionPending: false,
    thinkingPendingLevel: null,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    actions: {
      ...createWebStore().getState().actions,
      sendPrompt,
      prepareSession,
    },
  };
  const node = () =>
    createElement(I18nextProvider, { i18n }, createElement(Composer, props));
  const view = render(node());
  await act(async () => undefined);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  expect(prepareSession).toHaveBeenCalledOnce();
  const { trigger, dialog } = open();
  props = {
    ...props,
    workspaceDraft: false,
    selectedPath: "/workspace/created.jsonl",
    snapshot: snapshot("created", "/workspace/created.jsonl"),
    createdSession: {
      epoch: 1,
      sessionId: "created",
      sessionPath: "/workspace/created.jsonl",
      workspacePath: "/workspace",
    },
  };
  view.rerender(node());
  expect(dialog.open).toBe(false);
  expect(
    screen.getByRole("button", {
      name: `${i18n.t("previewFileAttachment")} notes.txt`,
    }),
  ).toBe(trigger);
  expect(document.activeElement).toBe(document.body);
  await act(async () =>
    finish({
      epoch: 1,
      sessionId: "created",
      sessionPath: "/workspace/created.jsonl",
      workspacePath: "/workspace",
    }),
  );
  expect(screen.getByText("notes.txt")).toBeTruthy();
  expect(sendPrompt).not.toHaveBeenCalled();
});
