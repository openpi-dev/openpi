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
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { createComposerDraftMemory } from "../../web/ui/src/features/composer/composer-drafts.ts";
import type { StagedPromptImage } from "../../web/ui/src/features/composer/image-attachments.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
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

function snapshot(id = "A", path = "/workspace/a.jsonl"): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-26T00:00:00Z",
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

function setup(overrides: Partial<Props> = {}) {
  const store = createWebStore();
  const sendPrompt = vi.fn(async () => true);
  const sendPromptAsNew = vi.fn(async () => false);
  const acknowledge = vi.fn();
  let props: Props = {
    snapshot: snapshot(),
    selectedPath: "/workspace/a.jsonl",
    selectedWorkspace: "/workspace",
    workspaceDraft: false,
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
      ...store.getState().actions,
      sendPrompt,
      sendPromptAsNew,
      acknowledgePromptAdmissionResolution: acknowledge,
    },
    ...overrides,
  };
  const node = () =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Reader control"),
        createElement(Composer, props),
      ),
    );
  const view = render(node());
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  return {
    input,
    sendPrompt,
    sendPromptAsNew,
    acknowledge,
    update(patch: Partial<Props>) {
      props = { ...props, ...patch };
      view.rerender(node());
    },
    select(id: string, path = `/workspace/${id.toLowerCase()}.jsonl`) {
      props = {
        ...props,
        snapshot: snapshot(id, path),
        selectedPath: path,
        workspaceDraft: false,
        createdSession: null,
        sessionSwitching: false,
      };
      view.rerender(node());
    },
  };
}

function image(name = "draft.png") {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
  const file = new File([bytes], name, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => bytes,
  });
  return file;
}

async function paste(file = image()) {
  await act(async () =>
    fireEvent.paste(
      screen.getByRole("textbox", { name: i18n.t("describeTask") }),
      { clipboardData: { files: [file], getData: () => "" } },
    ),
  );
  await screen.findByText(file.name);
}

