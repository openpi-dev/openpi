// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderSettingsPage } from "../../web/ui/src/features/settings/ProviderSettingsPage.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

it("sorts configured providers first and supports search and status filters", async () => {
  const fetcher = vi.fn(async () =>
    reply({
      providers: [
        {
          id: "amazon-bedrock",
          name: "Amazon Bedrock",
          authMethods: ["api_key"],
          configured: false,
          subscription: false,
          nameTruncated: false,
        },
        {
          id: "codex-local",
          name: "Codex Local",
          authMethods: ["oauth"],
          configured: true,
          subscription: true,
          nameTruncated: false,
        },
        {
          id: "deepseek",
          name: "DeepSeek",
          authMethods: ["api_key"],
          configured: true,
          subscription: false,
          nameTruncated: false,
        },
      ],
      truncation: {
        truncated: false,
        providersOmitted: 0,
        namesTruncated: 0,
        maxProviders: 100,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderSettingsPage, {
        sessionId: "session-a",
        cwd: "/workspace/openpi",
        model: "GPT 5.6 Luna",
        thinkingLevel: "medium",
        onOpenRuntimeStatus: vi.fn(),
        onClose: vi.fn(),
      }),
    ),
  );

  expect(
    await screen.findByText(
      i18n.t("providerConfiguredCount", { configured: 2, total: 3 }),
    ),
  ).toBeTruthy();
  expect(
    Array.from(view.container.querySelectorAll(".provider-row strong")).map(
      (element) => element.textContent,
    ),
  ).toEqual(["Codex Local", "DeepSeek", "Amazon Bedrock"]);

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerFilter_missing") }),
  );
  expect(screen.getByText("Amazon Bedrock")).toBeTruthy();
  expect(screen.queryByText("DeepSeek")).toBeNull();

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerFilter_all") }),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("providerSearchLabel") }),
    { target: { value: "deep" } },
  );
  expect(screen.getByText("DeepSeek")).toBeTruthy();
  expect(screen.queryByText("Amazon Bedrock")).toBeNull();
  expect(screen.getByText(i18n.t("providerAuth_api_key"))).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("runtimeStatus") }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("providerSettings") }),
  );
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("providerSearchLabel"),
    }).value,
  ).toBe("deep");
  expect(screen.getByText("DeepSeek")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("refreshes provider status and closes with Escape", async () => {
  const fetcher = vi.fn(async () =>
    reply({
      providers: [],
      truncation: {
        truncated: false,
        providersOmitted: 0,
        namesTruncated: 0,
        maxProviders: 100,
      },
    }),
  );
  const onClose = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderSettingsPage, {
        sessionId: "session-a",
        cwd: "/workspace/openpi",
        model: "GPT 5.6 Luna",
        thinkingLevel: "medium",
        onOpenRuntimeStatus: vi.fn(),
        onClose,
      }),
    ),
  );

  await screen.findByText(
    i18n.t("providerConfiguredCount", { configured: 0, total: 0 }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("refreshStatus") }),
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("keeps provider status inside a navigable settings surface", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      reply({
        providers: [],
        truncation: {
          truncated: false,
          providersOmitted: 0,
          namesTruncated: 0,
          maxProviders: 100,
        },
      }),
    ),
  );
  const onOpenRuntimeStatus = vi.fn();
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderSettingsPage, {
        sessionId: "session-a",
        cwd: "/workspace/openpi",
        model: "GPT 5.6 Luna",
        thinkingLevel: "medium",
        onOpenRuntimeStatus,
        onClose: vi.fn(),
      }),
    ),
  );

  await screen.findByText(
    i18n.t("providerConfiguredCount", { configured: 0, total: 0 }),
  );
  const navigation = screen.getByRole("navigation", {
    name: i18n.t("settingsNavigation"),
  });
  const runtime = navigation.querySelector<HTMLButtonElement>(
    'button[aria-current="page"]',
  );
  expect(runtime?.textContent).toContain(i18n.t("providerSettings"));

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("runtimeStatus") }),
  );
  expect(
    screen.getByRole("heading", { name: i18n.t("runtimeStatus") }),
  ).toBeTruthy();
  expect(screen.getByText("GPT 5.6 Luna")).toBeTruthy();
  expect(screen.getByText("medium")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openRuntimeDetails") }),
  );
  expect(onOpenRuntimeStatus).toHaveBeenCalledTimes(1);

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openPiSettings") }),
  );
  expect(
    screen.getByRole("heading", { name: i18n.t("openPiSettings") }),
  ).toBeTruthy();
  expect(screen.getByText("/openpi-setup")).toBeTruthy();
});
