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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
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
  Reflect.deleteProperty(window, "matchMedia");
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

it("offers current-model native search with no external provider installation", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("webSearchSettings") }),
  );
  await screen.findByText(i18n.t("webSearchDefaultOff"));
  expect(configure).not.toHaveBeenCalled();
  expect(screen.getAllByText(i18n.t("webSearchCurrentModel")).length).toBe(2);
  expect(screen.getByText(i18n.t("webSearchSupported"))).toBeTruthy();
  expect(screen.queryByText("npm:pi-web-access@0.38.0")).toBeNull();
  const enable = screen.getByRole("button", {
    name: i18n.t("webSearchEnable"),
  });
  await waitFor(() =>
    expect((enable as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(enable);
  expect(configure).toHaveBeenCalledWith(i18n.t("webSearchNativeRequest"));
});

it("keeps the feature preference separate from current-model support and legacy packages", async () => {
  const payload = settingsPayload();
  payload.setup.webSearch.enabled = true;
  payload.webSearch.available = false;
  vi.stubGlobal("fetch", settingsFetcher(payload));
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("webSearchSettings") }),
  );
  await screen.findByText(i18n.t("webSearchUnsupported"));
  fireEvent.click(
    await screen.findByRole("button", { name: i18n.t("webSearchDisable") }),
  );
  expect(configure).toHaveBeenCalledWith(i18n.t("webSearchDisableRequest"));
});

function settingsPayload() {
  return {
    sessionId: "session-a",
    webSearch: {
      available: true,
      provider: "codex-local",
      model: "gpt-5.6-luna",
    },
    setup: {
      webSearch: { enabled: false },
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

function settingsFetcher(payload = settingsPayload()) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/api/settings/preferences")) {
      const patch = JSON.parse(String(init?.body));
      Object.assign(payload.setup.ui, {
        ...(patch.theme !== undefined ? { webTheme: patch.theme } : {}),
        ...(patch.chatWidth !== undefined
          ? { webChatWidth: patch.chatWidth }
          : {}),
        ...(patch.chatFontSize !== undefined
          ? { webChatFontSize: patch.chatFontSize }
          : {}),
        ...(patch.expandThinking !== undefined
          ? { webExpandThinking: patch.expandThinking }
          : {}),
        ...Object.fromEntries(
          [
            "subagentResultDisplay",
            "bashToolDisplay",
            "fileMutationDisplay",
            "customFooter",
            "footerStyle",
          ]
            .filter((key) => patch[key] !== undefined)
            .map((key) => [key, patch[key]]),
        ),
      });
      return reply({ saved: true, setup: payload.setup });
    }
    if (path.includes("/api/settings/catalog")) {
      return reply(payload);
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
  fireEvent.click(
    within(screen.getByRole("tabpanel")).getByText(
      i18n.t("advancedResourceConfiguration"),
    ),
  );
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

it("reviews an exact plugin source and scope without claiming installation or reusing an old setup failure", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const configure = vi.fn(async () => true);
  renderSettings({
    onConfigureOpenPi: configure,
    setupOutcome: {
      requestId: "old",
      status: "failed",
      error: "Old unrelated failure",
    },
  });
  await screen.findByText(i18n.t("agentBehavior"));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("pluginsSettings") }));
  expect(screen.queryByText("Old unrelated failure")).toBeNull();
  const panel = within(screen.getByRole("tabpanel"));
  fireEvent.click(panel.getByRole("button", { name: i18n.t("addPlugin") }));
  const source = "npm:@fixture/plugin@1.2.3";
  fireEvent.change(panel.getByLabelText(i18n.t("resourcePackageSource")), {
    target: { value: source },
  });
  fireEvent.change(panel.getByLabelText(i18n.t("scope")), {
    target: { value: "project" },
  });
  fireEvent.click(
    panel.getByRole("button", {
      name: i18n.t("configureViaSetup"),
    }),
  );
  await screen.findByText(i18n.t("resourceRequestSubmitted"));
  expect(configure).toHaveBeenCalledWith(
    i18n.t("setupResourceInstallRequest", {
      kind: i18n.t("pluginsSettings"),
      source: JSON.stringify(source),
      scope: "project",
    }),
  );
  expect(
    (panel.getByLabelText(i18n.t("resourcePackageSource")) as HTMLInputElement)
      .value,
  ).toBe(source);
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("skillsSettings") }));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("pluginsSettings") }));
  expect(
    (
      within(screen.getByRole("tabpanel")).getByLabelText(
        i18n.t("resourcePackageSource"),
      ) as HTMLInputElement
    ).value,
  ).toBe(source);
});