function recovery() {
  return {
    sessionId: "A",
    sessionPath: "/workspace/a.jsonl",
    content: "original",
    commandId: "unknown-command",
    optimisticKey: "unknown-key",
    phase: "ready" as const,
    images: [
      {
        name: "original.png",
        mimeType: "image/png" as const,
        data: "iVBORw0KGgo=",
      },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("restores Session text, settled images and caret without taking reader focus", async () => {
  const view = setup();
  fireEvent.change(view.input, {
    target: { value: "alpha", selectionStart: 2 },
  });
  await paste();
  const reader = screen.getByRole("button", { name: "Reader control" });
  reader.focus();
  view.select("B");
  expect(view.input.value).toBe("");
  expect(screen.queryByText("draft.png")).toBeNull();
  fireEvent.change(view.input, { target: { value: "bravo" } });
  view.select("A");
  expect(view.input.value).toBe("alpha");
  expect(screen.getByText("draft.png")).toBeTruthy();
  expect(view.input.selectionStart).toBe(2);
  expect(document.activeElement).toBe(reader);
  view.select("B");
  expect(view.input.value).toBe("bravo");
});

it("freezes the canonical owner while a requested selection is pending or fails", async () => {
  const view = setup();
  fireEvent.change(view.input, { target: { value: "alpha" } });
  await paste();
  view.update({ selectedPath: "/workspace/b.jsonl", sessionSwitching: true });
  expect(view.input.value).toBe("alpha");
  expect(view.input.disabled).toBe(true);
  expect(screen.getByText("draft.png")).toBeTruthy();
  view.update({ selectedPath: "/workspace/a.jsonl", sessionSwitching: false });
  expect(view.input.value).toBe("alpha");
  expect(view.input.disabled).toBe(false);
  expect(screen.getByText("draft.png")).toBeTruthy();
});

it("keeps copied same-ID Session files in different draft buckets", async () => {
  const view = setup();
  fireEvent.change(view.input, { target: { value: "original file" } });
  await paste();
  view.select("A", "/workspace/copy.jsonl");
  expect(view.input.value).toBe("");
  expect(screen.queryByText("draft.png")).toBeNull();
  fireEvent.change(view.input, { target: { value: "copied file" } });
  view.select("A");
  expect(view.input.value).toBe("original file");
  expect(screen.getByText("draft.png")).toBeTruthy();
  view.select("A", "/workspace/copy.jsonl");
  expect(view.input.value).toBe("copied file");
});

it.each(["other", "missing"])(
  "uses confirmed native identity when its cwd has a %s workspace registration",
  (registration) => {
    const view = setup();
    fireEvent.change(view.input, { target: { value: "A draft" } });
    const other = snapshot("B", "/unregistered/b.jsonl");
    other.selectedSession!.cwd = "/unregistered";
    other.sessions[0]!.cwd = "/unregistered";
    other.workspaces = [{ path: "/other", name: "Other", current: true }];
    view.update({
      snapshot: other,
      selectedPath: "/unregistered/b.jsonl",
      selectedWorkspace: registration === "other" ? "/other" : null,
    });
    expect(view.input.value).toBe("");
    const observer: WebSnapshot = {
      ...other,
      currentSessionId: "A",
      currentSessionPath: "/workspace/a.jsonl",
      sessions: [
        { ...other.sessions[0]!, controller: "none", readOnly: false },
        snapshot().sessions[0]!,
      ],
    };
    view.update({ snapshot: observer });
    expect(view.input.value).toBe("");
    expect(view.input.disabled || view.input.readOnly).toBe(true);
    view.update({ selectedWorkspace: "/workspace" });
    view.select("A");
    expect(view.input.value).toBe("A draft");
  },
);

it("retains a draft across control loss and return without enabling submission", async () => {
  const view = setup();
  fireEvent.change(view.input, { target: { value: "alpha" } });
  await paste();
  const observer = snapshot();
  observer.currentSessionId = "B";
  observer.currentSessionPath = "/workspace/b.jsonl";
  observer.sessions[0]!.controller = "none";
  observer.sessions.push(snapshot("B", "/workspace/b.jsonl").sessions[0]!);
  view.update({ snapshot: observer });
  expect(view.input.disabled).toBe(true);
  expect(view.input.value).toBe("alpha");
  expect(screen.getByText("draft.png")).toBeTruthy();
  fireEvent.keyDown(view.input, { key: "Enter" });
  expect(view.sendPrompt).not.toHaveBeenCalled();
  view.update({ snapshot: snapshot() });
  expect(view.input.disabled).toBe(false);
  expect(view.input.value).toBe("alpha");
});

it.each([true, false])(
  "settles an old Session send (%s) only against its captured draft",
  async (accepted) => {
    const receipt = deferred<boolean>();
    const sendPrompt = vi.fn(() => receipt.promise);
    const view = setup({
      actions: { ...createWebStore().getState().actions, sendPrompt },
    });
    fireEvent.change(view.input, { target: { value: "alpha" } });
    await paste();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
    view.select("B");
    fireEvent.change(view.input, { target: { value: "bravo" } });
    await act(async () => receipt.resolve(accepted));
    expect(view.input.value).toBe("bravo");
    view.select("A");
    expect(view.input.value).toBe(accepted ? "" : "alpha");
    expect(Boolean(screen.queryByText("draft.png"))).toBe(!accepted);
  },
);

it("does not let an old pending send suppress a different Session draft", async () => {
  const receipt = deferred<boolean>();
  const sendPrompt = vi
    .fn()
    .mockReturnValueOnce(receipt.promise)
    .mockResolvedValue(true);
  const view = setup({
    actions: { ...createWebStore().getState().actions, sendPrompt },
  });
  fireEvent.change(view.input, { target: { value: "alpha" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  view.select("B");
  fireEvent.change(view.input, { target: { value: "bravo" } });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("send") })),
  );
  expect(sendPrompt.mock.calls.map((args) => args[0])).toEqual([
    "alpha",
    "bravo",
  ]);
  expect(view.input.value).toBe("");
  await act(async () => receipt.resolve(false));
  view.select("A");
  expect(view.input.value).toBe("alpha");
});

it("preserves attachment edits when the captured send is accepted", async () => {
  const receipt = deferred<boolean>();
  const view = setup({
    actions: {
      ...createWebStore().getState().actions,
      sendPrompt: () => receipt.promise,
    },
  });
  fireEvent.change(view.input, { target: { value: "alpha" } });
  await paste(image("original.png"));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  fireEvent.click(screen.getByRole("button", { name: /^Remove attachment/u }));
  await paste(image("edited.png"));
  await act(async () => receipt.resolve(true));
  expect(view.input.value).toBe("alpha");
  expect(screen.getByText("edited.png")).toBeTruthy();
});

it.each([true, false])(
  "keeps a pending import bound to the canonical owner until confirmation (%s)",
  async (finishBeforeConfirmation) => {
    const view = setup();
    fireEvent.change(view.input, { target: { value: "alpha" } });
    const read = deferred<ArrayBuffer>();
    const file = image("pending.png");
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: () => read.promise,
    });
    fireEvent.paste(view.input, {
      clipboardData: { files: [file], getData: () => "" },
    });
    view.update({ selectedPath: "/workspace/b.jsonl", sessionSwitching: true });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;
    if (finishBeforeConfirmation) await act(async () => read.resolve(bytes));
    view.select("B");
    if (!finishBeforeConfirmation) await act(async () => read.resolve(bytes));
    expect(view.input.value).toBe("");
    expect(screen.queryByText("pending.png")).toBeNull();
    view.select("A");
    expect(view.input.value).toBe("alpha");
    expect(Boolean(screen.queryByText("pending.png"))).toBe(
      finishBeforeConfirmation,
    );
  },
);

