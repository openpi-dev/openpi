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
import { ConversationMenu } from "../../web/ui/src/features/sessions/ConversationMenu.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import * as clipboard from "../../web/ui/src/lib/clipboard.ts";

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
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mount(
  overrides: Partial<Parameters<typeof ConversationMenu>[0]> = {},
) {
  const props = {
    session: {
      path: "/fixture/chat.jsonl",
      id: "fixture-id",
      cwd: "/fixture",
      name: "Target chat",
      firstMessage: "hello",
      readRevision: "rev1",
    },
    archived: false,
    connected: true,
    pinSaving: false,
    restoring: false,
    movementItems: [],
    client: {
      sessionMarkdown: vi
        .fn()
        .mockResolvedValue({ markdown: "# Target chat\n\nNative branch" }),
      sessionOpenTargets: vi.fn().mockResolvedValue({ targets: [] }),
      sessionForkOptions: vi
        .fn()
        .mockResolvedValue({ local: true, worktree: false }),
      openSessionIn: vi.fn().mockResolvedValue({ opened: true }),
    },
    actions: {
      forkConversation: vi.fn().mockResolvedValue(true),
      deleteSession: vi.fn().mockResolvedValue(true),
    },
    onRename: vi.fn(),
    onPin: vi.fn().mockResolvedValue(undefined),
    onRead: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onNotice: vi.fn(),
    ...overrides,
  } satisfies Parameters<typeof ConversationMenu>[0];
  const element = () =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        "div",
        { className: "session-sidebar" },
        createElement(
          "div",
          {
            className: "session-row",
            "data-session-key": JSON.stringify([
              props.session.path,
              props.session.id,
            ]),
          },
          createElement(
            "button",
            { type: "button", className: "session" },
            props.session.name,
          ),
          createElement(ConversationMenu, props),
        ),
        createElement(
          "button",
          { type: "button", className: "session" },
          "Next conversation",
        ),
        createElement("input", { "aria-label": "Composer" }),
      ),
    );
  const view = render(element());
  return {
    ...props,
    ...view,
    update(next: Partial<typeof props>) {
      Object.assign(props, next);
      view.rerender(element());
    },
  };
}

async function openMenu() {
  const trigger = screen.getByRole("button", {
    name: i18n.t("conversationOptions"),
  });
  fireEvent.click(trigger);
  await screen.findByRole("menuitem", { name: i18n.t("sidebarRename") });
  return trigger;
}

async function submenu(label: string) {
  const row = await screen.findByRole("menuitem", { name: i18n.t(label) });
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowRight" });
  return row;
}

it("matches sidebar menu groups and hides Open in after an empty app discovery", async () => {
  const view = mount();
  await openMenu();
  await waitFor(() =>
    expect(
      screen.queryByRole("menuitem", { name: i18n.t("sidebarOpenIn") }),
    ).toBeNull(),
  );
  const menu = screen.getByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent?.replace(/Ctrl\+[^ ]+/g, "")),
  ).toEqual([
    "Rename",
    "Pin",
    "Mark as unread",
    "Fork",
    "Copy",
    "Open in new window",
    "Archive",
    "Permanently delete",
  ]);
  expect(within(menu).getAllByRole("separator")).toHaveLength(4);
  expect(view.client.sessionOpenTargets).toHaveBeenCalledWith(
    view.session.path,
    view.session.id,
  );
  expect(
    within(menu)
      .getByRole("menuitem", { name: "Mark as unread" })
      .querySelector(".lucide-eye"),
  ).toBeTruthy();
});

it("opens Copy by keyboard, returns one level with Escape, and copies the target identity without credentials", async () => {
  const copied = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
  const view = mount();
  window.history.replaceState({}, "", "/?token=fixture-secret#sensitive");
  const trigger = await openMenu();
  const parent = await submenu("sidebarCopy");
  const link = await screen.findByRole("menuitem", {
    name: i18n.t("sidebarCopyLink"),
  });
  fireEvent.keyDown(link, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(parent));
  expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
  await submenu("sidebarCopy");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarCopyLink") }),
  );
  await waitFor(() => expect(copied).toHaveBeenCalledTimes(1));
  const url = new URL(copied.mock.calls[0][0]);
  expect([...url.searchParams]).toEqual([
    ["sessionPath", view.session.path],
    ["sessionId", view.session.id],
  ]);
  expect(url.hash).toBe("");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("copies all Markdown returned for the exact menu target", async () => {
  const copied = vi.spyOn(clipboard, "copyText").mockResolvedValue(true);
  const view = mount();
  await openMenu();
  await submenu("sidebarCopy");
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarCopyMarkdown"),
    }),
  );
  await waitFor(() =>
    expect(copied).toHaveBeenCalledWith("# Target chat\n\nNative branch"),
  );
  expect(view.client.sessionMarkdown).toHaveBeenCalledWith(
    view.session.path,
    view.session.id,
  );
});

