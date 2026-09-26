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
  WebModelSearchResult,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { ModelPicker } from "../../web/ui/src/features/composer/ModelPicker.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

type Props = ComponentProps<typeof ModelPicker>;
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-26T00:00:00Z",
    cursor: 1,
    currentSessionId: "A",
    currentSessionPath: "/workspace/a.jsonl",
    workspaces: [],
    sessions: [
      {
        id: "A",
        path: "/workspace/a.jsonl",
        cwd: "/workspace",
        name: "A",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        created: "",
        modified: "",
        messageCount: 0,
        firstMessage: "",
      },
    ],
    selectedSession: {
      id: "A",
      path: "/workspace/a.jsonl",
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
    models: [
      {
        provider: "alpha",
        id: "zen",
        name: "Zen",
        label: "Zen",
        current: true,
      },
      {
        provider: "beta",
        id: "river",
        name: "River",
        label: "River",
        current: false,
      },
      {
        provider: "beta",
        id: "kite/model",
        name: "Kite",
        label: "Kite",
        current: false,
      },
    ],
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
  const searchModels = vi.fn(async (_query: string) => {});
  const selectModel = vi.fn(async (_value: string) => {});
  const clearModelSearch = vi.fn();
  const initial = snapshot();
  let props: Props = {
    snapshot: initial,
    currentModel: initial.models[0],
    modelSearch: store.getState().modelSearch,
    modelSelectionPending: false,
    promptAdmissionPending: false,
    sessionSwitching: false,
    liveRunning: false,
    workspaceDraft: false,
    actions: {
      ...store.getState().actions,
      searchModels,
      selectModel,
      clearModelSearch,
    },
    ...overrides,
  };
  const view = (next: Props) =>
    createElement(I18nextProvider, { i18n }, createElement(ModelPicker, next));
  const rendered = render(view(props));
  return {
    searchModels,
    selectModel,
    clearModelSearch,
    update(patch: Partial<Props>) {
      props = { ...props, ...patch };
      rendered.rerender(view(props));
    },
    async open() {
      fireEvent.click(screen.getByRole("button", { name: "Zen (alpha/zen)" }));
      const input = screen.getByRole("textbox", {
        name: i18n.t("searchModels"),
      });
      await waitFor(() => expect(document.activeElement).toBe(input));
      return input;
    },
  };
}

it("filters complete catalogs locally by provider, name and slash-bearing id", async () => {
  const ui = setup();
  const input = await ui.open();
  fireEvent.change(input, { target: { value: "BETA" } });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(input, { target: { value: "kite/model" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.click(
    screen.getByRole("option", { name: "Kite (beta/kite/model)" }),
  );
  expect(ui.selectModel).toHaveBeenCalledWith("beta/kite/model");
  expect(ui.searchModels).not.toHaveBeenCalled();
});

it("reports an empty local search and restores all options when cleared", async () => {
  const ui = setup();
  const input = await ui.open();
  fireEvent.change(input, { target: { value: "missing" } });
  expect(screen.getByText(i18n.t("noMatchingModels"))).toBeTruthy();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

it("moves between search and options and consumes only the picker Escape", async () => {
  const ui = setup();
  const input = await ui.open();
  const options = screen.getAllByRole("option");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.activeElement).toBe(options[0]);
  fireEvent.keyDown(options[0]!, { key: "End" });
  expect(document.activeElement).toBe(options[2]);
  fireEvent.keyDown(options[2]!, { key: "Home" });
  expect(document.activeElement).toBe(options[0]);
  fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(input);
  const outerEscape = vi.fn();
  document.addEventListener("keydown", outerEscape);
  try {
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outerEscape).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  } finally {
    document.removeEventListener("keydown", outerEscape);
  }
});

it("does not navigate or close while the search input is composing", async () => {
  const ui = setup();
  const input = await ui.open();
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
  expect(screen.getByRole("listbox")).toBeTruthy();
});

it("disables a copied native id at another path", () => {
  const copy = snapshot();
  copy.selectedSession = {
    ...copy.selectedSession!,
    path: "/workspace/copy.jsonl",
  };
  setup({ snapshot: copy });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Zen (alpha/zen)" })
      .disabled,
  ).toBe(true);
});

it("closes an open picker when its exact input authority is revoked", async () => {
  const ui = setup();
  await ui.open();
  const copy = snapshot();
  copy.currentSessionPath = "/workspace/copy.jsonl";
  ui.update({ snapshot: copy });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(ui.clearModelSearch).toHaveBeenCalled();
});

it("does not restart the search debounce on ordinary snapshot refreshes", async () => {
  const catalog = snapshot();
  catalog.truncation.modelsOmitted = 2;
  const ui = setup({ snapshot: catalog });
  const input = await ui.open();
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: "hidden" } });
  await act(() => vi.advanceTimersByTimeAsync(100));
  ui.update({ snapshot: { ...catalog, generatedAt: "later" } });
  await act(() => vi.advanceTimersByTimeAsync(150));
  expect(ui.searchModels).toHaveBeenCalledExactlyOnceWith("hidden");
  ui.update({
    modelSearch: {
      query: "hidden",
      status: "ready",
      models: [],
      totalMatches: 0,
      matchesOmitted: 0,
      error: null,
    },
  });
  ui.update({ snapshot: { ...catalog, generatedAt: "newer" } });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ui.searchModels).toHaveBeenCalledTimes(1);
});