it("keeps disabled package configuration distinct from still-loaded Session resources", async () => {
  const payload = settingsPayload();
  Object.assign(payload.resources.plugins[0]!, {
    configured: true,
    installed: true,
    enabled: false,
    installedVersion: "1.2.3",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply(payload)),
  );
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("pluginsSettings") }));
  const panel = within(screen.getByRole("tabpanel"));
  expect(
    panel.getAllByText(i18n.t("pluginState_disabled")).length,
  ).toBeGreaterThan(0);
  expect(panel.getByText("1.2.3")).toBeTruthy();
  expect(
    panel.getByText(i18n.t("pluginLoadedResources", { count: 3 })),
  ).toBeTruthy();
  fireEvent.click(
    panel.getByRole("button", {
      name: i18n.t("pluginAction_enable"),
    }),
  );
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("setupPluginOperationRequest", {
        action: "enable",
        source: JSON.stringify("openpi"),
        path: JSON.stringify("/workspace/openpi"),
        scope: "user",
      }),
    ),
  );
  expect(
    panel.getAllByText(i18n.t("pluginState_disabled")).length,
  ).toBeGreaterThan(0);
});

it("filters skill bulk requests by scope and search while preserving the native invocation state", async () => {
  const payload = settingsPayload();
  const base = payload.resources.skills[0]!;
  payload.resources.skills.push(
    {
      ...base,
      id: "project:one",
      name: "review-one",
      filePath: "/project/skills/one/SKILL.md",
      scope: "project",
    },
    {
      ...base,
      id: "project:two",
      name: "review-two",
      filePath: "/project/skills/two/SKILL.md",
      scope: "project",
    },
    Object.assign(
      {
        ...base,
        id: "project:truncated",
        name: "review-truncated",
        filePath: "/project/truncated",
        scope: "project" as const,
      },
      { canManage: false },
    ),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply(payload)),
  );
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("skillsSettings") }));
  const panel = within(screen.getByRole("tabpanel"));
  fireEvent.change(panel.getByLabelText(i18n.t("filterResourceScope")), {
    target: { value: "project" },
  });
  fireEvent.change(panel.getByRole("searchbox"), {
    target: { value: "review" },
  });
  expect(panel.queryByRole("button", { name: /subagents/ })).toBeNull();
  fireEvent.click(
    panel.getByRole("button", {
      name: i18n.t("disableVisibleSkills", { count: 2 }),
    }),
  );
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("setupSkillsBulkRequest", {
        paths: JSON.stringify([
          "/project/skills/one/SKILL.md",
          "/project/skills/two/SKILL.md",
        ]),
        disabled: true,
      }),
    ),
  );
  expect(
    panel.getByText(i18n.t("availableToModel"), { selector: "dd" }),
  ).toBeTruthy();
  fireEvent.click(panel.getByRole("button", { name: /review-truncated/ }));
  expect(panel.getByText(i18n.t("resourceTargetTruncated"))).toBeTruthy();
  expect(
    panel.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("removeResource"),
    }).disabled,
  ).toBe(true);
  fireEvent.change(panel.getByRole("searchbox"), {
    target: { value: "does-not-exist" },
  });
  expect(
    panel.queryByRole("button", {
      name: i18n.t("disableVisibleSkills", { count: 2 }),
    }),
  ).toBeNull();
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
  expect(onConfigureOpenPi).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).includes("/api/settings/preferences"),
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(onPreferencesChanged).toHaveBeenCalledOnce());
  expect(
    within(generalPanel).getByRole<HTMLInputElement>("radio", {
      name: i18n.t("themeDark"),
    }).checked,
  ).toBe(true);
  expect(screen.getByText(i18n.t("settingsPreferencesSaved"))).toBeTruthy();
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
  await waitFor(() => expect(onPreferencesChanged).toHaveBeenCalledTimes(2));
  expect(onConfigureOpenPi).not.toHaveBeenCalled();
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