it("forks the menu target and opens only the applications returned for that target", async () => {
  const view = mount();
  vi.mocked(view.client.sessionOpenTargets).mockResolvedValue({
    targets: [{ id: "fixture-editor", label: "Fixture editor" }],
  });
  await openMenu();
  await submenu("sidebarOpenIn");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Fixture editor" }),
  );
  await waitFor(() =>
    expect(view.client.openSessionIn).toHaveBeenCalledWith(
      view.session.path,
      view.session.id,
      "fixture-editor",
    ),
  );
  await openMenu();
  await submenu("sidebarFork");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarForkLocal") }),
  );
  await waitFor(() =>
    expect(view.actions.forkConversation).toHaveBeenCalledWith(
      view.session.path,
      view.session.id,
    ),
  );
});

it("identifies a local fork from an existing worktree as staying in that worktree", async () => {
  const view = mount({
    session: {
      path: "/fixture/chat.jsonl",
      id: "fixture-id",
      cwd: "/fixture/worktree",
      name: "Worktree chat",
      firstMessage: "hello",
      worktree: {
        path: "/fixture/worktree",
        sourceRoot: "/fixture",
        baseSha: "a".repeat(40),
      },
    },
  });
  await openMenu();
  await submenu("sidebarFork");
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarForkSameWorktree"),
    }),
  );
  expect(view.actions.forkConversation).toHaveBeenCalledWith(
    view.session.path,
    view.session.id,
  );
});

it("retries application discovery on reopen and ignores a late result from an earlier menu", async () => {
  const view = mount();
  const old = deferred<{ targets: { id: string; label: string }[] }>();
  vi.mocked(view.client.sessionOpenTargets)
    .mockReturnValueOnce(old.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const trigger = await openMenu();
  await submenu("sidebarOpenIn");
  expect(
    (
      await screen.findByRole("menuitem", {
        name: i18n.t("sidebarAppsLoading"),
      })
    ).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(trigger);
  await openMenu();
  await submenu("sidebarOpenIn");
  expect(
    (
      await screen.findByRole("menuitem", { name: i18n.t("sidebarAppsFailed") })
    ).getAttribute("aria-disabled"),
  ).toBe("true");
  await act(async () =>
    old.resolve({ targets: [{ id: "old", label: "Old app" }] }),
  );
  expect(screen.queryByRole("menuitem", { name: "Old app" })).toBeNull();
});

it("defaults delete to Cancel, blocks dismissal and duplicate writes while pending, and reuses its identity on retry", async () => {
  const view = mount();
  const pending = deferred<boolean>();
  vi.mocked(view.actions.deleteSession)
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(true);
  const trigger = await openMenu();
  fireEvent.click(
    screen.getByRole("menuitem", { name: i18n.t("sidebarDelete") }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: i18n.t("sidebarDeleteTitle"),
  });
  const cancel = within(dialog).getByRole<HTMLButtonElement>("button", {
    name: i18n.t("cancel"),
  });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(view.actions.deleteSession).not.toHaveBeenCalled();
  const form = dialog.querySelector("form")!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(view.actions.deleteSession).toHaveBeenCalledTimes(1);
  expect(cancel.disabled).toBe(true);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  fireEvent.click(cancel);
  expect(
    screen.getByRole("dialog", { name: i18n.t("sidebarDeleteTitle") }),
  ).toBe(dialog);
  await act(async () => pending.resolve(false));
  expect(await within(dialog).findByRole("alert")).toBeTruthy();
  const first = vi.mocked(view.actions.deleteSession).mock.calls[0];
  fireEvent.submit(form);
  await waitFor(() =>
    expect(view.actions.deleteSession).toHaveBeenCalledTimes(2),
  );
  expect(vi.mocked(view.actions.deleteSession).mock.calls[1]).toEqual(first);
  expect(first).toEqual([
    view.session.path,
    view.session.id,
    expect.any(String),
  ]);
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: i18n.t("sidebarDeleteTitle") }),
    ).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("allows snapshot forks while keeping queued conversations from archive and delete", async () => {
  const view = mount({
    session: {
      path: "/fixture/busy",
      id: "busy",
      cwd: "/fixture",
      firstMessage: "busy",
      execution: { status: "idle", pendingFollowUps: 1 },
    },
  });
  await openMenu();
  for (const key of ["sidebarArchive", "sidebarDelete"]) {
    const item = screen.getByRole("menuitem", {
      name: new RegExp(`^${i18n.t(key)}`),
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain(i18n.t("sidebarActionRunning"));
    fireEvent.click(item);
  }
  expect(view.actions.deleteSession).not.toHaveBeenCalled();
  expect(view.onArchive).not.toHaveBeenCalled();
  await submenu("sidebarFork");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarForkLocal") }),
  );
  expect(view.actions.forkConversation).toHaveBeenCalledWith(
    view.session.path,
    view.session.id,
  );
});

it("offers both fork environments for a running Git conversation and sends the selected environment", async () => {
  const view = mount({
    session: {
      path: "/fixture/running",
      id: "running",
      cwd: "/fixture",
      firstMessage: "working",
      execution: { status: "running" },
    },
  });
  vi.mocked(view.client.sessionForkOptions).mockResolvedValue({
    local: true,
    worktree: true,
  });
  await openMenu();
  await submenu("sidebarFork");
  expect(
    await screen.findByRole("menuitem", { name: i18n.t("sidebarForkLocal") }),
  ).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("sidebarForkWorktree"),
    }),
  );
  expect(view.actions.forkConversation).toHaveBeenCalledExactlyOnceWith(
    view.session.path,
    view.session.id,
    "worktree",
  );
  expect(view.client.sessionForkOptions).toHaveBeenCalledWith(
    view.session.path,
    view.session.id,
  );
});

