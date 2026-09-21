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
  vi.useRealTimers();
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

function settingsElement(overrides: Record<string, unknown> = {}) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ProviderSettingsPage, {
      sessionId: "session-a",
      cwd: "/workspace/openpi",
      models,
      currentModel: models[0],
      thinkingLevel: "medium",
      theme: "system",
      setupBusy: false,
      modelSelectionPending: false,
      onSelectModel: vi.fn(),
      onConfigureOpenPi: vi.fn(async () => true),
      onPreferencesChanged: vi.fn(async () => true),
      onOpenRuntimeStatus: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    }),
  );
}

function renderSettings(overrides: Record<string, unknown> = {}) {
  return render(settingsElement(overrides));
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

function settingsPayload() {
  return {
    sessionId: "session-a",
    setup: {
      capabilities: { discovery: "explicit" },
      suggestions: { enabled: false },
      workflows: { concurrency: 6, maxAgentCalls: 64 },
      ui: {
        webTheme: "system",
        webChatWidth: 820,
        webChatFontSize: 14,
        webExpandThinking: false,
        showHeader: false,
        customFooter: true,
        footerStyle: "plain",
        subagentResultDisplay: "compact",
        bashToolDisplay: "compact",
        fileMutationDisplay: "compact",
      },
      postEditConfigured: false,
      subagents: {
        roleModels: {
          explorer: { provider: "codex-local", model: "gpt-5.6-luna" },
        },
      },
    },
    resources: {
      skills: [
        {
          id: "openpi:subagents",
          name: "subagents",
          description: "Delegate a bounded task.",
          filePath: "/workspace/openpi/skills/subagents/SKILL.md",
          source: "openpi",
          scope: "user",
          origin: "package",
          disableModelInvocation: false,
        },
      ],
      plugins: [
        {
          id: "user:package:openpi",
          source: "openpi",
          scope: "user",
          origin: "package",
          baseDir: "/workspace/openpi",
          extensions: [
            {
              name: "subagents",
              path: "/workspace/openpi/extensions/subagents/index.ts",
              toolCount: 2,
              commandCount: 1,
            },
          ],
          skills: ["subagents"],
          prompts: [],
          themes: ["openpi"],
        },
      ],
      totals: { extensions: 1, skills: 1, prompts: 0, themes: 1 },
      diagnostics: { extensionErrors: 0, skillErrors: 0 },
      truncation: {
        truncated: false,
        skillsOmitted: 0,
        pluginsOmitted: 0,
        resourcesOmitted: 0,
      },
    },
  };
}

function settingsFetcher() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/api/settings/catalog")) {
      return reply(settingsPayload());
    }
    if (path.includes("/api/models/configuration"))
      return reply({ revision: "revision", models: [] });
    return providerReply();
  });
}

it("supports arrow, Home and End navigation with one tabbable settings tab", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings();
  const general = screen.getByRole("tab", { name: i18n.t("generalSettings") });
  general.focus();
  fireEvent.keyDown(general, { key: "ArrowRight" });
  const modelsTab = screen.getByRole("tab", { name: i18n.t("modelSettings") });
  expect(modelsTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(modelsTab);
  fireEvent.keyDown(modelsTab, { key: "End" });
  const plugins = screen.getByRole("tab", { name: i18n.t("pluginsSettings") });
  expect(document.activeElement).toBe(plugins);
  fireEvent.keyDown(plugins, { key: "Home" });
  expect(document.activeElement).toBe(general);
  expect(
    screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0),
  ).toHaveLength(1);
});

it("preserves an unfinished model configuration when changing settings tabs", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings();
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  const address = await screen.findByRole("textbox", {
    name: i18n.t("modelConfig_baseUrl"),
  });
  fireEvent.change(address, { target: { value: "http://localhost:12345/v1" } });
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("skillsSettings") }));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  expect(
    (
      screen.getByRole("textbox", {
        name: i18n.t("modelConfig_baseUrl"),
      }) as HTMLInputElement
    ).value,
  ).toBe("http://localhost:12345/v1");
});