it("copies explicit new-session intent without moving A or leaking into an existing B", async () => {
  const view = setup();
  fireEvent.change(view.input, { target: { value: "alpha" } });
  await paste();
  view.update({
    workspaceDraft: true,
    selectedPath: null,
    sessionSwitching: true,
  });
  expect(view.input.value).toBe("alpha");
  expect(screen.getByText("draft.png")).toBeTruthy();
  fireEvent.change(view.input, { target: { value: "new workspace draft" } });
  view.select("B");
  expect(view.input.value).toBe("");
  expect(screen.queryByText("draft.png")).toBeNull();
  view.select("A");
  expect(view.input.value).toBe("alpha");
  view.update({
    workspaceDraft: true,
    selectedPath: null,
    sessionSwitching: true,
  });
  expect(view.input.value).toBe("new workspace draft");
  const path = "/workspace/created.jsonl";
  view.update({
    workspaceDraft: false,
    selectedPath: path,
    snapshot: snapshot("created", path),
    sessionSwitching: false,
    createdSession: {
      epoch: 1,
      sessionId: "created",
      sessionPath: path,
      workspacePath: "/workspace",
    },
  });
  expect(view.input.value).toBe("new workspace draft");
  expect(screen.getByText("draft.png")).toBeTruthy();
  fireEvent.change(view.input, { target: { value: "created Session edit" } });
  expect(view.input.value).toBe("created Session edit");
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("send") })),
  );
  expect(view.sendPrompt).toHaveBeenCalledWith("created Session edit", [
    expect.objectContaining({ name: "draft.png" }),
  ]);
  expect(view.input.value).toBe("");
  view.select("A");
  expect(view.input.value).toBe("alpha");
  expect(screen.getByText("draft.png")).toBeTruthy();
});

it.each(["missing", "id", "path", "workspace"])(
  "does not hand a workspace draft to a Session with a %s creation receipt",
  async (mismatch) => {
    const view = setup({ workspaceDraft: true });
    fireEvent.change(view.input, { target: { value: "new draft" } });
    await paste();
    const path = "/workspace/created.jsonl";
    view.update({
      workspaceDraft: false,
      selectedPath: path,
      snapshot: snapshot("created", path),
      createdSession:
        mismatch === "missing"
          ? null
          : {
              epoch: 1,
              sessionId: mismatch === "id" ? "other" : "created",
              sessionPath: mismatch === "path" ? "/workspace/copy.jsonl" : path,
              workspacePath: mismatch === "workspace" ? "/other" : "/workspace",
            },
    });
    expect(view.input.value).toBe("");
    expect(screen.queryByText("draft.png")).toBeNull();
    view.update({
      workspaceDraft: true,
      selectedPath: null,
      createdSession: null,
    });
    expect(view.input.value).toBe("new draft");
    expect(screen.getByText("draft.png")).toBeTruthy();
  },
);

