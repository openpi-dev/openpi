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
import { afterEach, expect, it, vi } from "vitest";
import type { WebSessionSummary } from "../../web/protocol/types.ts";
import { ArchivedChatsSettingsPanel } from "../../web/ui/src/features/settings/ArchivedChatsSettingsPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import {
  type ArchivedSessionPage,
  WebApiError,
  WebClient,
} from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const first: WebSessionSummary = {
  id: "first",
  path: "/sessions/first.jsonl",
  cwd: "/projects/one",
  name: "First chat",
  created: "2026-10-01T00:00:00Z",
  modified: "2026-10-02T00:00:00Z",
  messageCount: 1,
  firstMessage: "First",
  source: "web-session",
  origin: "web",
  controller: "none",
  readOnly: false,
};
const second: WebSessionSummary = {
  ...first,
  id: "second",
  path: "/sessions/second.jsonl",
  name: "Second chat",
};
function result(sessions = [first], nextCursor?: string): ArchivedSessionPage {
  return {
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
    truncation: {
      truncated: false,
      matchesOmitted: 0,
      recordsUnscanned: 0,
      maxPageSize: 25,
      maxScanned: 5000,
    },
  };
}
function show(onRestore = vi.fn(async (_path: string) => false)) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ArchivedChatsSettingsPanel, {
        workspaces: [
          { path: "/projects/one", name: "One", current: false },
          { path: "/projects/two", name: "Two", current: false },
        ],
        onRestore,
      }),
    ),
  );
}

it("uses the independent archive query, scopes sort/project on the server, and ignores a late old search", async () => {
  let release: (page: ArchivedSessionPage) => void = () => {};
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockImplementation(async (options) =>
      options?.query === "late"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : result(options?.query === "current" ? [second] : [first]),
    );
  show();
  await screen.findByText("First chat");
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("archiveSort") }),
    { target: { value: "created" } },
  );
  await waitFor(() =>
    expect(list.mock.lastCall?.[0]).toMatchObject({ sort: "created" }),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("archiveProjectFilter") }),
    { target: { value: "/projects/two" } },
  );
  await waitFor(() =>
    expect(list.mock.lastCall?.[0]).toMatchObject({
      cwd: "/projects/two",
      sort: "created",
    }),
  );
  const search = screen.getByRole("searchbox", {
    name: i18n.t("searchArchivedChats"),
  });
  fireEvent.change(search, { target: { value: "late" } });
  await waitFor(() => expect(list.mock.lastCall?.[0]?.query).toBe("late"));
  fireEvent.change(search, { target: { value: "current" } });
  await screen.findByText("Second chat");
  await act(async () => release(result([first])));
  expect(screen.queryByText("First chat")).toBeNull();
  expect(screen.getByText("Second chat")).toBeTruthy();
});

it("groups archived worktree forks under their source project and filters by that identity", async () => {
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValue(
      result([
        first,
        {
          ...second,
          cwd: "/worktrees/fork-working-directory",
          workspacePath: first.cwd,
        },
      ]),
    );
  show();
  await screen.findByText("Second chat");
  expect(
    screen.getByRole("button", {
      name: i18n.t("archiveProjectGroup", { project: "One", count: 2 }),
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("option", { name: "fork-working-directory" }),
  ).toBeNull();
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("archiveProjectFilter") }),
    {
      target: { value: first.cwd },
    },
  );
  await waitFor(() => expect(list.mock.lastCall?.[0]?.cwd).toBe(first.cwd));
});

it("keeps rows on a page failure and restarts a stale cursor query from the beginning", async () => {
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(result([first], "page-two"))
    .mockRejectedValueOnce(
      new WebApiError("stale", 409, "ARCHIVED_SESSION_CURSOR_STALE"),
    )
    .mockResolvedValueOnce(result([second]));
  show();
  await screen.findByText("First chat");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("moreArchives") }));
  await screen.findByText(i18n.t("archiveCursorStale"));
  expect(screen.getByText("First chat")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
  );
  await screen.findByText("Second chat");
  expect(list.mock.lastCall?.[0]?.cursor).toBeUndefined();
  expect(screen.queryByText("First chat")).toBeNull();
});

it("offers continuation after an empty scan window and reveals older archives", async () => {
  const list = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce({
      ...result([], "older-scan-window"),
      truncation: {
        ...result().truncation,
        truncated: true,
        recordsUnscanned: 1,
      },
    })
    .mockResolvedValueOnce(result([first]));
  show();
  const more = await screen.findByRole("button", {
    name: i18n.t("moreArchives"),
  });
  expect(screen.getByText(i18n.t("noScannedArchives"))).toBeTruthy();
  expect(
    screen.getByText(i18n.t("archiveScanBounded", { count: 1 })),
  ).toBeTruthy();
  fireEvent.click(more);
  await screen.findByText("First chat");
  expect(list.mock.lastCall?.[0]?.cursor).toBe("older-scan-window");
  expect(
    screen.queryByRole("button", { name: i18n.t("moreArchives") }),
  ).toBeNull();
});

it("collapses groups without mutation, deduplicates restore, and retains a failed row until a confirmed restore", async () => {
  let confirm: (success: boolean) => void = () => {};
  const restore = vi.fn(
    (_path: string) =>
      new Promise<boolean>((resolve) => {
        confirm = resolve;
      }),
  );
  vi.spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValueOnce(result([first]))
    .mockResolvedValueOnce(result([]));
  show(restore);
  await screen.findByText("First chat");
  const group = screen.getByRole("button", {
    name: i18n.t("archiveProjectGroup", { project: "One", count: 1 }),
  });
  fireEvent.click(group);
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("First chat")).toBeNull();
  expect(restore).not.toHaveBeenCalled();
  fireEvent.click(group);
  const button = screen.getByRole("button", {
    name: i18n.t("restoreArchivedChat", { title: "First chat" }),
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(restore).toHaveBeenCalledExactlyOnceWith(first.path);
  await act(async () => confirm(false));
  expect(screen.getByText(i18n.t("restoreFailed"))).toBeTruthy();
  expect(screen.getByText("First chat")).toBeTruthy();
  fireEvent.click(button);
  await act(async () => confirm(true));
  await screen.findByText(i18n.t("noArchivedSessions"));
  expect(screen.queryByText("First chat")).toBeNull();
});
