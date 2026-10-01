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
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

type Props = ComponentProps<typeof Composer>;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const methods = new Map(
  ["showModal", "close"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
  ]),
);
const nativeFocus = HTMLElement.prototype.focus;
const nativeOpeners = new WeakMap<HTMLDialogElement, HTMLElement>();
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
      if (document.activeElement instanceof HTMLElement)
        nativeOpeners.set(this, document.activeElement);
      this.open = true;
      this.querySelector<HTMLElement>("[data-autofocus], button")?.focus();
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      const focused = document.activeElement;
      this.open = false;
      if (focused instanceof HTMLElement && this.contains(focused)) {
        focused.blur();
        nativeOpeners.get(this)?.focus();
      }
      nativeOpeners.delete(this);
    },
  });
});

afterAll(() => {
  window.scrollTo = nativeScrollTo;
  Object.defineProperty(HTMLElement.prototype, "focus", {
    configurable: true,
    value: nativeFocus,
  });
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

function snapshot(id = "A", path = "/workspace/a.jsonl"): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-26T00:00:00Z",
    cursor: 1,
    currentSessionId: id,
    currentSessionPath: path,
    workspaces: [{ path: "/workspace", name: "Workspace", current: true }],
    sessions: [],
    selectedSession: {
      id,
      path,
      cwd: "/workspace",
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

function setup(overrides: Partial<Props> = {}) {
  const sendPrompt = vi.fn(async () => false);
  let props: Props = {
    snapshot: snapshot(),
    selectedWorkspace: "/workspace",
    sessionSwitching: false,
    promptAdmissionPending: false,
    thinkingPendingLevel: null,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    actions: { ...createWebStore().getState().actions, sendPrompt },
    ...overrides,
  };
  const node = () =>
    createElement(I18nextProvider, { i18n }, createElement(Composer, props));
  const view = render(node());
  return {
    view,
    sendPrompt,
    input: screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: i18n.t("describeTask"),
    }),
    update(patch: Partial<Props>) {
      props = { ...props, ...patch };
      view.rerender(node());
    },
  };
}

function imageFile(name = "screenshot.png") {
  const bytes = Uint8Array.from(atob(png), (character) =>
    character.charCodeAt(0),
  );
  const file = new File([bytes], name, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  return file;
}

async function addImage(
  view: ReturnType<typeof render>,
  name = "screenshot.png",
) {
  await act(async () =>
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: { files: [imageFile(name)] },
    }),
  );
}

function imageTrigger(name = "screenshot.png") {
  return screen.getByRole("button", {
    name: `${i18n.t("previewAttachment")} ${name}`,
  });
}

function openPreview(name = "screenshot.png") {
  const trigger = imageTrigger(name);
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", {
    name: `${i18n.t("previewAttachment")} ${name}`,
  }) as HTMLDialogElement;
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
  );
  return { trigger, dialog };
}

it("previews an attached local image without reading files or altering the draft", async () => {
  const resolve = vi.spyOn(WebClient.prototype, "resolveArtifact");
  const download = vi.spyOn(WebClient.prototype, "downloadArtifact");
  const { view, input, sendPrompt } = setup();
  fireEvent.change(input, { target: { value: "Inspect this screenshot" } });
  await addImage(view);
  const { trigger, dialog } = openPreview();
  expect(dialog.querySelector("img")?.src).toBe(`data:image/png;base64,${png}`);
  expect(dialog.textContent).toContain("screenshot.png");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
  );
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  expect(input.value).toBe("Inspect this screenshot");
  expect(imageTrigger()).toBe(trigger);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});

