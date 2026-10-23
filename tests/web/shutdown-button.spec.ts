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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { ShutdownButton } from "../../web/ui/src/features/sessions/ShutdownButton.tsx";
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
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  window.sessionStorage.setItem("openpi.web.token", "a".repeat(64));
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

it("offers Quit without a Session or workspace, explains scope, and cancels without a request", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(SessionSidebar, {
      snapshot: null,
      selectedPath: null,
      selectedWorkspace: null,
      collapsed: new Set<string>(),
      query: "",
      searchOpen: false,
      mobileOpen: false,
      settingsDisabled: true,
      connected: false,
      onOpenSettings: vi.fn(),
      actions: createWebStore().getState().actions,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Quit OpenPI" }));
  const dialog = screen.getByRole("dialog", { name: "Quit OpenPI" });
  expect(within(dialog).getByText(/All running tasks.*will stop/)).toBeTruthy();
  expect(within(dialog).getByText(/Conversations are saved/)).toBeTruthy();
  expect(
    within(dialog).getByText(/Closing this browser tab alone leaves OpenPI/),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Quit OpenPI" })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it("confirms with one authenticated POST, locks pending actions, and shows terminal/restart instructions", async () => {
  const receipt = Promise.withResolvers<Response>();
  const fetcher = vi.fn().mockReturnValue(receipt.promise);
  vi.stubGlobal("fetch", fetcher);
  render(createElement(ShutdownButton, { client: new WebClient() }));
  fireEvent.click(screen.getByRole("button", { name: "Quit OpenPI" }));
  const dialog = screen.getByRole("dialog", { name: "Quit OpenPI" });
  const confirm = within(dialog).getByRole("button", { name: "Quit OpenPI" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", { name: "Quitting…" })
      .disabled,
  ).toBe(true);
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" })
      .disabled,
  ).toBe(true);
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.getByRole("alertdialog", { name: "Quit OpenPI" })).toBeTruthy();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledWith(
    "/api/shutdown",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: `Bearer ${"a".repeat(64)}`,
      }),
    }),
  );
  await act(async () =>
    receipt.resolve(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    ),
  );
  const accepted = await screen.findByRole("alertdialog", {
    name: "OpenPI is shutting down",
  });
  expect(within(accepted).getByRole("status").textContent).toMatch(
    /terminal to confirm/,
  );
  expect(
    within(accepted).getByText(
      /openpi web.*\/web.*Refreshing this page does not restart/,
    ),
  ).toBeTruthy();
  expect(within(accepted).queryByRole("button")).toBeNull();
  fireEvent(accepted, new Event("cancel", { cancelable: true }));
  expect(
    screen.getByRole("alertdialog", { name: "OpenPI is shutting down" }),
  ).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["http", "network", "unaccepted"])(
  "keeps the confirmation usable after %s failure and allows an explicit retry",
  async (failure) => {
    const fetcher = vi.fn();
    if (failure === "network")
      fetcher.mockRejectedValueOnce(new TypeError("offline"));
    else
      fetcher.mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            failure === "http"
              ? { error: "Shutdown unavailable" }
              : { accepted: false },
          ),
          { status: failure === "http" ? 503 : 200 },
        ),
      );
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetcher);
    render(createElement(ShutdownButton, { client: new WebClient() }));
    fireEvent.click(screen.getByRole("button", { name: "Quit OpenPI" }));
    const dialog = screen.getByRole("dialog", { name: "Quit OpenPI" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Quit OpenPI" }),
    );
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /Could not confirm shutdown.*Ctrl\+C/,
    );
    expect(
      within(dialog).getByRole<HTMLButtonElement>("button", { name: "Cancel" })
        .disabled,
    ).toBe(false);
    expect(
      screen.queryByRole("alertdialog", { name: "OpenPI is shutting down" }),
    ).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Quit OpenPI" }),
    );
    await screen.findByRole("alertdialog", { name: "OpenPI is shutting down" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("localizes the action and confirmation in Chinese", async () => {
  await i18n.changeLanguage("zh");
  render(createElement(ShutdownButton, { client: new WebClient() }));
  fireEvent.click(screen.getByRole("button", { name: "退出 OpenPI" }));
  const dialog = screen.getByRole("dialog", { name: "退出 OpenPI" });
  expect(
    within(dialog).getByText(/所有正在运行的任务都会停止，对话会保存/),
  ).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog", { name: "退出 OpenPI" })).toBeNull();
});
