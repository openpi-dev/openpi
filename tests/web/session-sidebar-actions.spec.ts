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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type {
  WebSessionSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import {
  type ArchivedSessionPage,
  WebClient,
} from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

const cwd = "/repos/project";

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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function session(name: string, archived = false) {
  return {
    id: name,
    path: `${cwd}/${name}.jsonl`,
    cwd,
    name,
    archived,
    source: "web-session",
    origin: "web",
    controller: "none",
    readOnly: false,
    modified: "2026-09-26T10:00:00Z",
    created: "2026-09-26T10:00:00Z",
    messageCount: 1,
    firstMessage: "hello",
  } satisfies WebSessionSummary;
}

function archivePage(
  sessions: ArchivedSessionPage["sessions"],
  nextCursor?: string,
) {
  return {
    sessions: sessions.map((item) => ({ ...item })),
    ...(nextCursor ? { nextCursor } : {}),
    truncation: {
      truncated: Boolean(nextCursor),
      matchesOmitted: nextCursor ? 1 : 0,
      recordsUnscanned: 0,
      maxPageSize: 50,
      maxScanned: 5_000,
    },
  } satisfies ArchivedSessionPage;
}

function mount(sessions = [session("First")]) {
  const actions = createWebStore().getState().actions;
  const data = {
    protocolVersion: 1,
    generatedAt: "2026-09-26T10:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    workspaces: [{ path: cwd, name: "Project", current: false }],
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
  } satisfies WebSnapshot;
  const props: Parameters<typeof SessionSidebar>[0] = {
    snapshot: data,
    selectedPath: null,
    selectedWorkspace: cwd,
    collapsed: new Set(),
    query: "",
    searchOpen: false,
    mobileOpen: false,
    settingsDisabled: false,
    onOpenSettings: vi.fn(),
    actions,
  };
  const element = () =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(SessionSidebar, props),
    );
  const view = render(element());
  return {
    ...view,
    actions,
    update(next: Partial<typeof props>) {
      Object.assign(props, next);
      view.rerender(element());
    },
  };
}

async function openRename(name: string) {
  const row = (await screen.findByText(name)).closest<HTMLElement>(
    ".session-row",
  );
  if (!row) throw new Error("Session row is missing");
  fireEvent.click(
    within(row).getByRole("button", {
      name: i18n.t("conversationOptions"),
    }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("renameConversation"),
    }),
  );
  return screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("conversationName"),
  });
}

async function openWorkspaceRemove() {
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("workspaceOptions") }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("removeWorkspace") }),
  );
  return screen.getByRole("dialog", { name: i18n.t("removeWorkspace") });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("locks the exact rename form until its native write settles and admits one submission", async () => {
  const { actions } = mount();
  const pending = deferred<void>();
  const rename = vi
    .spyOn(actions, "renameSession")
    .mockReturnValue(pending.promise);
  const input = await openRename("First");
  fireEvent.change(input, { target: { value: "Revised" } });
  const form = input.closest("form");
  if (!form) throw new Error("Rename form is missing");
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(rename).toHaveBeenCalledTimes(1);
  expect(rename).toHaveBeenCalledWith(`${cwd}/First.jsonl`, "Revised");
  expect(input.disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("savingName"),
    }).disabled,
  ).toBe(true);
  const cancel = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("cancel"),
  });
  expect(cancel.disabled).toBe(true);
  fireEvent.click(cancel);
  const dialog = screen.getByRole("dialog", {
    name: i18n.t("renameConversation"),
  });
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(
    screen.getByRole("dialog", { name: i18n.t("renameConversation") }),
  ).toBe(dialog);
  await act(async () => pending.resolve());
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: i18n.t("renameConversation") }),
    ).toBeNull(),
  );
});

it("does not submit an empty or unchanged name", async () => {
  const { actions } = mount();
  const rename = vi.spyOn(actions, "renameSession").mockResolvedValue();
  const input = await openRename("First");
  const save = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("save"),
  });
  expect(save.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "  " } });
  expect(save.disabled).toBe(true);
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(rename).not.toHaveBeenCalled();
});

it("keeps a failed rename in the dialog with local feedback and an editable retry", async () => {
  const { actions } = mount();
  const rename = vi
    .spyOn(actions, "renameSession")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce();
  const input = await openRename("First");
  fireEvent.change(input, { target: { value: " Revised " } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toBe(i18n.t("renameFailed"));
  expect(error.closest("dialog")).toBeTruthy();
  expect(input.value).toBe(" Revised ");
  expect(input.disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: i18n.t("renameConversation") }),
    ).toBeNull(),
  );
  expect(rename).toHaveBeenCalledTimes(2);
  expect(rename).toHaveBeenLastCalledWith(`${cwd}/First.jsonl`, "Revised");
});