it("starts fitted and permits an original-size keyboard-focusable scroll view", async () => {
  const { view } = setup();
  await addImage(view);
  const { dialog } = openPreview();
  const image = dialog.querySelector("img");
  const fit = screen.getByRole("button", { name: i18n.t("fitImage") });
  const original = screen.getByRole("button", {
    name: i18n.t("originalImageSize"),
  });
  const region = screen.getByRole("region", {
    name: i18n.t("imageViewMode"),
  });
  expect(fit.getAttribute("aria-pressed")).toBe("true");
  expect(original.getAttribute("aria-pressed")).toBe("false");
  expect(region.dataset.mode).toBe("fit");
  expect(region.hasAttribute("tabindex")).toBe(false);
  fireEvent.click(original);
  expect(fit.getAttribute("aria-pressed")).toBe("false");
  expect(original.getAttribute("aria-pressed")).toBe("true");
  expect(region.dataset.mode).toBe("original");
  expect(region.tabIndex).toBe(0);
  region.focus();
  expect(document.activeElement).toBe(region);
  expect(dialog.querySelector("img")).toBe(image);
  fireEvent.click(fit);
  expect(region.dataset.mode).toBe("fit");
  expect(region.hasAttribute("tabindex")).toBe(false);
  expect(image?.src).toBe(`data:image/png;base64,${png}`);
});

it.each(["same", "another"])(
  "returns to fit when opening the %s image after original-size viewing",
  async (which) => {
    const { view } = setup();
    await addImage(view);
    await addImage(view, "other.png");
    openPreview();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("originalImageSize") }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
    );
    openPreview(which === "same" ? "screenshot.png" : "other.png");
    expect(
      screen
        .getByRole("button", { name: i18n.t("fitImage") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("region", { name: i18n.t("imageViewMode") }).dataset
        .mode,
    ).toBe("fit");
  },
);

it("keeps decode failure and close focus intact in original-size mode", async () => {
  const { view } = setup();
  await addImage(view);
  const { trigger, dialog } = openPreview();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("originalImageSize") }),
  );
  fireEvent.error(dialog.querySelector("img")!);
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("imagePreviewFailed"),
  );
  expect(
    screen
      .getByRole("button", { name: i18n.t("originalImageSize") })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("region", { name: i18n.t("imageViewMode") })
      .hasAttribute("tabindex"),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
  );
  expect(document.activeElement).toBe(trigger);
});

