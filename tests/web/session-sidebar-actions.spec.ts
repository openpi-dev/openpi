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
import { WebClient } from "../../web/ui/src/protocol/client.ts";
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
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(WebClient.prototype, "sessionOpenTargets").mockResolvedValue({
    targets: [],
  });
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
    readRevision: `revision:${cwd}/${name}.jsonl`,
  } satisfies WebSessionSummary;
}

function mount(sessions: WebSessionSummary[] = [session("First")]) {
  const actions = createWebStore().getState().actions;
  const data = {
    protocolVersion: 1,
    generatedAt: "2026-09-26T10:00:00Z",
    cursor: 1,
    preferences: { theme: "system", projectsInRecents: false },
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
    data,
    actions,
    update(next: Partial<typeof props>) {
      Object.assign(props, next);
      view.rerender(element());
    },
  };
}

async function openRename(name: string) {
  const row = (
    await screen.findByText(name, { selector: ".session-title" })
  ).closest<HTMLElement>(".session-row");
  if (!row) throw new Error("Session row is missing");
  fireEvent.click(
    within(row).getByRole("button", {
      name: i18n.t("conversationOptions"),
    }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarRename"),
    }),
  );
  return screen.findByRole<HTMLInputElement>("textbox", {
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

it("marks a conversation read against its exact revision, retries failure and waits for the backend projection before changing badges", async () => {
  const receipt = {
    commandId: "turn-42",
    finishedAt: 42,
    outcome: "completed" as const,
    resultEntryId: "result-42",
  };
  const entry: WebSessionSummary = {
    ...session("Result"),
    unread: true,
    execution: { status: "idle", lastTurn: receipt },
  };
  const view = mount([entry]);
  const read = vi
    .spyOn(view.actions, "setSessionRead")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue();
  const select = vi.spyOn(view.actions, "selectSession").mockResolvedValue();
  const openMenu = () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("conversationOptions") }),
    );
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("markConversationRead"),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    i18n.t("sidebarReadFailed"),
  );
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  expect(read).toHaveBeenCalledExactlyOnceWith(
    entry.path,
    entry.id,
    true,
    entry.readRevision,
  );
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("markConversationRead"),
    }),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  const confirmed = { ...entry, unread: false, readRevision: "confirmed-read" };
  view.update({ snapshot: { ...view.data, sessions: [confirmed] } });
  expect(document.querySelector(".session-state-completed")).toBeNull();
  openMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("markConversationUnread"),
    }),
  );
  await waitFor(() =>
    expect(read).toHaveBeenLastCalledWith(
      entry.path,
      entry.id,
      false,
      confirmed.readRevision,
    ),
  );
  expect(document.querySelector(".session-state-completed")).toBeNull();
  view.update({
    snapshot: {
      ...view.data,
      sessions: [{ ...entry, readRevision: "confirmed-unread" }],
    },
  });
  expect(document.querySelector(".session-state-completed")).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
});

it.each([true, false])(
  "disables a manual read-state write without a revision when unread is %s",
  async (unread) => {
    const view = mount([
      { ...session("Legacy"), unread, readRevision: undefined },
    ]);
    const read = vi.spyOn(view.actions, "setSessionRead").mockResolvedValue();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("conversationOptions") }),
    );
    const item = await screen.findByRole("menuitem", {
      name: i18n.t(unread ? "markConversationRead" : "markConversationUnread"),
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(read).not.toHaveBeenCalled();
  },
);