it("does not read the archive list when a current Session is renamed", async () => {
  const read = vi.spyOn(WebClient.prototype, "listArchivedSessions");
  const { actions } = mount();
  vi.spyOn(actions, "renameSession").mockResolvedValue();
  const input = await openRename("First");
  fireEvent.change(input, { target: { value: "Revised" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: i18n.t("renameConversation") }),
    ).toBeNull(),
  );
  expect(read).not.toHaveBeenCalled();
});

it("refreshes an archived rename through native pages without dropping the opened range or selecting it", async () => {
  const records = Array.from({ length: 50 }, (_, index) =>
    session(`Archived ${index + 1}`, true),
  );
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementation(async ({ cursor } = {}) =>
      cursor
        ? archivePage(records.slice(25))
        : archivePage(records.slice(0, 25), "second-page"),
    );
  const { actions } = mount([]);
  const select = vi.spyOn(actions, "selectSession");
  vi.spyOn(actions, "renameSession").mockImplementation(async (path, name) => {
    const record = records.find((item) => item.path === path);
    if (record) record.name = name;
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  await screen.findByText("Archived 1");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  await screen.findByText("Archived 50");
  const input = await openRename("Archived 30");
  fireEvent.change(input, { target: { value: "Revised archived" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  await screen.findByText("Revised archived");
  expect(screen.getByText("Archived 1")).toBeTruthy();
  expect(screen.getByText("Archived 50")).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(4);
  expect(read.mock.calls.slice(2).map(([query]) => query)).toEqual([
    { query: "", limit: 25 },
    { query: "", cursor: "second-page", limit: 25 },
  ]);
  expect(select).not.toHaveBeenCalled();
});

it("re-evaluates the archive query after a matching title is renamed", async () => {
  const record = session("Old match", true);
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementation(async ({ query = "" } = {}) =>
      archivePage(
        record.name.toLowerCase().includes(query.toLowerCase()) ? [record] : [],
      ),
    );
  const view = mount([]);
  view.update({ query: "Old", searchOpen: true });
  vi.spyOn(view.actions, "renameSession").mockImplementation(
    async (_path, name) => {
      record.name = name;
    },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  const input = await openRename("Old match");
  fireEvent.change(input, { target: { value: "New title" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  await screen.findByText(i18n.t("noMatching"));
  expect(screen.queryByText("Old match")).toBeNull();
  expect(screen.queryByText("New title")).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(
    { query: "Old", limit: 25 },
    expect.any(AbortSignal),
  );
});

it("does not refresh a different archive query after a late rename settles", async () => {
  const pending = deferred<void>();
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementation(async ({ query = "" } = {}) =>
      archivePage([
        session(query === "Beta" ? "Beta title" : "Alpha title", true),
      ]),
    );
  const view = mount([]);
  vi.spyOn(view.actions, "renameSession").mockReturnValue(pending.promise);
  view.update({ query: "Alpha", searchOpen: true });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  const input = await openRename("Alpha title");
  fireEvent.change(input, { target: { value: "Renamed Alpha" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  view.update({ query: "Beta" });
  await screen.findByText("Beta title");
  await act(async () => pending.resolve());
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByText("Beta title")).toBeTruthy();
});

it("keeps loaded rows and the retained range retry when a post-rename archive page fails", async () => {
  const records = Array.from({ length: 50 }, (_, index) =>
    session(`Archived ${index + 1}`, true),
  );
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage(records.slice(0, 25), "second-page"))
    .mockResolvedValueOnce(archivePage(records.slice(25)))
    .mockResolvedValueOnce(archivePage(records.slice(0, 25), "second-page"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(archivePage(records.slice(0, 25), "second-page"))
    .mockResolvedValueOnce(archivePage(records.slice(25)));
  const { actions } = mount([]);
  vi.spyOn(actions, "renameSession").mockResolvedValue();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  await screen.findByText("Archived 1");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  await screen.findByText("Archived 50");
  const input = await openRename("Archived 30");
  fireEvent.change(input, { target: { value: "Revised" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  await screen.findByText(i18n.t("archiveLoadFailed"));
  expect(screen.getByText("Archived 50")).toBeTruthy();
  expect(
    screen.queryByRole("dialog", { name: i18n.t("renameConversation") }),
  ).toBeNull();
  expect(screen.queryByText(i18n.t("renameFailed"))).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("retryArchives") }),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(6));
  await waitFor(() =>
    expect(screen.queryByText(i18n.t("archiveLoadFailed"))).toBeNull(),
  );
  expect(screen.getByText("Archived 50")).toBeTruthy();
});

it("aborts a retained-range refresh when the archive query changes and ignores its late second page", async () => {
  const records = Array.from({ length: 50 }, (_, index) =>
    session(`Alpha ${index + 1}`, true),
  );
  const pending = deferred<ArchivedSessionPage>();
  let refreshSignal: AbortSignal | undefined;
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(archivePage(records.slice(0, 25), "second-page"))
    .mockResolvedValueOnce(archivePage(records.slice(25)))
    .mockResolvedValueOnce(archivePage(records.slice(0, 25), "second-page"))
    .mockImplementationOnce((_query, signal) => {
      refreshSignal = signal;
      return pending.promise;
    })
    .mockResolvedValueOnce(archivePage([session("Beta result", true)]));
  const view = mount([]);
  view.update({ query: "Alpha", searchOpen: true });
  vi.spyOn(view.actions, "renameSession").mockResolvedValue();
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("archivedConversations"),
    }),
  );
  await screen.findByText("Alpha 1");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  await screen.findByText("Alpha 50");
  const input = await openRename("Alpha 30");
  fireEvent.change(input, { target: { value: "Renamed Alpha" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  view.update({ query: "Beta" });
  expect(refreshSignal?.aborted).toBe(true);
  await screen.findByText("Beta result");
  await act(async () => pending.resolve(archivePage(records.slice(25))));
  expect(screen.getByText("Beta result")).toBeTruthy();
  expect(screen.queryByText("Alpha 50")).toBeNull();
  expect(read).toHaveBeenCalledTimes(5);
});

it("does not start archive reads after an unmounted rename settles", async () => {
  const pending = deferred<void>();
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValue(archivePage([session("Archived session", true)]));
  const view = mount([]);
  vi.spyOn(view.actions, "renameSession").mockReturnValue(pending.promise);
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  const input = await openRename("Archived session");
  fireEvent.change(input, { target: { value: "Revised" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("save") }));
  view.unmount();
  await act(async () => pending.resolve());
  expect(read).toHaveBeenCalledTimes(1);
});

it("calls the operation removal, identifies its path, and waits for one result before closing", async () => {
  const { actions } = mount();
  const pending = deferred<boolean>();
  const remove = vi
    .spyOn(actions, "removeWorkspace")
    .mockReturnValue(pending.promise);
  const dialog = await openWorkspaceRemove();
  expect(within(dialog).getByText(cwd)).toBeTruthy();
  expect(
    within(dialog).getByText(
      new RegExp(
        i18n.t("workspaceDeleteConfirm").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    ),
  ).toBeTruthy();
  expect(within(dialog).queryByText(i18n.t("deleteWorkspace"))).toBeNull();
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: i18n.t("removeWorkspace"),
  });
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(cwd);
  expect(confirm.disabled).toBe(true);
  expect(confirm.textContent).toBe(i18n.t("removingWorkspace"));
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", {
      name: i18n.t("cancel"),
    }).disabled,
  ).toBe(true);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.getByRole("dialog", { name: i18n.t("removeWorkspace") })).toBe(
    dialog,
  );
  await act(async () => pending.resolve(true));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: i18n.t("removeWorkspace") }),
    ).toBeNull(),
  );
});

it("preserves a failed remove confirmation for retry and clears its error on a new opening", async () => {
  const { actions } = mount();
  const remove = vi
    .spyOn(actions, "removeWorkspace")
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(true);
  const dialog = await openWorkspaceRemove();
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: i18n.t("removeWorkspace"),
  });
  fireEvent.click(confirm);
  const error = await within(dialog).findByRole("alert");
  expect(error.textContent).toBe(i18n.t("workspaceRemoveFailed"));
  expect(confirm.disabled).toBe(false);
  fireEvent.click(confirm);
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(confirm.disabled).toBe(false));
  expect(screen.getByRole("dialog", { name: i18n.t("removeWorkspace") })).toBe(
    dialog,
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: i18n.t("cancel") }),
  );
  const reopened = await openWorkspaceRemove();
  expect(within(reopened).queryByRole("alert")).toBeNull();
  fireEvent.click(
    within(reopened).getByRole("button", { name: i18n.t("removeWorkspace") }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: i18n.t("removeWorkspace") }),
    ).toBeNull(),
  );
  expect(remove).toHaveBeenCalledTimes(3);
});

