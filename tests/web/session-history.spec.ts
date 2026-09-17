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
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { SessionHistory } from "../../web/ui/src/features/sessions/SessionHistory.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const archived = (id: string) => ({
  id,
  path: `/repo/${id}.jsonl`,
  cwd: "/repo",
  name: `Archive ${id}`,
  modified: "2026-09-01T00:00:00Z",
  created: "2026-09-01T00:00:00Z",
  messageCount: 1,
  firstMessage: "saved",
  archived: true as const,
});
const truncation = {
  truncated: false,
  matchesOmitted: 0,
  recordsUnscanned: 0,
  maxPageSize: 50,
  maxScanned: 5000,
};
const terminal = (path: string) => ({
  id: "terminal-id",
  path,
  cwd: "/repo",
  name: "Terminal record",
  created: "2026-09-01T00:00:00Z",
  modified: "2026-09-01T00:00:00Z",
  messageCount: 2,
  metadataPartial: false,
  firstMessage: "original request",
  source: "pi-default" as const,
  origin: "terminal" as const,
  readOnly: true as const,
});

function view(node: ReturnType<typeof createElement>) {
  return render(createElement(I18nextProvider, { i18n }, node));
}

it("pages archived Sessions without duplicating rows or activating them for restoration", async () => {
  const list = vi
    .spyOn(WebClient.prototype, "archivedSessions")
    .mockResolvedValueOnce({
      sessions: [archived("one")],
      nextCursor: "page-2",
      truncation,
    })
    .mockResolvedValueOnce({
      sessions: [archived("one"), archived("two")],
      truncation,
    });
  const actions = createWebStore().getState().actions;
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  const restore = vi.spyOn(actions, "unarchiveSession").mockResolvedValue(true);
  view(
    createElement(SessionHistory, {
      kind: "archived",
      query: "",
      workspace: null,
      actions,
    }),
  );
  expect(await screen.findByText("Archive one")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Archive two")).toBeTruthy();
  expect(screen.getAllByText("Archive one")).toHaveLength(1);
  expect(screen.getByText("End of available history")).toBeTruthy();
  expect(list).toHaveBeenNthCalledWith(
    2,
    "",
    "page-2",
    expect.any(AbortSignal),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Restore conversation Archive one" }),
  );
  await waitFor(() => expect(screen.queryByText("Archive one")).toBeNull());
  expect(restore).toHaveBeenCalledWith("/repo/one.jsonl");
  expect(select).not.toHaveBeenCalled();
});

it("reads terminal history as bounded text without selecting a writable Session and clears it on workspace change", async () => {
  const path = "/repo/terminal.jsonl";
  const list = vi
    .spyOn(WebClient.prototype, "terminalSessions")
    .mockResolvedValue({
      sessions: [terminal(path)],
      cursor: 0,
      total: 1,
      partial: true,
    });
  const detail = vi
    .spyOn(WebClient.prototype, "terminalSession")
    .mockResolvedValue({
      ...terminal(path),
      preview: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Original source text" }],
          },
          { role: "assistant", content: [{ type: "image", data: "hidden" }] },
        ],
        totalMessages: 3,
        bytesRead: 120,
        retainedBytes: 80,
        truncatedBytes: 40,
      },
    });
  const actions = createWebStore().getState().actions;
  const select = vi.spyOn(actions, "selectSession").mockResolvedValue();
  const { rerender } = view(
    createElement(SessionHistory, {
      kind: "terminal",
      query: "",
      workspace: "/repo",
      actions,
    }),
  );
  expect(await screen.findByText("Terminal record")).toBeTruthy();
  expect(
    screen.getByText("History scan is partial; some records may not be shown."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Terminal record/u }));
  expect(await screen.findByText("Original source text")).toBeTruthy();
  expect(screen.getByText("Non-text content not shown")).toBeTruthy();
  expect(screen.getByText(/Showing 2 of 3 messages/u)).toBeTruthy();
  expect(detail).toHaveBeenCalledWith(path, expect.any(AbortSignal));
  expect(select).not.toHaveBeenCalled();
  await act(async () => {
    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(SessionHistory, {
          kind: "terminal",
          query: "",
          workspace: "/other",
          actions,
        }),
      ),
    );
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Terminal session history" }),
    ).toBeNull(),
  );
  expect(list).toHaveBeenLastCalledWith("", 0, expect.any(AbortSignal));
});

it("does not discover terminal history without a selected workspace", async () => {
  const list = vi.spyOn(WebClient.prototype, "terminalSessions");
  const actions = createWebStore().getState().actions;
  view(
    createElement(SessionHistory, {
      kind: "terminal",
      query: "",
      workspace: null,
      actions,
    }),
  );
  expect(
    await screen.findByText(
      "Select a workspace to inspect its terminal sessions.",
    ),
  ).toBeTruthy();
  expect(list).not.toHaveBeenCalled();
});
