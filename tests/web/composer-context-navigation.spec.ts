// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type ComponentProps, createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type {
  WebCommandSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

type Props = ComponentProps<typeof Composer>;
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
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function snapshot(path = "/workspace/a.jsonl"): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-26T00:00:00Z",
    cursor: 1,
    currentSessionId: "A",
    currentSessionPath: path,
    workspaces: [{ path: "/workspace", name: "Workspace", current: true }],
    sessions: [],
    selectedSession: {
      id: "A",
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
  const store = createWebStore();
  const sendPrompt = vi.fn(async () => true);
  const commands: WebCommandSummary[] = [
    { name: "review", source: "prompt", availability: "available" },
  ];
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
    commandDiscovery: {
      sessionId: "A",
      status: "ready",
      commands,
      totalAvailable: 1,
      commandsOmitted: 0,
      error: null,
    },
    actions: { ...store.getState().actions, sendPrompt },
    ...overrides,
  };
  const node = () =>
    createElement(I18nextProvider, { i18n }, createElement(Composer, props));
  const view = render(node());
  return {
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

async function openFileReference(
  input: HTMLTextAreaElement,
  value = "README.md",
) {
  fireEvent.blur(input);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", {
        name: (label) => label.startsWith(i18n.t("addImages")),
      }),
    ),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("fileReference") }),
  );
  const reference = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("fileReferenceLabel"),
  });
  fireEvent.change(reference, { target: { value } });
  return reference;
}

function insertReference() {
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("insertReference") }),
  );
}

it("completes an available command only with an unmodified Tab", () => {
  const { input, sendPrompt } = setup();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "/rev" } });
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
  expect(input.value).toBe("/review ");
  expect(sendPrompt).not.toHaveBeenCalled();
});

it.each(["shiftKey", "ctrlKey", "altKey", "metaKey"])(
  "retains native Tab behavior with %s while command suggestions are open",
  (modifier) => {
    const { input, sendPrompt } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/rev" } });
    expect(fireEvent.keyDown(input, { key: "Tab", [modifier]: true })).toBe(
      true,
    );
    expect(input.value).toBe("/rev");
    expect(sendPrompt).not.toHaveBeenCalled();
  },
);

it("does not trap Tab when every discovered command is unavailable", () => {
  const { input, sendPrompt } = setup({
    commandDiscovery: {
      sessionId: "A",
      status: "ready",
      commands: [
        { name: "review", source: "extension", availability: "unsupported" },
      ],
      totalAvailable: 0,
      commandsOmitted: 0,
      error: null,
    },
  });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "/rev" } });
  expect(screen.getByRole("option").getAttribute("aria-disabled")).toBe("true");
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(input.value).toBe("/rev");
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("replaces the selected text instead of inserting before it", async () => {
  const { input } = setup({ workspaceDraft: true });
  fireEvent.change(input, {
    target: { value: "Inspect old-file then continue" },
  });
  input.setSelectionRange(8, 16);
  fireEvent.select(input);
  await openFileReference(input);
  insertReference();
  await waitFor(() =>
    expect(input.value).toBe("Inspect `README.md` then continue"),
  );
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.selectionStart).toBe("Inspect `README.md`".length);
  expect(input.selectionEnd).toBe(input.selectionStart);
});

it("preserves the unselected prefix and suffix around a collapsed caret", async () => {
  const { input } = setup({ workspaceDraft: true });
  fireEvent.change(input, { target: { value: "beforeafter" } });
  input.setSelectionRange(6, 6);
  fireEvent.select(input);
  await openFileReference(input);
  insertReference();
  await waitFor(() => expect(input.value).toBe("before `README.md` after"));
});

it("encodes literal percent and Unicode at the Artifact API boundary only", async () => {
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockResolvedValue({ handle: "literal-file" });
  vi.spyOn(WebClient.prototype, "artifactMetadata").mockResolvedValue({
    identity: "stable",
  });
  const release = vi
    .spyOn(WebClient.prototype, "releaseArtifact")
    .mockResolvedValue({});
  const { input } = setup();
  const path = "src/100% %20 \u6587\u6863.txt";
  await openFileReference(input, path);
  insertReference();
  await waitFor(() => expect(input.value).toBe(`\`${path}\``));
  expect(resolve.mock.calls[0]?.[1]).toBe(encodeURI(path));
  expect(decodeURIComponent(resolve.mock.calls[0]?.[1] ?? "")).toBe(path);
  expect(release).toHaveBeenCalledWith("A", "literal-file");
});

it("retains the path and reports a changed draft instead of inserting a late result", async () => {
  let finish!: (value: { handle: string }) => void;
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockImplementation(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  vi.spyOn(WebClient.prototype, "artifactMetadata").mockResolvedValue({
    identity: "stable",
  });
  vi.spyOn(WebClient.prototype, "releaseArtifact").mockResolvedValue({});
  const { input } = setup();
  fireEvent.change(input, { target: { value: "original draft" } });
  input.setSelectionRange(0, 8);
  const reference = await openFileReference(input);
  insertReference();
  fireEvent.change(input, { target: { value: "newer draft" } });
  await act(async () => finish({ handle: "old-result" }));
  expect(input.value).toBe("newer draft");
  expect(reference.value).toBe("README.md");
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("fileReferenceDraftChanged"),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("never inserts a pending reference into a copied Session with the same id", async () => {
  let finish!: (value: { handle: string }) => void;
  const resolve = vi
    .spyOn(WebClient.prototype, "resolveArtifact")
    .mockImplementation(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
  const metadata = vi
    .spyOn(WebClient.prototype, "artifactMetadata")
    .mockResolvedValue({ identity: "stable" });
  const release = vi
    .spyOn(WebClient.prototype, "releaseArtifact")
    .mockResolvedValue({});
  const { input, update } = setup();
  fireEvent.change(input, { target: { value: "owner A" } });
  await openFileReference(input);
  insertReference();
  update({ snapshot: snapshot("/workspace/copied.jsonl") });
  await act(async () => finish({ handle: "old-owner-result" }));
  expect(resolve.mock.calls[0]?.[3]?.aborted).toBe(true);
  expect(metadata).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledWith("A", "old-owner-result");
  expect(input.value).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("retains the path when the draft memory limit rejects insertion", async () => {
  const { input } = setup({ workspaceDraft: true });
  const text = "x".repeat(512 * 1024);
  fireEvent.change(input, { target: { value: text } });
  input.setSelectionRange(text.length, text.length);
  const reference = await openFileReference(input);
  insertReference();
  expect(input.value).toBe(text);
  expect(reference.value).toBe("README.md");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(
    screen.getAllByRole("alert").map((alert) => alert.textContent),
  ).toContain(i18n.t("draftLimit"));
});

it("keeps native file validation errors separate from draft insertion errors", async () => {
  vi.spyOn(WebClient.prototype, "resolveArtifact").mockRejectedValue(
    new WebApiError("missing", 404, "ARTIFACT_MISSING"),
  );
  const { input } = setup();
  const reference = await openFileReference(input, "missing.md");
  insertReference();
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      i18n.t("fileReferenceMissing"),
    ),
  );
  expect(reference.value).toBe("missing.md");
  expect(input.value).toBe("");
});