it("does not overwrite an independent nonempty workspace draft with A", () => {
  const view = setup({ workspaceDraft: true });
  fireEvent.change(view.input, { target: { value: "workspace original" } });
  view.select("A");
  fireEvent.change(view.input, { target: { value: "A original" } });
  view.update({
    workspaceDraft: true,
    selectedPath: null,
    sessionSwitching: true,
  });
  expect(view.input.value).toBe("workspace original");
  view.select("A");
  expect(view.input.value).toBe("A original");
});

it("clears the first submitted revision after an exact creation handoff", async () => {
  const receipt = deferred<boolean>();
  const view = setup({
    workspaceDraft: true,
    actions: {
      ...createWebStore().getState().actions,
      sendPrompt: () => receipt.promise,
    },
  });
  fireEvent.change(view.input, { target: { value: "new draft" } });
  await paste();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  const path = "/workspace/created.jsonl";
  view.update({
    workspaceDraft: false,
    snapshot: snapshot("created", path),
    selectedPath: path,
    createdSession: {
      epoch: 1,
      sessionId: "created",
      sessionPath: path,
      workspacePath: "/workspace",
    },
  });
  expect(view.input.value).toBe("new draft");
  await act(async () => receipt.resolve(true));
  expect(view.input.value).toBe("");
  expect(screen.queryByText("draft.png")).toBeNull();
});