const createdTarget = {
  epoch: 1,
  sessionId: "created",
  sessionPath: `${cwd}/created.jsonl`,
  workspacePath: cwd,
};

it.each(["global", "workspace"] as const)(
  "returns the %s new-Session entry to the current unfiltered list only after creation is confirmed",
  async (entry) => {
    vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue(
      archivePage([session("Archived task", true)]),
    );
    const pending = deferred<typeof createdTarget>();
    const view = mount();
    view.update({ query: "Archived", searchOpen: true });
    const create = vi
      .spyOn(view.actions, "createSession")
      .mockReturnValue(pending.promise);
    const query = vi.spyOn(view.actions, "setQuery");
    const select = vi.spyOn(view.actions, "selectSession");
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("archivedConversations"),
      }),
    );
    await screen.findByText("Archived task");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name:
        entry === "global"
          ? i18n.t("newSession")
          : `${i18n.t("newSession")} Project`,
    });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(cwd);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(query).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: i18n.t("archivedConversations") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => pending.resolve(createdTarget));
    expect(query).toHaveBeenCalledExactlyOnceWith("");
    expect(
      screen
        .getByRole("button", { name: i18n.t("currentConversations") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("newSession"),
      }).disabled,
    ).toBe(false);
    expect(select).not.toHaveBeenCalled();
  },
);