it("saves a write-only key directly to Pi without submitting a setup prompt", async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = settingsFetcher();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push({
          path: String(input),
          body: JSON.parse(String(init.body)),
        });
        return reply({ saved: true });
      }
      return fetcher(input);
    }),
  );
  const configure = vi.fn(async () => true);
  const refreshed = vi.fn(async () => true);
  renderSettings({
    onConfigureOpenPi: configure,
    onPreferencesChanged: refreshed,
  });
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  await screen.findByText(i18n.t("credentialConfigured"));
  fireEvent.change(screen.getByLabelText(i18n.t("provider")), {
    target: { value: "deepseek" },
  });
  const input = screen.getByLabelText(
    i18n.t("providerApiKey"),
  ) as HTMLInputElement;
  expect(input.type).toBe("password");
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { value: "fixture-private-key" } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveProviderKey") }),
  );
  await screen.findByText(i18n.t("providerKeySaved"));
  expect(input.value).toBe("");
  expect(requests).toEqual([
    {
      path: "/api/providers/api-key",
      body: {
        sessionId: "session-a",
        provider: "deepseek",
        apiKey: "fixture-private-key",
      },
    },
  ]);
  expect(configure).not.toHaveBeenCalled();
  expect(refreshed).toHaveBeenCalled();
});

it("submits role and skill changes through the canonical setup entry", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("subagentsSettings") }),
  );
  fireEvent.change(screen.getByLabelText(i18n.t("workflowConcurrencyLabel")), {
    target: { value: "3" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("configureViaSetup") }),
  );
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(expect.stringContaining("3")),
  );
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("skillsSettings") }));
  fireEvent.change(
    within(screen.getByRole("tabpanel")).getByLabelText(
      i18n.t("setupConfigurationRequest"),
    ),
    { target: { value: "Configure the local skill" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("configureViaSetup") }),
  );
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith("Configure the local skill"),
  );
});

it("matches the pi-web settings shell and selects models through Pi", async () => {
  const fetcher = settingsFetcher();
  const onSelectModel = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const view = renderSettings({ onSelectModel });

  expect(screen.getByRole("dialog", { name: i18n.t("settings") })).toBeTruthy();
  const tabs = screen.getByRole("tablist", {
    name: i18n.t("settingsNavigation"),
  });
  expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(5);
  expect(
    screen
      .getByRole("tab", { name: i18n.t("generalSettings") })
      .getAttribute("aria-selected"),
  ).toBe("true");

  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  expect((await screen.findAllByText("Codex Local")).length).toBeGreaterThan(0);
  expect(screen.getByText(i18n.t("credentialConfigured"))).toBeTruthy();
  expect(
    view.container.querySelector(".provider-connection-card"),
  ).toBeTruthy();
  expect(screen.getByText(i18n.t("providerAccessSubscription"))).toBeTruthy();
  expect(
    screen.getAllByText(i18n.t("providerReadOnly")).length,
  ).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("generalSettings") }));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: /DeepSeek V4/u }));
  expect((await screen.findAllByText("DeepSeek")).length).toBeGreaterThan(0);
  expect(screen.getByText(i18n.t("credentialMissing"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("useThisModel") }));
  expect(onSelectModel).toHaveBeenCalledWith("deepseek/deepseek-v4");
  expect(view.container.querySelector(".settings-model-sidebar")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("shows canonical General state and routes real setup/runtime actions", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const onOpenRuntimeStatus = vi.fn();
  const onConfigureOpenPi = vi.fn(async () => true);
  const onPreferencesChanged = vi.fn(async () => true);
  const view = renderSettings({
    onOpenRuntimeStatus,
    onConfigureOpenPi,
    onPreferencesChanged,
  });
  await screen.findByText(i18n.t("agentBehavior"));
  expect(
    fetcher.mock.calls.filter(([input]) =>
      String(input).includes("/api/providers/auth-status"),
    ),
  ).toHaveLength(0);

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
  expect(within(generalPanel).getAllByRole("radio")).toHaveLength(6);
  expect(
    within(generalPanel)
      .getByRole("slider", {
        name: i18n.t("chatContentWidth"),
      })
      .getAttribute("aria-valuenow"),
  ).toBe("820");
  expect(
    within(generalPanel)
      .getByRole("slider", {
        name: i18n.t("chatFontSize"),
      })
      .getAttribute("aria-valuenow"),
  ).toBe("14");
  expect(within(generalPanel).getByText("GPT 5.6 Luna")).toBeTruthy();
  expect(within(generalPanel).getByText("medium")).toBeTruthy();
  expect(within(generalPanel).getByText(/6 concurrent/u)).toBeTruthy();
  fireEvent.click(
    within(generalPanel).getByRole("radio", { name: i18n.t("themeDark") }),
  );
  expect(
    within(generalPanel).getByRole<HTMLInputElement>("radio", {
      name: i18n.t("themeDark"),
    }).checked,
  ).toBe(false);
  expect(
    within(generalPanel).getByRole<HTMLInputElement>("radio", {
      name: i18n.t("themeSystem"),
    }).checked,
  ).toBe(true);
  expect(onConfigureOpenPi).toHaveBeenCalledWith(
    i18n.t("setupRequestSetTheme", { value: "dark" }),
  );
  expect(
    fetcher.mock.calls.some(([input]) =>
      String(input).includes("/api/settings/preferences"),
    ),
  ).toBe(false);
  expect(onPreferencesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: i18n.t("settings") })).toBeTruthy();
  await waitFor(() =>
    expect(
      within(generalPanel).getByRole<HTMLInputElement>("switch", {
        name: i18n.t("expandThinkingByDefault"),
      }).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(generalPanel).getByRole("switch", {
      name: i18n.t("expandThinkingByDefault"),
    }),
  );
  await waitFor(() => expect(onConfigureOpenPi).toHaveBeenCalledTimes(2));
  expect(onConfigureOpenPi).toHaveBeenLastCalledWith(
    i18n.t("setupRequestEnableExpandedThinking"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openRuntimeDetails") }),
  );
  expect(onOpenRuntimeStatus).toHaveBeenCalledTimes(1);
});