it("saves appearance during an active turn without invoking setup", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const configure = vi.fn(async () => true);
  const view = renderSettings({
    setupBusy: true,
    onConfigureOpenPi: configure,
  });
  await screen.findByText(i18n.t("agentBehavior"));
  expect(screen.getByText(i18n.t("settingsSetupBusyHint"))).toBeTruthy();
  const theme = screen.getByRole<HTMLInputElement>("radio", {
    name: i18n.t("themeDark"),
  });
  expect(theme.disabled).toBe(false);
  expect(
    screen.getByRole<HTMLInputElement>("switch", {
      name: i18n.t("expandThinkingByDefault"),
    }).disabled,
  ).toBe(false);
  fireEvent.click(theme);
  await screen.findByText(i18n.t("settingsPreferencesSaved"));
  expect(configure).not.toHaveBeenCalled();
  view.rerender(
    settingsElement({ setupBusy: false, onConfigureOpenPi: configure }),
  );
  expect(theme.disabled).toBe(false);
  expect(screen.queryByText(i18n.t("settingsSetupBusyHint"))).toBeNull();
});

it("restores sliders to persisted values when a direct save fails", async () => {
  const payload = settingsPayload();
  payload.setup.ui.webChatWidth = 1200;
  payload.setup.ui.webChatFontSize = 18;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/api/settings/preferences")
        ? new Response(JSON.stringify({ error: "failed" }), { status: 422 })
        : reply(payload),
    ),
  );
  const configure = vi.fn(async () => false);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  const resetWidth = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("resetChatContentWidth"),
  });
  await waitFor(() => expect(resetWidth.disabled).toBe(false));
  fireEvent.click(resetWidth);
  await screen.findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(configure).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen
        .getByRole("slider", { name: i18n.t("chatContentWidth") })
        .getAttribute("aria-valuenow"),
    ).toBe("1200"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("resetChatFontSize") }),
  );
  expect(configure).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(
      screen
        .getByRole("slider", { name: i18n.t("chatFontSize") })
        .getAttribute("aria-valuenow"),
    ).toBe("18"),
  );
});

it("saves every result display and footer control through presentation preferences, with failed saves preserving the canonical value", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  for (const label of ["subagentResults", "bashOperations", "fileMutations"]) {
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: i18n.t(label),
    });
    fireEvent.change(select, { target: { value: "full" } });
    await waitFor(() => expect(select.value).toBe("full"));
    await waitFor(() => expect(select.disabled).toBe(false));
  }
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("terminalFooterStyle") }),
    { target: { value: "powerline-mono" } },
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: i18n.t("terminalFooterStyle"),
      }).value,
    ).toBe("powerline-mono"),
  );
  fireEvent.click(
    screen.getByRole("switch", { name: i18n.t("terminalFooter") }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: i18n.t("terminalFooterStyle"),
      }).disabled,
    ).toBe(true),
  );
  expect(configure).not.toHaveBeenCalled();
  expect(
    fetcher.mock.calls.filter(([input]) =>
      String(input).includes("/api/settings/preferences"),
    ),
  ).toHaveLength(5);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "read-only configuration" }), {
          status: 422,
        }),
    ),
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("bashOperations") }),
    { target: { value: "compact" } },
  );
  await screen.findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", {
      name: i18n.t("bashOperations"),
    }).value,
  ).toBe("full");
});

it("routes agent controls through canonical setup and waits for a save receipt", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  const discovery = screen.getByRole<HTMLSelectElement>("combobox", {
    name: i18n.t("capabilityDiscovery"),
  });
  fireEvent.change(discovery, { target: { value: "adaptive" } });
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("setupRequestDiscovery", { mode: "adaptive" }),
    ),
  );
  expect(discovery.value).toBe("explicit");
  const concurrency = screen.getByRole<HTMLInputElement>("spinbutton", {
    name: i18n.t("workflowConcurrency"),
  });
  fireEvent.change(concurrency, { target: { value: "9" } });
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("bashOperations") }),
    { target: { value: "full" } },
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: i18n.t("bashOperations"),
      }).value,
    ).toBe("full"),
  );
  expect(concurrency.value).toBe("9");
  fireEvent.submit(concurrency.closest("form")!);
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("setupRequestLimits", { concurrency: 9, calls: 64 }),
    ),
  );
  expect(
    fetcher.mock.calls.filter(([input]) =>
      String(input).includes("/api/settings/preferences"),
    ),
  ).toHaveLength(1);
});

it("explains unresolved message admission instead of asking the user to keep waiting", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings({ setupBlockedReason: i18n.t("setupResolveAdmission") });
  await screen.findByText(i18n.t("agentBehavior"));
  expect(screen.getByText(i18n.t("setupResolveAdmission"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("settingsSetupBusyHint"))).toBeNull();
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: i18n.t("themeDark") })
      .disabled,
  ).toBe(false);
});