it.each(["cancelled", "failed"] as const)(
  "preserves the archive and search scope when new Session creation is %s",
  async (outcome) => {
    vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue(
      archivePage([session("Archived task", true)]),
    );
    const view = mount();
    view.update({ query: "Archived", searchOpen: true });
    vi.spyOn(view.actions, "createSession").mockImplementation(async () => {
      if (outcome === "failed") throw new Error("offline");
      return null;
    });
    const query = vi.spyOn(view.actions, "setQuery");
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("archivedConversations"),
      }),
    );
    await screen.findByText("Archived task");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("newSession"),
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(query).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: i18n.t("archivedConversations") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe(
      "Archived",
    );
  },
);

it("keeps a newer search intention even when it returns to the original query before creation settles", async () => {
  vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue(
    archivePage([session("Archived task", true)]),
  );
  const pending = deferred<typeof createdTarget>();
  const view = mount();
  view.update({ query: "Archived", searchOpen: true });
  vi.spyOn(view.actions, "createSession").mockReturnValue(pending.promise);
  const query = vi.spyOn(view.actions, "setQuery");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  await screen.findByText("Archived task");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("newSession") }));
  view.update({ query: "Other" });
  view.update({ query: "Archived" });
  await act(async () => pending.resolve(createdTarget));
  expect(query).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe(
    "Archived",
  );
  expect(
    screen
      .getByRole("button", { name: i18n.t("archivedConversations") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("keeps a newer view intention even when the reader leaves and returns to archives before creation settles", async () => {
  vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue(
    archivePage([session("Archived task", true)]),
  );
  const pending = deferred<typeof createdTarget>();
  const view = mount();
  view.update({ query: "Archived", searchOpen: true });
  vi.spyOn(view.actions, "createSession").mockReturnValue(pending.promise);
  const query = vi.spyOn(view.actions, "setQuery");
  const archived = screen.getByRole("button", {
    name: i18n.t("archivedConversations"),
  });
  fireEvent.click(archived);
  await screen.findByText("Archived task");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("newSession") }));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("currentConversations") }),
  );
  fireEvent.click(archived);
  await screen.findByText("Archived task");
  await act(async () => pending.resolve(createdTarget));
  expect(query).not.toHaveBeenCalled();
  expect(archived.getAttribute("aria-pressed")).toBe("true");
});

it("does not treat choosing a workspace as a confirmed new Session", async () => {
  vi.spyOn(WebClient.prototype, "listArchivedSessions").mockResolvedValue(
    archivePage([session("Archived task", true)]),
  );
  const view = mount();
  view.update({ selectedWorkspace: null, query: "Archived", searchOpen: true });
  const choose = vi.spyOn(view.actions, "chooseWorkspace").mockResolvedValue();
  const create = vi.spyOn(view.actions, "createSession");
  const query = vi.spyOn(view.actions, "setQuery");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("archivedConversations") }),
  );
  await screen.findByText("Archived task");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("newSession") }));
  await waitFor(() => expect(choose).toHaveBeenCalledOnce());
  expect(create).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole("button", { name: i18n.t("archivedConversations") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
