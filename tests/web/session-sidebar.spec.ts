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
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type {
  WebSessionSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import {
  type ArchivedSessionPage,
  WebApiError,
  WebClient,
} from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
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

function session(
  path: string,
  cwd: string,
  name: string,
  archived = false,
): WebSessionSummary {
  return {
    id: path,
    path,
    cwd,
    name,
    archived,
    source: "web-session",
    origin: "web",
    controller: "none",
    readOnly: false,
    modified: "2026-09-18T10:00:00Z",
    created: "2026-09-18T10:00:00Z",
    messageCount: 1,
    firstMessage: "hello",
  };
}

function snapshot(sessions: WebSessionSummary[]): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-18T10:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    workspaces: [
      { path: "/repos/long-example", name: "Shared", current: true },
      { path: "/other/shared", name: "Shared", current: false },
    ],
    sessions,
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      bytes: 0,
      maxBytes: 4 * 1024 * 1024,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      truncated: false,
    },
  };
}

function mount(
  data: WebSnapshot,
  overrides: Partial<Parameters<typeof SessionSidebar>[0]> = {},
) {
  if (!vi.isMockFunction(WebClient.prototype.listArchivedSessions))
    vi.spyOn(WebClient.prototype, "listArchivedSessions").mockImplementation(
      async ({ query = "" } = {}) =>
        archivePage(
          data.sessions.filter(
            (item) =>
              item.archived &&
              `${item.name} ${item.cwd} ${item.id}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          ),
        ),
    );
  const actions = createWebStore().getState().actions;
  const props = {
    snapshot: data,
    selectedPath: null,
    selectedWorkspace: null,
    collapsed: new Set<string>(),
    query: "",
    searchOpen: false,
    mobileOpen: false,
    settingsDisabled: false,
    onOpenSettings: vi.fn(),
    actions,
    ...overrides,
  };
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SessionSidebar, props),
    ),
  );
  return {
    actions,
    unmount: view.unmount,
    rerender(next: Partial<typeof props>) {
      Object.assign(props, next);
      view.rerender(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(SessionSidebar, props),
        ),
      );
    },
  };
}

function archivePage(
  sessions: ArchivedSessionPage["sessions"],
  nextCursor?: string,
): ArchivedSessionPage {
  return {
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
    truncation: {
      truncated: Boolean(nextCursor),
      matchesOmitted: nextCursor ? 1 : 0,
      recordsUnscanned: 0,
      maxPageSize: 50,
      maxScanned: 5_000,
    },
  };
}

it("shows per-Session running and queue facts without borrowing global runtime state", () => {
  const running = session(
    "/repos/long-example/one.jsonl",
    "/repos/long-example",
    "Working",
  );
  running.execution = { status: "running", pendingFollowUps: 2 };
  const unknown = session(
    "/repos/long-example/copy.jsonl",
    "/repos/long-example",
    "Unloaded",
  );
  unknown.id = running.id;
  const queued = session(
    "/other/shared/three.jsonl",
    "/other/shared",
    "Waiting",
  );
  queued.execution = { status: "idle", pendingFollowUps: 120 };
  const data = snapshot([running, unknown, queued]);
  data.runtime.status = "running";
  mount(data);

  const workingButton = screen.getByRole("button", {
    name: `Working · ${running.path} · Running · 2 messages queued`,
  });
  expect(workingButton.querySelector(".session-running")).toBeTruthy();
  expect(workingButton.querySelector(".session-queue")?.textContent).toBe("2");
  expect(
    screen
      .getByRole("button", { name: `Unloaded · ${unknown.path}` })
      .querySelector(".session-status"),
  ).toBeNull();
  const waitingButton = screen.getByRole("button", {
    name: `Waiting · ${queued.path} · 120 messages queued`,
  });
  expect(waitingButton.querySelector(".session-queue")?.textContent).toBe(
    "99+",
  );
  expect(waitingButton.querySelector(".session-running")).toBeNull();
});

it("clears sidebar execution markers when the runtime releases the Session", () => {
  const working = session(
    "/repos/long-example/one.jsonl",
    "/repos/long-example",
    "Working",
  );
  working.execution = { status: "running", pendingFollowUps: 1 };
  const { rerender } = mount(snapshot([working]));
  expect(
    screen
      .getByRole("button", { name: /Working.*Running.*1 messages queued/ })
      .querySelector(".session-status"),
  ).toBeTruthy();

  rerender({
    snapshot: snapshot([
      { ...working, execution: { status: "idle", pendingFollowUps: 0 } },
    ]),
  });
  expect(
    screen
      .getByRole("button", { name: `Working · ${working.path}` })
      .querySelector(".session-status"),
  ).toBeNull();
  rerender({ snapshot: snapshot([{ ...working, execution: undefined }]) });
  expect(
    screen
      .getByRole("button", { name: `Working · ${working.path}` })
      .querySelector(".session-status"),
  ).toBeNull();
});

it("searches the current loaded list and the separate archived query without changing collapse", async () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
    session(
      "/repos/long-example/two.jsonl",
      "/repos/long-example",
      "Old",
      true,
    ),
    session("/other/shared/three.jsonl", "/other/shared", "Third"),
  ]);
  data.truncation.sessionsOmitted = 12;
  const { rerender } = mount(data, {
    collapsed: new Set(["/repos/long-example"]),
    query: "long-example",
    searchOpen: true,
  });
  expect(screen.getByText("First")).toBeTruthy();
  expect(screen.queryByText("Old")).toBeNull();
  expect(screen.getByText("/repos/long-example")).toBeTruthy();
  expect(screen.getByText(/12 more sessions.*loaded list only/)).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /Shared.*long-example/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(await screen.findByText("Old")).toBeTruthy();
  expect(screen.queryByText("First")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Current" }));
  rerender({ query: "" });
  expect(screen.queryByText("First")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Shared.*long-example/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});

it("does not claim zero unloaded records during a complete-list search", () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
  ]);
  mount(data, { query: "first", searchOpen: true });

  expect(screen.getByText("First")).toBeTruthy();
  expect(screen.queryByText(/loaded list only/iu)).toBeNull();
  expect(screen.queryByText(/0 more sessions/iu)).toBeNull();
});

it("scopes an empty search result to loaded history when sessions are omitted", () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
  ]);
  data.truncation.sessionsOmitted = 12;
  mount(data, { query: "missing", searchOpen: true });

  expect(
    screen.getByText("No matching conversations in the loaded history"),
  ).toBeTruthy();
  expect(screen.queryByText("No matching conversations")).toBeNull();
});

it("distinguishes identical names by path and marks only a snapshot-confirmed selection", async () => {
  const first = session(
    "/repos/long-example/one.jsonl",
    "/repos/long-example",
    "Same title that continues over multiple words",
  );
  const second = session(
    "/other/shared/two.jsonl",
    "/other/shared",
    first.name!,
  );
  const data = snapshot([first, second]);
  const { actions, rerender } = mount(data, {
    selectedPath: first.path,
    selectedWorkspace: first.cwd,
  });
  const firstButton = screen.getByRole("button", {
    name: `${first.name} · ${first.path}`,
  });
  const secondButton = screen.getByRole("button", {
    name: `${second.name} · ${second.path}`,
  });
  expect(firstButton.getAttribute("aria-current")).toBeNull();
  data.selectedSession = {
    id: first.id,
    path: first.path,
  } as WebSnapshot["selectedSession"];
  data.currentSessionId = first.id;
  rerender({ snapshot: { ...data } });
  expect(firstButton.getAttribute("aria-current")).toBe("page");
  expect(secondButton.getAttribute("aria-current")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /Shared.*long-example/ })
      .getAttribute("aria-current"),
  ).toBe("location");
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  fireEvent.click(secondButton);
  expect(select).toHaveBeenCalledWith(second.path);
});

it("keeps a failed rename draft editable and saves it on retry", async () => {
  const data = snapshot([
    session("/repos/long-example/one.jsonl", "/repos/long-example", "First"),
  ]);
  const { actions } = mount(data);
  const rename = vi
    .spyOn(actions, "renameSession")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce();
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Rename conversation" }),
  );
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Conversation name",
  });
  fireEvent.change(input, { target: { value: "Revised" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
  expect(input.value).toBe("Revised");
  expect(
    screen.getByRole("dialog", { name: "Rename conversation" }),
  ).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save" })),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Rename conversation" }),
    ).toBeNull(),
  );
  expect(rename).toHaveBeenLastCalledWith(
    "/repos/long-example/one.jsonl",
    "Revised",
  );
});

it("keeps an archived row available after an unconfirmed restore", async () => {
  const data = snapshot([
    session(
      "/repos/long-example/old.jsonl",
      "/repos/long-example",
      "Old",
      true,
    ),
  ]);
  const { actions } = mount(data);
  const restore = vi
    .spyOn(actions, "unarchiveSession")
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Old");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Restore conversation" }),
  );
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByText("Old")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  await act(async () =>
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Restore conversation" }),
    ),
  );
  expect(restore).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([false, true])(
  "marks the confirmed reader independently of the controller (copied id: %s)",
  (copiedId) => {
    const controller = session(
      "/repos/long-example/a.jsonl",
      "/repos/long-example",
      "Controller",
    );
    controller.controller = "web";
    const reader = session("/other/shared/b.jsonl", "/other/shared", "Reader");
    if (copiedId) reader.id = controller.id;
    const data = snapshot([controller, reader]);
    data.currentSessionId = controller.id;
    data.currentSessionPath = controller.path;
    data.selectedSession = {
      id: reader.id,
      path: reader.path,
      cwd: reader.cwd,
    } as WebSnapshot["selectedSession"];
    const { rerender } = mount(data, { selectedPath: reader.path });
    const selected = screen.getByRole("button", {
      name: `Reader · ${reader.path}`,
    });
    expect(selected.getAttribute("aria-current")).toBe("page");
    expect(
      screen
        .getByRole("button", { name: `Controller · ${controller.path}` })
        .getAttribute("aria-current"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Shared.*other\/shared/u })
        .getAttribute("aria-current"),
    ).toBe("location");
    rerender({ selectedPath: controller.path });
    expect(selected.getAttribute("aria-current")).toBeNull();
  },
);

it("loads and appends archived records outside the bounded snapshot without duplicating paths", async () => {
  const first = session("/old/one.jsonl", "/old", "Unloaded first", true);
  const second = session("/old/two.jsonl", "/old", "Unloaded second", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([first], "next"))
    .mockResolvedValueOnce(archivePage([first, second]));
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Unloaded first");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  await screen.findByText("Unloaded second");
  expect(screen.getAllByText("Unloaded first")).toHaveLength(1);
  expect(list).toHaveBeenLastCalledWith(
    { query: "", cursor: "next", limit: 25 },
    expect.any(AbortSignal),
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("moreArchives") }),
  ).toBeNull();
});

it("shows archive loading without an empty result and disables duplicate reads", async () => {
  let finish!: (page: ArchivedSessionPage) => void;
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(screen.getByRole("status").textContent).toBe(
    i18n.t("loadingArchives"),
  );
  expect(
    screen.queryByText(i18n.t("noArchivedSessions"))?.closest("[hidden]"),
  ).toBeTruthy();
  const refresh = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("refreshArchives"),
  });
  expect(refresh.disabled).toBe(true);
  fireEvent.click(refresh);
  expect(list).toHaveBeenCalledOnce();
  await act(async () => finish(archivePage([])));
  expect(screen.getByText(i18n.t("noArchivedSessions"))).toBeTruthy();
  expect(refresh.disabled).toBe(false);
});

it("isolates archive queries and ignores an aborted late page", async () => {
  let finish!: (page: ArchivedSessionPage) => void;
  let firstSignal!: AbortSignal;
  const beta = session("/old/b.jsonl", "/old", "Beta", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementationOnce((_options, signal) => {
      firstSignal = signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    })
    .mockResolvedValueOnce(archivePage([beta]));
  const view = mount(snapshot([]), { query: "alpha", searchOpen: true });
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  view.rerender({ query: "beta" });
  expect(firstSignal.aborted).toBe(true);
  await screen.findByText("Beta");
  await act(async () =>
    finish(archivePage([session("/old/a.jsonl", "/old", "Alpha", true)])),
  );
  expect(screen.queryByText("Alpha")).toBeNull();
  expect(list).toHaveBeenLastCalledWith(
    { query: "beta", limit: 25 },
    expect.any(AbortSignal),
  );
});

it("retains archive rows on a stale cursor and refreshes the first page", async () => {
  const old = session("/old/a.jsonl", "/old", "Retained", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old], "stale"))
    .mockRejectedValueOnce(
      new WebApiError("stale", 409, "ARCHIVED_SESSION_CURSOR_STALE"),
    )
    .mockResolvedValueOnce(archivePage([]));
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Retained");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(i18n.t("archiveCursorStale"));
  expect(screen.getByText("Retained")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: i18n.t("moreArchives") }),
  ).toBeNull();
  fireEvent.click(
    within(alert).getByRole("button", { name: i18n.t("refreshArchives") }),
  );
  await screen.findByText(i18n.t("noArchivedSessions"));
  expect(list).toHaveBeenLastCalledWith(
    { query: "", limit: 25 },
    expect.any(AbortSignal),
  );
});

it("retries the failed archive page without falsely treating a generic 409 as a stale cursor", async () => {
  const old = session("/old/a.jsonl", "/old", "Retained", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old], "next"))
    .mockRejectedValueOnce(new WebApiError("busy", 409, "SESSION_BUSY"))
    .mockResolvedValueOnce(archivePage([]));
  mount(snapshot([]));
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Retained");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(i18n.t("archiveLoadFailed"));
  expect(alert.textContent).not.toContain(i18n.t("archiveCursorStale"));
  fireEvent.click(
    within(alert).getByRole("button", { name: i18n.t("retryArchives") }),
  );
  await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  expect(list).toHaveBeenLastCalledWith(
    { query: "", cursor: "next", limit: 25 },
    expect.any(AbortSignal),
  );
  expect(screen.getByText("Retained")).toBeTruthy();
});

it.each(["view", "unmount"] as const)(
  "aborts archive reads at the %s lifecycle boundary",
  async (boundary) => {
    let finish!: (page: ArchivedSessionPage) => void;
    let signal!: AbortSignal;
    vi.spyOn(WebClient.prototype, "listArchivedSessions").mockImplementation(
      (_options, nextSignal) => {
        signal = nextSignal!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const view = mount(snapshot([]));
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    if (boundary === "unmount") view.unmount();
    else fireEvent.click(screen.getByRole("button", { name: "Current" }));
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish(archivePage([session("/old/a.jsonl", "/old", "Late", true)])),
    );
    expect(screen.queryByText("Late")).toBeNull();
  },
);

it("refreshes archives after restoration without selecting the restored Session", async () => {
  const old = session("/old/a.jsonl", "/old", "Restore me", true);
  vi.spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old]))
    .mockResolvedValueOnce(archivePage([]));
  const { actions } = mount(snapshot([]));
  const restore = vi.spyOn(actions, "unarchiveSession").mockResolvedValue(true);
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Restore me");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("restoreConversation"),
    }),
  );
  await screen.findByText(i18n.t("noArchivedSessions"));
  expect(restore).toHaveBeenCalledExactlyOnceWith(old.path);
  expect(select).not.toHaveBeenCalled();
});

it("does not expose a restore failure from a previous archive query", async () => {
  const old = session("/old/a.jsonl", "/old", "Alpha", true);
  const next = session("/old/b.jsonl", "/old", "Beta", true);
  vi.spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage([old]))
    .mockResolvedValueOnce(archivePage([next]));
  const view = mount(snapshot([]), { query: "alpha" });
  let finish!: (restored: boolean) => void;
  vi.spyOn(view.actions, "unarchiveSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("restoreConversation"),
    }),
  );
  view.rerender({ query: "beta" });
  await screen.findByText("Beta");
  await act(async () => finish(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Beta")).toBeTruthy();
});

it("keeps a confirmed workspace marked when its selected Session is outside the catalog", () => {
  const data = snapshot([]);
  data.selectedSession = {
    id: "reader",
    path: "/other/shared/old.jsonl",
    cwd: "/other/shared",
  } as WebSnapshot["selectedSession"];
  mount(data, { selectedPath: data.selectedSession!.path });
  expect(
    screen
      .getByRole("button", { name: /Shared.*other\/shared/u })
      .getAttribute("aria-current"),
  ).toBe("location");
});

it("does not mark a stale catalog id at the confirmed selected path", () => {
  const row = session("/other/shared/old.jsonl", "/other/shared", "Stale row");
  const data = snapshot([row]);
  data.selectedSession = {
    id: "replacement",
    path: row.path,
    cwd: row.cwd,
  } as WebSnapshot["selectedSession"];
  mount(data, { selectedPath: row.path });
  expect(
    screen
      .getByRole("button", { name: `Stale row · ${row.path}` })
      .getAttribute("aria-current"),
  ).toBeNull();
});

it("does not start another archive read after a restore settles beyond unmount", async () => {
  const old = session("/old/a.jsonl", "/old", "Old", true);
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValue(archivePage([old]));
  const view = mount(snapshot([]));
  let finish!: (restored: boolean) => void;
  vi.spyOn(view.actions, "unarchiveSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText("Old");
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("restoreConversation"),
    }),
  );
  view.unmount();
  await act(async () => finish(true));
  expect(list).toHaveBeenCalledOnce();
});

it("reports an empty archived query as bounded when older records remain unscanned", async () => {
  vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue({
    ...archivePage([]),
    truncation: {
      ...archivePage([]).truncation,
      truncated: true,
      recordsUnscanned: 12,
    },
  });
  mount(snapshot([]), { query: "missing" });
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  await screen.findByText(i18n.t("noMatchingScannedArchives"));
  expect(
    screen.getByText(i18n.t("archiveScanBounded", { count: 12 })),
  ).toBeTruthy();
  expect(screen.queryByText(i18n.t("noMatching"))).toBeNull();
});