it("restores visible recovery images and sends explicit [] after removing all of them", async () => {
  const view = setup({ promptAdmissionRecovery: recovery() });
  expect(view.input.value).toBe("original");
  expect(screen.getByText("original.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Remove attachment/u }));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: i18n.t("sendAsNew") })),
  );
  expect(view.sendPromptAsNew).toHaveBeenCalledExactlyOnceWith("original", []);
});

it("preserves new attachments when late evidence admits the original recovery revision", async () => {
  const original = recovery();
  const view = setup({ promptAdmissionRecovery: original });
  fireEvent.click(screen.getByRole("button", { name: /^Remove attachment/u }));
  await paste(image("new-unsent.png"));
  view.update({
    promptAdmissionRecovery: null,
    promptAdmissionResolution: {
      sessionId: original.sessionId,
      sessionPath: original.sessionPath,
      commandId: original.commandId,
      content: original.content,
      images: original.images,
    },
  });
  expect(view.input.value).toBe("original");
  expect(screen.getByText("new-unsent.png")).toBeTruthy();
  expect(view.acknowledge).toHaveBeenCalledExactlyOnceWith(original.commandId);
});

it("clears untouched recovery only for its exact native Session identity", () => {
  const original = recovery();
  const view = setup({ promptAdmissionRecovery: original });
  view.update({
    promptAdmissionRecovery: null,
    promptAdmissionResolution: {
      ...original,
      sessionPath: "/workspace/copy.jsonl",
    },
  });
  expect(view.input.value).toBe("original");
  expect(screen.getByText("original.png")).toBeTruthy();
});

it("clears an untouched recovery revision when native acceptance arrives", () => {
  const original = recovery();
  const view = setup({ promptAdmissionRecovery: original });
  view.update({
    promptAdmissionRecovery: null,
    promptAdmissionResolution: original,
  });
  expect(view.input.value).toBe("");
  expect(screen.queryByText("original.png")).toBeNull();
});

it("keeps the unknown-admission draft when navigation cancels recovery", () => {
  const view = setup({ promptAdmissionRecovery: recovery() });
  view.update({ promptAdmissionRecovery: null });
  view.select("B");
  view.select("A");
  expect(view.input.value).toBe("original");
  expect(screen.getByText("original.png")).toBeTruthy();
});

it("restores a new native recovery command into an empty owner after other drafts were edited", () => {
  const view = setup();
  fireEvent.change(view.input, { target: { value: "A draft" } });
  view.select("B");
  const original = {
    ...recovery(),
    sessionId: "B",
    sessionPath: "/workspace/b.jsonl",
    commandId: "B-command",
    images: [],
  };
  view.update({ promptAdmissionRecovery: original });
  expect(view.input.value).toBe("original");
  fireEvent.change(view.input, { target: { value: "" } });
  view.update({ promptAdmissionRecovery: { ...original, phase: "checking" } });
  expect(view.input.value).toBe("");
  view.update({ promptAdmissionRecovery: null });
  view.select("A");
  view.select("B");
  view.update({ promptAdmissionRecovery: { ...original, phase: "ready" } });
  expect(view.input.value).toBe("");
  view.update({
    promptAdmissionRecovery: {
      ...original,
      commandId: "next-command",
      content: "next draft",
    },
  });
  expect(view.input.value).toBe("next draft");
});

it("rejects a 33rd nonempty draft without dropping stored content and allows freeing space", () => {
  const view = setup();
  for (let index = 0; index < 32; index++) {
    view.select(`S${index}`);
    fireEvent.change(view.input, { target: { value: `draft ${index}` } });
  }
  view.select("extra");
  fireEvent.change(view.input, { target: { value: "rejected" } });
  expect(view.input.value).toBe("");
  expect(screen.getByRole("alert").textContent).toBe(i18n.t("draftLimit"));
  view.select("S0");
  expect(view.input.value).toBe("draft 0");
  fireEvent.change(view.input, { target: { value: "" } });
  view.select("extra");
  fireEvent.change(view.input, { target: { value: "accepted" } });
  expect(view.input.value).toBe("accepted");
});

it("bounds text storage without overwriting the active draft", () => {
  const memory = createComposerDraftMemory();
  const original = memory.edit("A", memory.read("A"), {
    prompt: "a".repeat(512 * 1024),
  })!;
  expect(
    memory.edit("A", original, { prompt: `${original.prompt}b` }),
  ).toBeNull();
  expect(memory.read("A")).toBe(original);
  expect(memory.edit("B", memory.read("B"), { prompt: "b" })).toBeNull();
  const reduced = memory.edit("A", original, { prompt: "a" })!;
  expect(reduced.prompt).toBe("a");
  expect(memory.edit("B", memory.read("B"), { prompt: "b" })?.prompt).toBe("b");
});

it("bounds image bytes across owners and never replaces a destination during handoff", () => {
  const memory = createComposerDraftMemory();
  const picture: StagedPromptImage = {
    id: "image",
    name: "image.png",
    size: 8 * 1024 * 1024,
    mimeType: "image/png",
    data: "",
    previewUrl: "",
  };
  for (let index = 0; index < 4; index++)
    expect(
      memory.edit(`S${index}`, memory.read(`S${index}`), { images: [picture] }),
    ).not.toBeNull();
  expect(
    memory.edit("extra", memory.read("extra"), { images: [picture] }),
  ).toBeNull();
  const source = memory.read("S0");
  const destination = memory.read("S1");
  expect(memory.move("S0", "S1")).toBe(false);
  expect(memory.read("S0")).toBe(source);
  expect(memory.read("S1")).toBe(destination);
  expect(memory.edit("S0", source, { images: [] })).not.toBeNull();
  expect(
    memory.edit("extra", memory.read("extra"), { images: [picture] }),
  ).not.toBeNull();
});

it("treats caret changes as position, but retyping payload creates a new revision", () => {
  const memory = createComposerDraftMemory();
  const original = memory.edit("A", memory.read("A"), {
    prompt: "alpha",
    caret: 5,
  })!;
  const positioned = memory.edit("A", original, { caret: 2 })!;
  expect(positioned.revision).toBe(original.revision);
  const edited = memory.edit("A", positioned, { prompt: "bravo" })!;
  const retyped = memory.edit("A", edited, { prompt: "alpha" })!;
  expect(retyped.revision).toBeGreaterThan(original.revision);
  expect(memory.clear("A", original.revision)).toBeNull();
  expect(memory.read("A")).toBe(retyped);
});