it("marks only readable unread chats in the chosen project as read, including individually pinned chats", async () => {
  const regular = { ...session("Regular"), unread: true };
  const pinned = { ...session("Pinned"), unread: true, pinOrder: 0 };
  const entries: WebSessionSummary[] = [
    regular,
    pinned,
    { ...session("Already read"), unread: false },
    { ...session("Archived", true), unread: true },
    { ...session("Legacy"), unread: true, readRevision: undefined },
    { ...session("Ungrouped"), unread: true, ungrouped: true },
    {
      ...session("Other project"),
      cwd: "/repos/other",
      path: "/repos/other/chat.jsonl",
      readRevision: "other-project-revision",
      unread: true,
    },
  ];
  const view = mount(entries);
  const read = vi.spyOn(view.actions, "setSessionRead").mockResolvedValue();
  const select = vi.spyOn(view.actions, "selectSession").mockResolvedValue();
  fireEvent.click(
    within(screen.getByRole("region", { name: "Project" })).getByRole(
      "button",
      { name: i18n.t("workspaceOptions") },
    ),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarMarkAllRead") }),
  );
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls).toEqual(
    expect.arrayContaining([
      [regular.path, regular.id, true, regular.readRevision],
      [pinned.path, pinned.id, true, pinned.readRevision],
    ]),
  );
  expect(select).not.toHaveBeenCalled();
});

it.each([
  { name: "Command+K", key: "k", metaKey: true },
  { name: "Control+K", key: "k", ctrlKey: true },
  { name: "Command+Shift+P", key: "P", metaKey: true, shiftKey: true },
])(
  "leaves $name to the browser and opens search through its button",
  ({ name: _name, ...keys }) => {
    const { actions } = mount();
    const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
    const trigger = screen.getByRole("button", {
      name: i18n.t("searchConversations"),
    });
    trigger.focus();
    fireEvent.keyDown(document, { ...keys, isComposing: true });
    expect(
      screen.queryByRole("dialog", { name: i18n.t("transcriptSearch") }),
    ).toBeNull();
    expect(fireEvent.keyDown(document, keys)).toBe(true);
    expect(
      screen.queryByRole("dialog", { name: i18n.t("transcriptSearch") }),
    ).toBeNull();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: i18n.t("transcriptSearch"),
    });
    const input = within(dialog).getByRole("searchbox");
    expect(document.activeElement).toBe(input);
    expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: i18n.t("transcriptSearch") }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

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
  "clears the %s new-Session entry's current-list search only after creation is confirmed",
  async (entry) => {
    const pending = deferred<typeof createdTarget>();
    const view = mount();
    view.update({ query: "First", searchOpen: true });
    const create = vi
      .spyOn(view.actions, "createSession")
      .mockReturnValue(pending.promise);
    const query = vi.spyOn(view.actions, "setQuery");
    const select = vi.spyOn(view.actions, "selectSession");
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
    expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("First");
    await act(async () => pending.resolve(createdTarget));
    expect(query).toHaveBeenCalledExactlyOnceWith("");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("newSession"),
      }).disabled,
    ).toBe(false);
    expect(select).not.toHaveBeenCalled();
  },
);

it.each(["cancelled", "failed"] as const)(
  "preserves the current-list search scope when new Session creation is %s",
  async (outcome) => {
    const view = mount();
    view.update({ query: "First", searchOpen: true });
    vi.spyOn(view.actions, "createSession").mockImplementation(async () => {
      if (outcome === "failed") throw new Error("offline");
      return null;
    });
    const query = vi.spyOn(view.actions, "setQuery");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("newSession"),
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(query).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("First");
  },
);

it("keeps a newer search intention even when it returns to the original query before creation settles", async () => {
  const pending = deferred<typeof createdTarget>();
  const view = mount();
  view.update({ query: "First", searchOpen: true });
  vi.spyOn(view.actions, "createSession").mockReturnValue(pending.promise);
  const query = vi.spyOn(view.actions, "setQuery");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("newSession") }));
  view.update({ query: "Other" });
  view.update({ query: "First" });
  await act(async () => pending.resolve(createdTarget));
  expect(query).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("First");
});

it("does not treat choosing a workspace as a confirmed new Session", async () => {
  const view = mount();
  view.update({ selectedWorkspace: null, query: "First", searchOpen: true });
  const choose = vi.spyOn(view.actions, "chooseWorkspace").mockResolvedValue();
  const create = vi.spyOn(view.actions, "createSession");
  const query = vi.spyOn(view.actions, "setQuery");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("newSession") }));
  await waitFor(() => expect(choose).toHaveBeenCalledOnce());
  expect(create).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("First");
});
