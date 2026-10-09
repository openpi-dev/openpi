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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        writes.push({ path: input, body });
        if (input === "/api/settings/browser")
          state.config = { ...state.config, ...body };
      }
      return new Response(JSON.stringify(state));
    }),
  );
  render(
    createElement(BrowserSettingsPanel, { onSaved: vi.fn(async () => true) }),
  );
  return { writes, state };
}

it("separates installation evidence from authorization and guides setup without a model request", async () => {
  const { writes } = backend();
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
    within(guide).getByRole("button", { name: "Open installation" }),
  );
  await waitFor(() =>
    expect(writes).toEqual([
      {
        path: "/api/settings/browser/action",
        body: { browser: "chrome", action: "install" },
      },
    ]),
  );
  expect(screen.queryByText("Connected")).toBeNull();
  expect(writes.some((write) => write.path.includes("prompt"))).toBe(false);
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