it("does not offer a worktree for a non-Git conversation and ignores stale capability responses", async () => {
  const view = mount();
  const old = deferred<{ local: boolean; worktree: boolean }>();
  vi.mocked(view.client.sessionForkOptions)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ local: true, worktree: false });
  const trigger = await openMenu();
  await submenu("sidebarFork");
  expect(
    (
      await screen.findByRole("menuitem", {
        name: i18n.t("sidebarForkOptionsLoading"),
      })
    ).getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(trigger);
  await openMenu();
  await submenu("sidebarFork");
  await waitFor(() =>
    expect(
      screen.queryByRole("menuitem", {
        name: i18n.t("sidebarForkOptionsLoading"),
      }),
    ).toBeNull(),
  );
  await act(async () => old.resolve({ local: true, worktree: true }));
  expect(
    screen.queryByRole("menuitem", { name: i18n.t("sidebarForkWorktree") }),
  ).toBeNull();
  expect(view.actions.forkConversation).not.toHaveBeenCalled();
});

it("keeps a delete confirmation bound to its original identity when a path is reused", async () => {
  const view = mount();
  await openMenu();
  fireEvent.click(
    screen.getByRole("menuitem", { name: i18n.t("sidebarDelete") }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: i18n.t("sidebarDeleteTitle"),
  });
  view.update({
    session: {
      ...view.session,
      id: "replacement-id",
      name: "Replacement chat",
    },
  });
  expect(within(dialog).getByRole("alert").textContent).toBe(
    i18n.t("sessionLinkUnavailable"),
  );
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", {
      name: i18n.t("sidebarDeleteConfirm"),
    }).disabled,
  ).toBe(true);
  fireEvent.submit(dialog.querySelector("form")!);
  expect(view.actions.deleteSession).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain("Target chat");
});

it("leaves browser modifier shortcuts unhandled and exposes menu actions without shortcut hints", async () => {
  const view = mount();
  for (const modifier of ["ctrlKey", "metaKey"]) {
    for (const keys of [
      { altKey: true, code: "KeyR", key: "r" },
      { altKey: true, code: "KeyP", key: "p" },
      { shiftKey: true, code: "KeyU", key: "u" },
    ]) {
      expect(
        fireEvent.keyDown(document.body, { [modifier]: true, ...keys }),
      ).toBe(true);
    }
  }
  expect(view.onRename).not.toHaveBeenCalled();
  expect(view.onPin).not.toHaveBeenCalled();
  expect(view.onRead).not.toHaveBeenCalled();
  await openMenu();
  expect(document.querySelector(".sidebar-menu-shortcut")).toBeNull();
});

it("closes a menu when a pathname is reused by a different native Session", async () => {
  const view = mount();
  const trigger = await openMenu();
  view.update({
    session: {
      ...view.session,
      id: "replacement-id",
      name: "Replacement conversation",
    },
  });
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("false"),
  );
  expect(
    screen.queryByRole("menuitem", { name: i18n.t("sidebarRename") }),
  ).toBeNull();
  expect(view.actions.deleteSession).not.toHaveBeenCalled();
  expect(view.actions.forkConversation).not.toHaveBeenCalled();
});
