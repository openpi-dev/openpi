// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserSettingsStatus } from "../../web/protocol/browser.ts";
import { BrowserSettingsPanel } from "../../web/ui/src/features/settings/BrowserSettingsPanel.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const initial = (): BrowserSettingsStatus => ({
  config: {
    control: false,
    embedded: true,
    defaultBrowser: "embedded",
    externalBrowsers: [],
  },
  profiles: [],
  browsers: [
    { id: "chrome", installed: true },
    { id: "edge", installed: false },
    { id: "brave", installed: false },
    { id: "chromium", installed: false },
  ],
  extensionPath: "/bundled/browser-extension",
  extensionVersion: "0.3.0",
});
function backend(state = initial()) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const server = { writes, state, failActions: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push({ path: input, body });
        if (input === "/api/settings/browser/action" && server.failActions)
          return new Response(
            JSON.stringify({ error: "Could not open browser" }),
            { status: 422 },
          );
        if (input === "/api/settings/browser")
          state.config = { ...state.config, ...body };
      }
      return new Response(JSON.stringify(state));
    }),
  );
  render(
    createElement(BrowserSettingsPanel, { onSaved: vi.fn(async () => true) }),
  );
  return server;
}

it("separates installation evidence from authorization and guides setup without a model request", async () => {
  const { writes, state } = backend();
  await screen.findByRole("heading", { name: "Browser" });
  expect(screen.queryByText("Connected")).toBeNull();
  expect(
    (
      screen.getByRole("switch", {
        name: "Browser control",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Set up Chrome" }));
  const guide = screen.getByRole("region", { name: "Connect Chrome" });
  fireEvent.click(
    within(guide).getByRole("button", { name: "Open Chrome extensions" }),
  );
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: "/api/settings/browser/action",
        body: { browser: "chrome", action: "manage" },
      },
    ]),
  );
  expect(screen.queryByText("Connected")).toBeNull();
  await within(guide).findByRole("heading", { name: "Turn on Developer mode" });
  fireEvent.click(within(guide).getByRole("button", { name: "It’s on. Next" }));
  expect(within(guide).getByText(state.extensionPath)).toBeTruthy();
  fireEvent.click(within(guide).getByRole("button", { name: "Open folder" }));
  await waitFor(() =>
    expect(writes.at(-1)?.body).toEqual({
      browser: "chrome",
      action: "folder",
    }),
  );
  await waitFor(() =>
    expect(
      (
        within(guide).getByRole("button", {
          name: "Added. Connect to OpenPI",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(guide).getByRole("button", { name: "Added. Connect to OpenPI" }),
  );
  await within(guide).findByRole("heading", { name: "Connect to OpenPI" });
  expect(writes.at(-1)?.body).toEqual({ browser: "chrome", action: "connect" });
  expect(
    within(guide).queryByRole("button", { name: "Allow OpenPI to use it" }),
  ).toBeNull();
  expect(
    writes.every((write) => write.path === "/api/settings/browser/action"),
  ).toBe(true);
  state.profiles = [
    {
      id: "connection",
      browser: "chrome",
      profileId: "profile",
      extensionId: "extension",
      version: "0.3.0",
      connected: true,
      current: true,
    },
  ];
  fireEvent.focus(window);
  fireEvent.click(
    await within(guide).findByRole("button", {
      name: "Allow OpenPI to use it",
    }),
  );
  await waitFor(() =>
    expect(writes.at(-1)).toEqual({
      path: "/api/settings/browser",
      body: { control: true, externalBrowsers: ["chrome"] },
    }),
  );
  expect(writes.some((write) => write.path.includes("prompt"))).toBe(false);
});

it("keeps a failed native launch on the same step and permits retry", async () => {
  const server = backend();
  server.failActions = true;
  fireEvent.click(await screen.findByRole("button", { name: "Set up Chrome" }));
  const guide = screen.getByRole("region", { name: "Connect Chrome" });
  fireEvent.click(
    within(guide).getByRole("button", { name: "Open Chrome extensions" }),
  );
  await screen.findByRole("alert");
  expect(
    within(guide).getByRole("heading", { name: "Open Chrome extensions" }),
  ).toBeTruthy();
  expect(
    within(guide).queryByRole("heading", { name: "Turn on Developer mode" }),
  ).toBeNull();
  server.failActions = false;
  fireEvent.click(
    within(guide).getByRole("button", { name: "Open Chrome extensions" }),
  );
  await within(guide).findByRole("heading", { name: "Turn on Developer mode" });
  expect(server.writes.every((write) => write.path.endsWith("/action"))).toBe(
    true,
  );
});

it("skips installation without claiming a stale or other-profile embedded connection", async () => {
  const { state, writes } = backend();
  fireEvent.click(
    await screen.findByRole("button", { name: "Set up OpenPI browser" }),
  );
  const guide = screen.getByRole("region", { name: "Connect OpenPI browser" });
  fireEvent.click(
    within(guide).getByRole("button", { name: "Already installed? Connect" }),
  );
  state.profiles = [
    {
      id: "connection",
      browser: "chrome",
      profileId: "profile",
      extensionId: "extension",
      version: "0.2.0",
      connected: true,
      current: true,
    },
  ];
  fireEvent.click(
    within(guide).getByRole("button", { name: "Check connection" }),
  );
  await screen.findByText(/No connection yet/);
  expect(
    within(guide).queryByRole("button", { name: "Allow OpenPI to use it" }),
  ).toBeNull();
  state.profiles[0].version = "0.3.0";
  state.profiles[0].current = false;
  fireEvent.focus(window);
  await screen.findByRole("button", { name: "Manage Chrome" });
  expect(
    within(guide).queryByRole("button", { name: "Allow OpenPI to use it" }),
  ).toBeNull();
  expect(writes).toEqual([]);
});

it("keeps default selection and grants separate, and uses typed settings writes", async () => {
  const { writes } = backend();
  await screen.findByRole("heading", { name: "Browser" });
  fireEvent.click(screen.getByRole("switch", { name: "Allow Chrome" }));
  await waitFor(() =>
    expect(writes[0]?.body).toEqual({ externalBrowsers: ["chrome"] }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("combobox", {
          name: "Default browser",
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Default browser" }), {
    target: { value: "chrome" },
  });
  await waitFor(() =>
    expect(writes[1]?.body).toEqual({ defaultBrowser: "chrome" }),
  );
  expect(
    (
      screen.getByRole("switch", {
        name: "Browser control",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
});

it("only marks the initiating embedded browser connected, while named browsers use their own connection", async () => {
  const state = initial();
  state.profiles = [
    {
      id: "connection",
      browser: "chrome",
      profileId: "profile",
      extensionId: "extension",
      version: "0.3.0",
      connected: true,
      current: false,
    },
  ];
  backend(state);
  await screen.findByRole("button", { name: "Manage Chrome" });
  expect(
    screen.getByRole("button", { name: "Set up OpenPI browser" }),
  ).toBeTruthy();
  expect(screen.getAllByText("Connected")).toHaveLength(1);
});