it("retries failed bounded search without discarding its query", async () => {
  const catalog = snapshot();
  catalog.truncation.modelsOmitted = 2;
  const ui = setup({ snapshot: catalog });
  const input = await ui.open();
  fireEvent.change(input, { target: { value: "hidden" } });
  ui.update({
    modelSearch: {
      query: "hidden",
      status: "error",
      models: [],
      totalMatches: 0,
      matchesOmitted: 0,
      error: "Unavailable",
    },
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("retryModelSearch") }),
  );
  expect(ui.searchModels).toHaveBeenCalledExactlyOnceWith("hidden");
  expect((input as HTMLInputElement).value).toBe("hidden");
});

function searchResult(): WebModelSearchResult {
  return {
    models: [snapshot().models[2]!],
    totalAvailable: 300,
    totalMatches: 1,
    truncation: {
      truncated: false,
      matchesOmitted: 0,
      maxResults: 50,
      maxBytes: 64 * 1024,
      bytes: 100,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("retains a pending search and its result through unrelated accepted snapshots", async () => {
  const client = new WebClient();
  const before = snapshot();
  const snapshots = vi.spyOn(client, "snapshot").mockResolvedValue(before);
  const result = deferred<WebModelSearchResult>();
  vi.spyOn(client, "searchModels").mockReturnValue(result.promise);
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const searching = store.getState().actions.searchModels("kite");
  snapshots.mockResolvedValue({ ...before, cursor: 2, generatedAt: "later" });
  await store.getState().actions.refreshSnapshot();
  expect(store.getState().modelSearch.status).toBe("loading");
  result.resolve(searchResult());
  await searching;
  expect(store.getState().modelSearch.status).toBe("ready");
  await store.getState().actions.refreshSnapshot();
  expect(store.getState().modelSearch.models[0]?.id).toBe("kite/model");
});

it.each(["catalog", "omitted", "nativePath"])(
  "invalidates a pending search when %s changes",
  async (change) => {
    const client = new WebClient();
    const before = snapshot();
    const after = snapshot();
    if (change === "catalog")
      after.models[0] = { ...after.models[0]!, label: "Changed" };
    if (change === "omitted") after.truncation.modelsOmitted = 1;
    if (change === "nativePath")
      after.currentSessionPath = "/workspace/copy.jsonl";
    const snapshots = vi.spyOn(client, "snapshot").mockResolvedValue(before);
    const result = deferred<WebModelSearchResult>();
    vi.spyOn(client, "searchModels").mockReturnValue(result.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    const searching = store.getState().actions.searchModels("kite");
    snapshots.mockResolvedValue(after);
    await store.getState().actions.refreshSnapshot();
    result.resolve(searchResult());
    await searching;
    expect(store.getState().modelSearch.status).toBe("idle");
    expect(store.getState().modelSearch.models).toHaveLength(0);
  },
);

it("invalidates search when the native controller path fallback changes", async () => {
  const client = new WebClient();
  const before = snapshot();
  delete before.currentSessionPath;
  const after = {
    ...before,
    sessions: [
      { ...before.sessions[0]!, controller: "none" as const },
      { ...before.sessions[0]!, path: "/workspace/copy.jsonl" },
    ],
  };
  const snapshots = vi.spyOn(client, "snapshot").mockResolvedValue(before);
  const result = deferred<WebModelSearchResult>();
  vi.spyOn(client, "searchModels").mockReturnValue(result.promise);
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const searching = store.getState().actions.searchModels("kite");
  snapshots.mockResolvedValue(after);
  await store.getState().actions.refreshSnapshot();
  result.resolve(searchResult());
  await searching;
  expect(store.getState().modelSearch.status).toBe("idle");
});

it("does not use a rejected snapshot as model-catalog evidence", async () => {
  const client = new WebClient();
  const before = snapshot();
  const snapshots = vi.spyOn(client, "snapshot").mockResolvedValue(before);
  const result = deferred<WebModelSearchResult>();
  vi.spyOn(client, "searchModels").mockReturnValue(result.promise);
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const searching = store.getState().actions.searchModels("kite");
  snapshots.mockResolvedValue({ ...before, sessions: [], models: [] });
  expect(await store.getState().actions.refreshSnapshot()).toBe(false);
  result.resolve(searchResult());
  await searching;
  expect(store.getState().modelSearch.status).toBe("ready");
});

it("reports native workspace removal success even when the following read fails", async () => {
  const client = new WebClient();
  vi.spyOn(client, "removeWorkspace").mockResolvedValue({
    path: "/workspace",
    removed: true,
  });
  vi.spyOn(client, "snapshot").mockRejectedValue(new Error("Read failed"));
  const store = createWebStore(client);
  expect(await store.getState().actions.removeWorkspace("/workspace")).toBe(
    true,
  );
  expect(store.getState().notice).toContain("Read failed");
});

it("reports a native workspace removal failure without claiming success", async () => {
  const client = new WebClient();
  vi.spyOn(client, "removeWorkspace").mockRejectedValue(
    new Error("Removal failed"),
  );
  const read = vi.spyOn(client, "snapshot");
  const store = createWebStore(client);
  expect(await store.getState().actions.removeWorkspace("/workspace")).toBe(
    false,
  );
  expect(read).not.toHaveBeenCalled();
});
