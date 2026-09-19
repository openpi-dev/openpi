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
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WebModelSummary } from "../../web/protocol/types.ts";
import { ProviderSettingsPage } from "../../web/ui/src/features/settings/ProviderSettingsPage.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

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
  vi.unstubAllGlobals();
});

function reply(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

const models: WebModelSummary[] = [
  {
    provider: "codex-local",
    id: "gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    label: "GPT 5.6 Luna",
    current: true,
  },
  {
    provider: "deepseek",
    id: "deepseek-v4",
    name: "DeepSeek V4",
    label: "DeepSeek V4",
    current: false,
  },
];

function renderSettings(overrides: Record<string, unknown> = {}) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ProviderSettingsPage, {
        sessionId: "session-a",
        cwd: "/workspace/openpi",
        models,
        currentModel: models[0],
        thinkingLevel: "medium",
        theme: "system",
        modelSelectionPending: false,
        onSelectModel: vi.fn(),
        onOpenRuntimeStatus: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
      }),
    ),
  );
}

function providerReply() {
  return reply({
    providers: [
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
        configured: false,
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
  });
}

it("matches the pi-web settings shell and selects models through Pi", async () => {
  const fetcher = vi.fn(async () => providerReply());
  const onSelectModel = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const view = renderSettings({ onSelectModel });

  expect(screen.getByRole("dialog", { name: i18n.t("settings") })).toBeTruthy();
  const tabs = screen.getByRole("tablist", {
    name: i18n.t("settingsNavigation"),
  });
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(3);
  expect(
    screen
      .getByRole("tab", { name: i18n.t("modelSettings") })
      .getAttribute("aria-selected"),
  ).toBe("true");

  expect((await screen.findAllByText("Codex Local")).length).toBeGreaterThan(0);
  expect(screen.getByText(i18n.t("credentialConfigured"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /DeepSeek V4/u }));
  expect((await screen.findAllByText("DeepSeek")).length).toBeGreaterThan(0);
  expect(screen.getByText(i18n.t("credentialMissing"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("useThisModel") }));
  expect(onSelectModel).toHaveBeenCalledWith("deepseek/deepseek-v4");
  expect(view.container.querySelector(".settings-model-sidebar")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps General read-only and routes runtime details to the existing surface", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => providerReply()),
  );
  const onOpenRuntimeStatus = vi.fn();
  const view = renderSettings({ onOpenRuntimeStatus });
  await screen.findAllByText("Codex Local");

  fireEvent.click(screen.getByRole("tab", { name: i18n.t("generalSettings") }));
  const generalPanel = screen.getByRole("tabpanel");
  expect(
    within(generalPanel).getByRole("heading", {
      name: i18n.t("generalSettings"),
    }),
  ).toBeTruthy();
  expect(
    view.container.querySelector('.settings-theme-option[data-selected="true"]')
      ?.textContent,
  ).toContain(i18n.t("themeSystem"));
  expect(within(generalPanel).getByText("GPT 5.6 Luna")).toBeTruthy();
  expect(within(generalPanel).getByText("medium")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openRuntimeDetails") }),
  );
  expect(onOpenRuntimeStatus).toHaveBeenCalledTimes(1);
});

it("refreshes provider status, exposes canonical setup, and closes", async () => {
  const fetcher = vi.fn(async () => providerReply());
  const onClose = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  renderSettings({ onClose });
  await screen.findAllByText("Codex Local");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("refreshStatus") }),
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByRole("tab", { name: i18n.t("openPiSettings") }));
  expect(screen.getByText("/openpi-setup")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
