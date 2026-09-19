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
import type {
  WebSessionSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(cleanup);
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
  const actions = createWebStore().getState().actions;
  const props = {
    snapshot: data,
    selectedPath: null,
    selectedWorkspace: null,
    collapsed: new Set<string>(),
    query: "",
    searchOpen: false,
    mobileOpen: false,
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

it("searches only the selected view and loaded list, revealing matched workspaces without changing collapse", () => {
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
  expect(screen.getByText("Old")).toBeTruthy();
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