it("keeps an accepted OpenPI setup request inside the settings dialog", async () => {
  const fetcher = settingsFetcher();
  const onConfigureOpenPi = vi.fn(async () => true);
  vi.stubGlobal("fetch", fetcher);
  renderSettings({ onConfigureOpenPi });
  await screen.findByText(i18n.t("agentBehavior"));

  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("configureOpenPi") }),
  );

  await waitFor(() => expect(onConfigureOpenPi).toHaveBeenCalledTimes(1));
  expect(onConfigureOpenPi).toHaveBeenCalledWith(
    i18n.t("setupRequestReviewAll"),
  );
  expect(screen.getByRole("dialog", { name: i18n.t("settings") })).toBeTruthy();
  expect(screen.getByText(i18n.t("setupRequestAccepted"))).toBeTruthy();
});

it("waits for a running setup request to settle before refreshing", async () => {
  const fetcher = settingsFetcher();
  const onConfigureOpenPi = vi.fn(async () => true);
  const onPreferencesChanged = vi.fn(async () => true);
  vi.stubGlobal("fetch", fetcher);
  const view = renderSettings({ onConfigureOpenPi, onPreferencesChanged });
  await screen.findByText(i18n.t("agentBehavior"));
  vi.useFakeTimers();

  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("configureOpenPi") }),
    );
    await Promise.resolve();
  });
  view.rerender(
    settingsElement({
      onConfigureOpenPi,
      onPreferencesChanged,
      setupBusy: true,
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(2_100);
  });
  expect(onPreferencesChanged).not.toHaveBeenCalled();

  view.rerender(
    settingsElement({
      onConfigureOpenPi,
      onPreferencesChanged,
      setupBusy: false,
    }),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(onPreferencesChanged).toHaveBeenCalledOnce();
});

it("renders Pi skills, subagent roles, plugins, refreshes, and closes", async () => {
  const fetcher = settingsFetcher();
  const onClose = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  renderSettings({ onClose });
  await screen.findByText(i18n.t("agentBehavior"));

  fireEvent.click(screen.getByRole("tab", { name: i18n.t("skillsSettings") }));
  expect(await screen.findByText("Delegate a bounded task.")).toBeTruthy();
  expect(
    screen.getAllByText(i18n.t("resourceScope_user")).length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("/skill:subagents")).toBeTruthy();

  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("subagentsSettings") }),
  );
  expect(
    screen.getAllByText("codex-local/gpt-5.6-luna").length,
  ).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole("tab", { name: i18n.t("pluginsSettings") }));
  expect(
    screen.getByText("/workspace/openpi/extensions/subagents/index.ts"),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("refreshStatus") }),
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/api/settings/catalog"),
      ),
    ).toHaveLength(2),
  );
  expect(
    fetcher.mock.calls.filter(([input]) =>
      String(input).includes("/api/providers/auth-status"),
    ),
  ).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