it("closes original-size mode across Session paths and reopens fitted", async () => {
  const { view, update } = setup();
  await addImage(view);
  const { dialog } = openPreview();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("originalImageSize") }),
  );
  update({ snapshot: snapshot("A", "/workspace/copy.jsonl") });
  expect(dialog.open).toBe(false);
  update({ snapshot: snapshot() });
  openPreview();
  expect(
    screen
      .getByRole("button", { name: i18n.t("fitImage") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it.each(["files", "items"])(
  "previews an image pasted through clipboard %s",
  async (source) => {
    const { input } = setup();
    const file = imageFile("pasted.png");
    await act(async () =>
      fireEvent.paste(input, {
        clipboardData: {
          files: source === "files" ? [file] : [],
          items:
            source === "items" ? [{ kind: "file", getAsFile: () => file }] : [],
          getData: () => "",
        },
      }),
    );
    expect(openPreview("pasted.png").dialog.querySelector("img")?.src).toBe(
      `data:image/png;base64,${png}`,
    );
  },
);

it.each(["escape", "cancel", "backdrop"])(
  "closes with %s and restores its image trigger",
  async (reason) => {
    const { view } = setup();
    await addImage(view);
    const { trigger, dialog } = openPreview();
    if (reason === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
    else if (reason === "cancel")
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
    else fireEvent.click(dialog);
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  },
);

it("keeps images inspectable after a rejected send", async () => {
  const { view, sendPrompt } = setup();
  await addImage(view);
  await act(async () =>
    fireEvent.submit(view.container.querySelector("form")!),
  );
  expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("", [
    expect.objectContaining({ mimeType: "image/png", data: png }),
  ]);
  expect(openPreview().dialog.querySelector("img")?.src).toContain(png);
});

it("closes when an in-flight send consumes the previewed image", async () => {
  let settle!: (accepted: boolean) => void;
  const sendPrompt = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
  );
  const { view } = setup({
    actions: { ...createWebStore().getState().actions, sendPrompt },
  });
  await addImage(view);
  fireEvent.submit(view.container.querySelector("form")!);
  const { dialog } = openPreview();
  await act(async () => settle(true));
  expect(dialog.open).toBe(false);
  expect(
    screen.queryByRole("button", {
      name: `${i18n.t("previewAttachment")} screenshot.png`,
    }),
  ).toBeNull();
  expect(document.activeElement).toBe(document.body);
});

it("closes when the previewed image is removed without changing other attachments", async () => {
  const { view } = setup();
  await addImage(view);
  await addImage(view, "other.png");
  const { dialog } = openPreview();
  fireEvent.click(
    screen.getByRole("button", {
      name: `${i18n.t("removeAttachment")} screenshot.png`,
    }),
  );
  expect(dialog.open).toBe(false);
  expect(imageTrigger("other.png")).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
});

it("keeps the selected image distinct from an attachment with the same filename", async () => {
  const { view } = setup();
  await addImage(view);
  await addImage(view);
  const triggers = screen.getAllByRole("button", {
    name: `${i18n.t("previewAttachment")} screenshot.png`,
  });
  triggers[1]!.focus();
  fireEvent.click(triggers[1]!);
  const dialog = screen.getByRole("dialog", {
    name: `${i18n.t("previewAttachment")} screenshot.png`,
  }) as HTMLDialogElement;
  fireEvent.click(
    screen.getAllByRole("button", {
      name: `${i18n.t("removeAttachment")} screenshot.png`,
    })[0]!,
  );
  expect(dialog.open).toBe(true);
  expect(imageTrigger()).toBe(triggers[1]);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
  );
  expect(document.activeElement).toBe(triggers[1]);
});

it("closes across exact Session paths and leaves the original draft available on return", async () => {
  const { view, update } = setup();
  await addImage(view);
  const { dialog } = openPreview();
  update({ snapshot: snapshot("A", "/workspace/copy.jsonl") });
  expect(dialog.open).toBe(false);
  expect(
    screen.queryByRole("button", {
      name: `${i18n.t("previewAttachment")} screenshot.png`,
    }),
  ).toBeNull();
  update({ snapshot: snapshot() });
  expect(imageTrigger()).toBeTruthy();
  expect(dialog.open).toBe(false);
});

it("does not return focus across a workspace-to-Session handoff that retains the same thumbnail", async () => {
  const { view, update } = setup({ workspaceDraft: true });
  await addImage(view);
  const { trigger, dialog } = openPreview();
  update({
    workspaceDraft: false,
    createdSession: {
      epoch: 1,
      sessionId: "A",
      sessionPath: "/workspace/a.jsonl",
      workspacePath: "/workspace",
    },
  });
  expect(dialog.open).toBe(false);
  expect(imageTrigger()).toBe(trigger);
  expect(document.activeElement).toBe(document.body);
});

it("does not restore the old trigger when closing and handing off a draft in the same render", async () => {
  const { view, update } = setup({ workspaceDraft: true });
  await addImage(view);
  const { trigger, dialog } = openPreview();
  act(() => {
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
    );
    update({
      workspaceDraft: false,
      createdSession: {
        epoch: 1,
        sessionId: "A",
        sessionPath: "/workspace/a.jsonl",
        workspacePath: "/workspace",
      },
    });
  });
  expect(dialog.open).toBe(false);
  expect(imageTrigger()).toBe(trigger);
  expect(document.activeElement).toBe(document.body);
});

it("does not steal a new focus when a late close follows native dismissal", async () => {
  const { view } = setup();
  await addImage(view);
  const { dialog } = openPreview();
  const close = screen.getByRole("button", {
    name: i18n.t("closeImagePreview"),
  });
  dialog.close();
  const input = screen.getByRole("textbox", { name: i18n.t("describeTask") });
  input.focus();
  fireEvent.click(close);
  expect(document.activeElement).toBe(input);
});

it("reports decode failure and permits closing without losing the attachment", async () => {
  const { view } = setup();
  await addImage(view);
  const { trigger, dialog } = openPreview();
  fireEvent.error(dialog.querySelector("img")!);
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("imagePreviewFailed"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("closeImagePreview") }),
  );
  expect(document.activeElement).toBe(trigger);
  expect(imageTrigger()).toBeTruthy();
});