it("switches sections through the compact settings picker", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings();
  fireEvent.change(
    screen.getByRole("combobox", { name: i18n.t("settingsNavigation") }),
    { target: { value: "plugins" } },
  );
  expect(screen.getByRole("tabpanel").id).toBe("settings-panel-plugins");
  expect(
    screen
      .getByRole("tab", { name: i18n.t("pluginsSettings") })
      .getAttribute("aria-selected"),
  ).toBe("true");
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

it("refreshes saved settings on the receipt before the model finishes its reply", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const onConfigureOpenPi = vi.fn(async () => true);
  const onPreferencesChanged = vi.fn(async () => true);
  const props = {
    onConfigureOpenPi,
    onPreferencesChanged,
    setupOutcome: { requestId: "previous", status: "saved" },
  };
  const view = renderSettings(props);
  await screen.findByText(i18n.t("agentBehavior"));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("configureOpenPi") }),
    );
  });
  view.rerender(settingsElement({ ...props, setupBusy: true }));
  expect(onPreferencesChanged).not.toHaveBeenCalled();
  view.rerender(
    settingsElement({
      ...props,
      setupBusy: true,
      setupOutcome: { requestId: "current", status: "saved" },
    }),
  );
  await waitFor(() => expect(onPreferencesChanged).toHaveBeenCalledOnce());
  expect(screen.getByText(i18n.t("setupOutcome_saved"))).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("configureOpenPi"),
    }).disabled,
  ).toBe(true);
  view.rerender(
    settingsElement({
      ...props,
      setupBusy: false,
      setupOutcome: { requestId: "current", status: "saved" },
    }),
  );
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

it.each(["planning", "ready", "invalid"])(
  "allows display settings in %s while requiring Plan exit for agent configuration",
  async (plan) => {
    const payload = settingsPayload();
    payload.setup.ui.webChatWidth = 1200;
    payload.setup.ui.webChatFontSize = 18;
    const fallback = settingsFetcher();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/api/settings/catalog")
          ? reply(payload)
          : fallback(input, init),
      ),
    );
    const onConfigureOpenPi = vi.fn(async () => true);
    const onExitPlan = vi.fn(async () => {});
    const props = { plan, onConfigureOpenPi, onExitPlan };
    const view = renderSettings(props);
    await screen.findByText("1200px");
    await screen.findByText("18px");
    await screen.findByText(i18n.t("agentBehavior"));
    const theme = () =>
      screen.getByRole<HTMLInputElement>("radio", {
        name: i18n.t("themeDark"),
      });
    expect(theme().disabled).toBe(false);
    for (const name of [
      "resetChatContentWidth",
      "resetChatFontSize",
    ] as const) {
      const reset = screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t(name),
      });
      expect(reset.disabled).toBe(false);
    }
    fireEvent.click(theme());
    await screen.findByText(i18n.t("settingsPreferencesSaved"));
    expect(onConfigureOpenPi).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("planModeExit") }),
    );
    expect(onExitPlan).toHaveBeenCalledOnce();
    expect(theme().disabled).toBe(false);
    fireEvent.click(
      screen.getByRole("tab", { name: i18n.t("skillsSettings") }),
    );
    expect(await screen.findByText("Delegate a bounded task.")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("tab", { name: i18n.t("generalSettings") }),
    );
    view.rerender(settingsElement({ ...props, plan: "inactive" }));
    expect(theme().disabled).toBe(false);
    expect(onConfigureOpenPi).not.toHaveBeenCalled();
  },
);

it("requires idle state before exiting Plan and shows terminal setup receipts on reopening", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const view = renderSettings({
    plan: "planning",
    setupBusy: true,
    onExitPlan: vi.fn(),
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("planModeExit"),
    }).disabled,
  ).toBe(true);
  expect(screen.getByText(i18n.t("setupPlanBusy"))).toBeTruthy();
  for (const status of [
    "saved",
    "unchanged",
    "failed",
    "cancelled",
    "unconfirmed",
  ] as const) {
    view.rerender(
      settingsElement({
        plan: "inactive",
        setupOutcome: {
          requestId: "receipt",
          status,
          ...(status === "failed" ? { error: "Recovery incomplete" } : {}),
        },
      }),
    );
    expect(screen.getByText(i18n.t(`setupOutcome_${status}`))).toBeTruthy();
    if (status === "failed")
      expect(screen.getByRole("alert").textContent).toContain(
        "Recovery incomplete",
      );
  }
});
