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
import type {
  WebModelSummary,
  WebSettingsCatalog,
} from "../../web/protocol/types.ts";
import { AppearanceSettingsPanel } from "../../web/ui/src/features/settings/AppearanceSettingsPanel.tsx";
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

function openAppearance(advanced = false) {
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("appearance") }));
  if (advanced)
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("appearanceAdvanced") }),
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

it("offers current-model native search with no external provider installation", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("webSearchSettings") }),
  );
  await screen.findByText(i18n.t("webSearchDefaultOff"));
  expect(configure).not.toHaveBeenCalled();
  expect(
    screen.getByRole("heading", {
      name: i18n.t("webSearchCurrentModel"),
      level: 2,
    }),
  ).toBeTruthy();
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
        webAppearance: {
          palette: "default",
          accent: "",
          background: "",
          foreground: "",
          font: "system",
        },
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
        ...(patch.appearance !== undefined
          ? {
              webAppearance: {
                ...payload.setup.ui.webAppearance,
                ...patch.appearance,
              },
            }
          : {}),
        ...(patch.chatWidth !== undefined
          ? { webChatWidth: patch.chatWidth }
          : {}),
        ...(patch.chatFontSize !== undefined
          ? { webChatFontSize: patch.chatFontSize }
          : {}),
        ...(patch.expandThinking !== undefined
          ? { webExpandThinking: patch.expandThinking }
          : {}),
        ...(patch.followUpBehavior !== undefined
          ? { webFollowUpBehavior: patch.followUpBehavior }
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

function configurationPayload() {
  const base = settingsPayload();
  return {
    ...base,
    responseSupport: { verbosity: true, reasoningSummary: true },
    thinking: {
      supported: true,
      level: "medium",
      available: ["off", "low", "medium", "high", "max"],
    },
    setup: {
      ...base.setup,
      response: { verbosity: "default", reasoningSummary: "default" },
      ui: { ...base.setup.ui, webHiddenThinkingLevels: [] as string[] },
    },
  };
}

it("C12 aborts a previous model's catalog and rejects its late capabilities in the same Session", async () => {
  const first = configurationPayload();
  const second = configurationPayload();
  second.responseSupport = { verbosity: false, reasoningSummary: false };
  let release = (_reply: Response) => {};
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const firstRequest: { signal?: AbortSignal | null } = {};
  let reads = 0;
  const fetcher = settingsFetcher();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/settings/catalog")) {
        if (++reads === 1) {
          firstRequest.signal = init?.signal;
          return held;
        }
        return Promise.resolve(reply(second));
      }
      return fetcher(input, init);
    }),
  );
  const view = renderSettings();
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  view.rerender(settingsElement({ currentModel: models[1] }));
  const verbosity = await screen.findByRole<HTMLButtonElement>("button", {
    name: i18n.t("configurationVerbosity"),
  });
  expect(firstRequest.signal?.aborted).toBe(true);
  expect(verbosity.disabled).toBe(true);
  await act(async () => release(reply(first)));
  expect(verbosity.disabled).toBe(true);
  expect(
    screen.getByText(i18n.t("configurationResponsesUnavailable")),
  ).toBeTruthy();
});

it("C01-C08 surfaces unreadable canonical configuration and recovers only after a successful refresh", async () => {
  const payload = {
    ...configurationPayload(),
    setupWritable: false,
    setupDiagnostics: [
      {
        severity: "error",
        path: "response.verbosity",
        message: "Invalid persisted value",
      },
    ],
  };
  vi.stubGlobal("fetch", settingsFetcher(payload));
  renderSettings();
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  await screen.findByText("response.verbosity: Invalid persisted value");
  expect(
    screen.queryByRole("button", { name: i18n.t("configurationVerbosity") }),
  ).toBeNull();
  payload.setupWritable = true;
  payload.setupDiagnostics = [];
  fireEvent.click(
    within(screen.getByRole("tabpanel")).getByRole("button", {
      name: i18n.t("refreshStatus"),
    }),
  );
  expect(
    (
      await screen.findByRole<HTMLButtonElement>("button", {
        name: i18n.t("configurationVerbosity"),
      })
    ).disabled,
  ).toBe(false);
});

it("C01 shows configuration loading without claiming defaults or sandbox capability", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  expect(screen.getByRole("status").textContent).toBe(
    i18n.t("settingsCatalogLoading"),
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("configurationVerbosity") }),
  ).toBeNull();
  expect(
    screen.queryByText(i18n.t("configurationSandboxUnavailable")),
  ).toBeNull();
  expect(configure).not.toHaveBeenCalled();
});

it("C06 keeps accepted response setup distinct from a saved canonical value and blocks duplicate submission", async () => {
  vi.stubGlobal("fetch", settingsFetcher(configurationPayload()));
  const configure = vi.fn(async () => true);
  const view = renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  const verbosity = await screen.findByRole<HTMLButtonElement>("button", {
    name: i18n.t("configurationVerbosity"),
  });
  fireEvent.click(verbosity);
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: (name) => name.startsWith(i18n.t("configurationVerbosity_high")),
    }),
  );
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("configurationVerbosityRequest", { value: "high" }),
    ),
  );
  expect(verbosity.textContent).toContain(
    i18n.t("configurationVerbosity_default"),
  );
  expect(verbosity.disabled).toBe(true);
  expect(screen.getByText(i18n.t("setupRequestAccepted"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("setupOutcome_saved"))).toBeNull();
  view.rerender(
    settingsElement({
      onConfigureOpenPi: configure,
      setupOutcome: {
        requestId: "new-configuration",
        status: "failed",
        error: "Fixture setup canceled",
      },
    }),
  );
  await screen.findByText("Fixture setup canceled");
  await waitFor(() => expect(verbosity.disabled).toBe(false));
  expect(verbosity.textContent).toContain(
    i18n.t("configurationVerbosity_default"),
  );
  expect(configure).toHaveBeenCalledTimes(1);
});

it("C06-C10 blocks already-open choices when the live Session becomes busy", async () => {
  const fetcher = vi.fn(settingsFetcher(configurationPayload()));
  vi.stubGlobal("fetch", fetcher);
  const configure = vi.fn(async () => true);
  const view = renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n.t("configurationVerbosity"),
    }),
  );
  const high = await screen.findByRole("menuitem", {
    name: (name) => name.startsWith(i18n.t("configurationVerbosity_high")),
  });
  view.rerender(
    settingsElement({ setupBusy: true, onConfigureOpenPi: configure }),
  );
  expect(high.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(high);
  expect(configure).not.toHaveBeenCalled();

  fireEvent.keyDown(high, { key: "Escape" });
  view.rerender(
    settingsElement({ setupBusy: false, onConfigureOpenPi: configure }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("configurationReasoningLevels"),
    }),
  );
  const max = await screen.findByRole("menuitemcheckbox", { name: "max" });
  view.rerender(
    settingsElement({ setupBusy: true, onConfigureOpenPi: configure }),
  );
  expect(max.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(max);
  expect(max.getAttribute("aria-checked")).toBe("true");
  expect(
    fetcher.mock.calls.some(([input]) =>
      String(input).includes("/api/settings/preferences"),
    ),
  ).toBe(false);
});

it("C08 retains a failed reasoning display preference and retries through the presentation endpoint", async () => {
  const payload = configurationPayload();
  const fetcher = settingsFetcher(payload);
  let fail = true;
  const patches: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/settings/preferences")) {
        const patch = JSON.parse(String(init?.body));
        patches.push(patch);
        if (fail)
          return new Response(
            JSON.stringify({ error: "Fixture save failure" }),
            { status: 500 },
          );
        payload.setup.ui.webHiddenThinkingLevels = [
          patch.thinkingLevelVisibility.level,
        ];
        return reply({ saved: true, setup: payload.setup });
      }
      return fetcher(input, init);
    }),
  );
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n.t("configurationReasoningLevels"),
    }),
  );
  const max = await screen.findByRole("menuitemcheckbox", {
    name: "max",
  });
  fireEvent.click(max);
  await screen.findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(max.getAttribute("aria-checked")).toBe("true");
  expect(payload.setup.ui.webHiddenThinkingLevels).toEqual([]);
  fail = false;
  fireEvent.click(max);
  await screen.findByText(i18n.t("settingsPreferencesSaved"));
  expect(max.getAttribute("aria-checked")).toBe("false");
  expect(patches).toEqual([
    { thinkingLevelVisibility: { level: "max", visible: false } },
    { thinkingLevelVisibility: { level: "max", visible: false } },
  ]);
  expect(configure).not.toHaveBeenCalled();
});

it("C10 disables unsupported response controls and never offers editable permission or installer policies", async () => {
  const payload = configurationPayload();
  payload.responseSupport = { verbosity: false, reasoningSummary: false };
  vi.stubGlobal("fetch", settingsFetcher(payload));
  const runtime = vi.fn();
  renderSettings({ onOpenRuntimeStatus: runtime });
  fireEvent.click(
    screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
  );
  expect(
    (
      await screen.findByRole<HTMLButtonElement>("button", {
        name: i18n.t("configurationVerbosity"),
      })
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("configurationSummary"),
    }).disabled,
  ).toBe(true);
  expect(screen.getByText(i18n.t("configurationPiPermissions"))).toBeTruthy();
  expect(
    screen.getByText(i18n.t("configurationSandboxUnavailable")),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: i18n.t("configurationApproval") }),
  ).toBeNull();
  expect(
    screen.queryByRole("switch", { name: i18n.t("configurationDependencies") }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("configurationRuntimeStatus") }),
  );
  expect(runtime).toHaveBeenCalledOnce();
});

it.each(["failed", "cancelled", "unconfirmed"] as const)(
  "C07-C08 displays a %s setup receipt ahead of an unrelated presentation success",
  async (status) => {
    vi.stubGlobal("fetch", settingsFetcher(configurationPayload()));
    const configure = vi.fn(async () => true);
    const view = renderSettings({ onConfigureOpenPi: configure });
    fireEvent.click(
      screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: i18n.t("configurationVerbosity"),
      }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: (name) => name.startsWith(i18n.t("configurationVerbosity_high")),
      }),
    );
    await screen.findByText(i18n.t("setupRequestAccepted"));
    openAppearance();
    fireEvent.click(screen.getByRole("radio", { name: i18n.t("themeDark") }));
    await screen.findByText(i18n.t("settingsPreferencesSaved"));
    fireEvent.click(
      screen.getByRole("tab", { name: i18n.t("configurationSettings") }),
    );
    view.rerender(
      settingsElement({
        onConfigureOpenPi: configure,
        setupOutcome: { requestId: "configuration-terminal", status },
      }),
    );
    await screen.findByText(i18n.t(`setupOutcome_${status}`));
    expect(screen.queryByText(i18n.t("settingsPreferencesSaved"))).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("configurationVerbosity"),
      }).textContent,
    ).toContain(i18n.t("configurationVerbosity_default"));
  },
);

it("supports arrow, Home and End navigation with one tabbable settings tab", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings();
  const general = screen.getByRole("tab", { name: i18n.t("generalSettings") });
  general.focus();
  fireEvent.keyDown(general, { key: "ArrowDown" });
  const appearance = screen.getByRole("tab", { name: i18n.t("appearance") });
  expect(appearance.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(appearance);
  fireEvent.keyDown(appearance, { key: "End" });
  const browser = screen.getByRole("tab", { name: i18n.t("browserSettings") });
  expect(document.activeElement).toBe(browser);
  fireEvent.keyDown(browser, { key: "Home" });
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
  fireEvent.click(screen.getByRole("button", { name: i18n.t("builtInRoles") }));
  fireEvent.click(
    screen.getByRole("menuitemradio", {
      name: i18n.t("subagentRole_reviewer"),
    }),
  );
  expect(
    screen.getByRole("heading", {
      name: i18n.t("subagentRole_reviewer"),
      level: 2,
    }),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText(i18n.t("workflowConcurrencyLabel")), {
    target: { value: "3" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("configureViaSetup") }),
  );
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      expect.stringMatching(/reviewer.*3/u),
    ),
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

it("filters settings by translated setting names and preserves the active page until a result is chosen", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings();
  await screen.findByText(i18n.t("agentBehavior"));
  const search = screen.getByRole("searchbox", {
    name: i18n.t("settingsSearch"),
  });
  fireEvent.change(search, { target: { value: i18n.t("appearanceFont") } });
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(
    screen.getByRole("heading", { name: i18n.t("generalSettings") }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("appearance") }));
  expect(new URL(window.location.href).searchParams.get("settings")).toBe(
    "appearance",
  );
  expect((search as HTMLInputElement).value).toBe("");
  fireEvent.change(search, { target: { value: "unmatched-setting-xyz" } });
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.getByText(i18n.t("settingsNoResults"))).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("settingsClearSearch") }),
  );
  expect(screen.getAllByRole("tab")).toHaveLength(10);
});

it.each([
  { language: "en", queries: ["runtime", "version", "build"] },
  { language: "zh", queries: ["运行信息", "版本", "构建"] },
])(
  "finds runtime information from settings search in $language",
  async ({ language, queries }) => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage(language);
    try {
      vi.stubGlobal("fetch", settingsFetcher());
      renderSettings({ entry: "appearance" });
      const search = screen.getByRole("searchbox", {
        name: i18n.t("settingsSearch"),
      });
      for (const query of queries) {
        fireEvent.change(search, { target: { value: query } });
        fireEvent.click(
          screen.getByRole("tab", { name: i18n.t("generalSettings") }),
        );
        expect(
          screen.getByRole("region", { name: i18n.t("runtimeIdentity") }),
        ).toBeTruthy();
        expect((search as HTMLInputElement).value).toBe("");
      }
    } finally {
      cleanup();
      await i18n.changeLanguage(previousLanguage);
    }
  },
);

it.each([
  { setupWritable: false, settingsErrors: 0 },
  { setupWritable: true, settingsErrors: 1 },
])(
  "blocks unreadable appearance preferences and recovers after refresh: %j",
  ({ setupWritable, settingsErrors }) => {
    const catalog = settingsPayload() as WebSettingsCatalog;
    const onRefresh = vi.fn();
    const onUpdatePreferences = vi.fn(async () => true);
    const element = (unreadable: boolean) =>
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AppearanceSettingsPanel, {
          catalog: {
            ...catalog,
            setupWritable: unreadable ? setupWritable : true,
            resources: {
              ...catalog.resources,
              diagnostics: {
                ...catalog.resources.diagnostics,
                settingsErrors: unreadable ? settingsErrors : 0,
              },
            },
          },
          theme: "system",
          pending: false,
          error: null,
          onRefresh,
          onUpdatePreferences,
        }),
      );
    const view = render(element(true));
    expect(screen.getByRole("alert").textContent).toContain(
      i18n.t("configurationReadFailure"),
    );
    for (const radio of screen.getAllByRole<HTMLInputElement>("radio"))
      expect(radio.disabled).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("radio", {
        name: i18n.t("themeMist"),
      }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: i18n.t("appearanceBackground"),
      }).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
    );
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onUpdatePreferences).not.toHaveBeenCalled();
    view.rerender(element(false));
    expect(screen.queryByRole("alert")).toBeNull();
    const dark = screen.getByRole<HTMLInputElement>("radio", {
      name: i18n.t("themeDark"),
    });
    expect(dark.disabled).toBe(false);
    fireEvent.click(dark);
    expect(onUpdatePreferences).toHaveBeenCalledWith({ theme: "dark" });
  },
);

it.each([
  { menu: "appearanceAccent", option: "appearanceAccent1", readonly: false },
  { menu: "appearanceFont", option: "appearanceFont_serif", readonly: false },
  { menu: "appearanceFont", option: "appearanceFont_serif", readonly: true },
])(
  "blocks an already-open appearance menu after pending/read-only changes: %j",
  async ({ menu, option, readonly }) => {
    const catalog = settingsPayload() as WebSettingsCatalog;
    const onUpdatePreferences = vi.fn(async () => true);
    const element = (blocked: boolean) =>
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AppearanceSettingsPanel, {
          catalog: {
            ...catalog,
            setupWritable: !(blocked && readonly),
          },
          theme: "system",
          pending: blocked && !readonly,
          error: null,
          onRefresh: vi.fn(),
          onUpdatePreferences,
        }),
      );
    const view = render(element(false));
    fireEvent.click(screen.getByRole("button", { name: i18n.t(menu) }));
    const choice = await screen.findByRole("menuitem", {
      name: i18n.t(option),
    });
    view.rerender(element(true));
    expect(choice.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(choice);
    fireEvent.keyDown(choice, { key: "Enter" });
    expect(onUpdatePreferences).not.toHaveBeenCalled();
  },
);

it("sends only the edited appearance field or mode, including legacy themes", async () => {
  const catalog = settingsPayload() as WebSettingsCatalog;
  catalog.setup.ui.webTheme = "pine";
  const onUpdatePreferences = vi.fn(async () => true);
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(AppearanceSettingsPanel, {
        catalog,
        theme: "pine",
        pending: false,
        error: null,
        onRefresh: vi.fn(),
        onUpdatePreferences,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("appearanceFont") }),
  );
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: i18n.t("appearanceFont_serif"),
    }),
  );
  expect(onUpdatePreferences).toHaveBeenLastCalledWith({
    appearance: { font: "serif" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("appearanceBackground") }),
    { target: { value: "#112233" } },
  );
  expect(onUpdatePreferences).toHaveBeenLastCalledWith({
    appearance: { background: "#112233" },
  });
  fireEvent.click(screen.getByRole("radio", { name: i18n.t("themeMist") }));
  expect(onUpdatePreferences).toHaveBeenLastCalledWith({
    appearance: { palette: "mist" },
  });
  fireEvent.click(screen.getByRole("radio", { name: i18n.t("themeLight") }));
  expect(onUpdatePreferences).toHaveBeenLastCalledWith({ theme: "light" });
});

it("saves palette cards through the existing writer and keeps the saved palette after a failed write", async () => {
  const fallback = settingsFetcher();
  let fail = false;
  let finishWrite: (() => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/settings/preferences")) {
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
        if (fail)
          return new Response(JSON.stringify({ error: "failed" }), {
            status: 422,
          });
      }
      return fallback(input, init);
    }),
  );
  const view = renderSettings();
  await screen.findByText(i18n.t("agentBehavior"));
  openAppearance();
  const group = () =>
    within(screen.getByRole("radiogroup", { name: i18n.t("appearanceTheme") }));
  expect(group().getAllByRole("radio")).toHaveLength(4);
  fireEvent.click(group().getByRole("radio", { name: i18n.t("themeMist") }));
  await waitFor(() => expect(finishWrite).toBeTypeOf("function"));
  for (const radio of group().getAllByRole<HTMLInputElement>("radio"))
    expect(radio.disabled).toBe(true);
  await act(async () => finishWrite?.());
  await waitFor(() =>
    expect(
      group().getByRole<HTMLInputElement>("radio", {
        name: i18n.t("themeMist"),
      }).checked,
    ).toBe(true),
  );
  view.unmount();
  renderSettings();
  await screen.findByText(i18n.t("agentBehavior"));
  openAppearance();
  expect(
    group().getByRole<HTMLInputElement>("radio", { name: i18n.t("themeMist") })
      .checked,
  ).toBe(true);
  fail = true;
  finishWrite = undefined;
  fireEvent.click(group().getByRole("radio", { name: i18n.t("themeRose") }));
  await waitFor(() => expect(finishWrite).toBeTypeOf("function"));
  await act(async () => finishWrite?.());
  await screen.findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(
    group().getByRole<HTMLInputElement>("radio", { name: i18n.t("themeMist") })
      .checked,
  ).toBe(true);
  expect(
    group().getByRole<HTMLInputElement>("radio", { name: i18n.t("themeRose") })
      .checked,
  ).toBe(false);
});

it("validates and cancels theme imports without writes; a failed valid import keeps its draft and saved mode", async () => {
  const fallback = settingsFetcher();
  const save = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "failed" }), { status: 422 }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/settings/preferences")
        ? save()
        : fallback(input, init),
    ),
  );
  renderSettings();
  await screen.findByText(i18n.t("agentBehavior"));
  openAppearance();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("appearanceImport") }),
  );
  let dialog = screen.getByRole("dialog", { name: i18n.t("appearanceImport") });
  const input = within(dialog).getByRole("textbox");
  fireEvent.change(input, {
    target: {
      value:
        '{"version":1,"theme":"dark","appearance":{"palette":"default","accent":"red","background":"","foreground":"","font":"system"}}',
    },
  });
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", {
      name: i18n.t("appearanceImportAction"),
    }).disabled,
  ).toBe(true);
  fireEvent.click(
    within(dialog).getByRole("button", { name: i18n.t("cancel") }),
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("appearanceImport") }),
  );
  dialog = screen.getByRole("dialog", { name: i18n.t("appearanceImport") });
  expect(
    (within(dialog).getByRole("textbox") as HTMLTextAreaElement).value,
  ).toBe("");
  const valid = JSON.stringify({
    version: 1,
    theme: "dark",
    appearance: {
      palette: "pine",
      accent: "#AABBCC",
      background: "",
      foreground: "",
      font: "serif",
    },
  });
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: valid },
  });
  fireEvent.submit(dialog.querySelector("form")!);
  await within(dialog).findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(save).toHaveBeenCalledOnce();
  expect(
    (within(dialog).getByRole("textbox") as HTMLTextAreaElement).value,
  ).toBe(valid);
  fireEvent.click(
    within(dialog).getByRole("button", { name: i18n.t("cancel") }),
  );
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: i18n.t("themeSystem") })
      .checked,
  ).toBe(true);
});

it("commits only complete color values and rolls a failed change back to canonical color", async () => {
  const fallback = settingsFetcher();
  const save = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "failed" }), { status: 422 }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/api/settings/preferences")
        ? save()
        : fallback(input, init),
    ),
  );
  renderSettings();
  await screen.findByText(i18n.t("agentBehavior"));
  openAppearance();
  const color = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("appearanceBackground"),
  });
  fireEvent.change(color, { target: { value: "#AB" } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.blur(color);
  expect(color.value).toBe("#FFFFFF");
  fireEvent.change(color, { target: { value: "#AABBCC" } });
  await screen.findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(save).toHaveBeenCalledOnce();
  await waitFor(() => expect(color.value).toBe("#FFFFFF"));
});

it.each(["color", "width", "fontSize"])(
  "preserves a newer canonical %s when an earlier appearance save fails",
  async (field) => {
    const catalog = settingsPayload() as WebSettingsCatalog;
    catalog.setup.ui.webChatWidth = 1200;
    catalog.setup.ui.webChatFontSize = 18;
    const save = Promise.withResolvers<boolean>();
    const onUpdatePreferences = vi.fn(() => save.promise);
    const element = (current: WebSettingsCatalog, pending: boolean) =>
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AppearanceSettingsPanel, {
          catalog: current,
          theme: "system",
          pending,
          error: null,
          onRefresh: vi.fn(),
          onUpdatePreferences,
        }),
      );
    const view = render(element(catalog, false));
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("appearanceAdvanced") }),
    );
    const color = screen.getByRole<HTMLInputElement>("textbox", {
      name: i18n.t("appearanceBackground"),
    });
    if (field === "color")
      fireEvent.change(color, { target: { value: "#AABBCC" } });
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: i18n.t(
            field === "width" ? "resetChatContentWidth" : "resetChatFontSize",
          ),
        }),
      );
    expect(onUpdatePreferences).toHaveBeenCalledOnce();
    const newer = structuredClone(catalog);
    newer.setup.ui.webAppearance = {
      ...newer.setup.ui.webAppearance!,
      background: "#112233",
    };
    newer.setup.ui.webChatWidth = 1500;
    newer.setup.ui.webChatFontSize = 20;
    view.rerender(element(newer, true));
    expect(color.value).toBe("#112233");
    await act(async () => save.resolve(false));
    expect(color.value).toBe("#112233");
    expect(
      screen
        .getByRole("slider", { name: i18n.t("chatContentWidth") })
        .getAttribute("aria-valuenow"),
    ).toBe("1500");
    expect(
      screen
        .getByRole("slider", { name: i18n.t("chatFontSize") })
        .getAttribute("aria-valuenow"),
    ).toBe("20");
  },
);

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
  fireEvent.click(panel.getByRole("button", { name: i18n.t("scope") }));
  fireEvent.click(
    panel.getByRole("menuitemradio", {
      name: i18n.t("resourceScope_project"),
    }),
  );
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
  fireEvent.click(
    panel.getByRole("button", { name: i18n.t("filterResourceScope") }),
  );
  fireEvent.click(
    panel.getByRole("menuitemradio", {
      name: i18n.t("resourceScope_project"),
    }),
  );
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

it("saves the follow-up behavior in General without starting a setup or model request", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const onConfigureOpenPi = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi });
  const queue = await screen.findByRole<HTMLInputElement>("radio", {
    name: i18n.t("followUpQueue"),
  });
  expect(queue.checked).toBe(true);
  const steer = screen.getByRole<HTMLInputElement>("radio", {
    name: i18n.t("followUpSteer"),
  });
  fireEvent.click(steer);
  await waitFor(() => expect(steer.checked).toBe(true));
  expect(
    fetcher.mock.calls.some(
      ([input, init]) =>
        String(input).includes("/api/settings/preferences") &&
        JSON.parse(String(init?.body)).followUpBehavior === "steer",
    ),
  ).toBe(true);
  expect(onConfigureOpenPi).not.toHaveBeenCalled();
});

it("shows canonical General state and routes real setup/runtime actions", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const onOpenRuntimeStatus = vi.fn();
  const onConfigureOpenPi = vi.fn(async () => true);
  const onPreferencesChanged = vi.fn(async () => true);
  renderSettings({
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
    within(generalPanel).queryByRole("radiogroup", {
      name: i18n.t("appearanceMode"),
    }),
  ).toBeNull();
  expect(within(generalPanel).getByText("GPT 5.6 Luna")).toBeTruthy();
  expect(within(generalPanel).getByText("medium")).toBeTruthy();
  expect(within(generalPanel).getByText(/6 concurrent/u)).toBeTruthy();
  openAppearance();
  const appearancePanel = screen.getByRole("tabpanel");
  expect(
    within(
      within(appearancePanel).getByRole("radiogroup", {
        name: i18n.t("appearanceMode"),
      }),
    ).getAllByRole("radio"),
  ).toHaveLength(3);
  expect(within(appearancePanel).queryByRole("slider")).toBeNull();
  fireEvent.click(
    within(appearancePanel).getByRole("radio", { name: i18n.t("themeDark") }),
  );
  expect(
    within(appearancePanel).getByRole<HTMLInputElement>("radio", {
      name: i18n.t("themeDark"),
    }).checked,
  ).toBe(false);
  expect(
    within(appearancePanel).getByRole<HTMLInputElement>("radio", {
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
    within(appearancePanel).getByRole<HTMLInputElement>("radio", {
      name: i18n.t("themeDark"),
    }).checked,
  ).toBe(true);
  expect(screen.getByText(i18n.t("settingsPreferencesSaved"))).toBeTruthy();
  expect(screen.getByRole("dialog", { name: i18n.t("settings") })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("appearanceAdvanced") }),
  );
  expect(
    screen
      .getByRole("slider", { name: i18n.t("chatContentWidth") })
      .getAttribute("aria-valuenow"),
  ).toBe("820");
  expect(
    screen
      .getByRole("slider", { name: i18n.t("chatFontSize") })
      .getAttribute("aria-valuenow"),
  ).toBe("14");
  await waitFor(() =>
    expect(
      within(appearancePanel).getByRole<HTMLInputElement>("switch", {
        name: i18n.t("expandThinkingByDefault"),
      }).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(appearancePanel).getByRole("switch", {
      name: i18n.t("expandThinkingByDefault"),
    }),
  );
  await waitFor(() => expect(onPreferencesChanged).toHaveBeenCalledTimes(2));
  expect(onConfigureOpenPi).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("generalSettings") }));
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
  openAppearance(true);
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
  openAppearance(true);
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
    const select = screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t(label),
    });
    fireEvent.click(select);
    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: i18n.t("detailDisplay_full"),
      }),
    );
    await waitFor(() =>
      expect(select.textContent).toBe(i18n.t("detailDisplay_full")),
    );
    await waitFor(() => expect(select.disabled).toBe(false));
  }
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("terminalFooterStyle") }),
  );
  fireEvent.click(
    screen.getByRole("menuitemradio", { name: "Powerline Mono" }),
  );
  const footerStyle = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("terminalFooterStyle"),
  });
  await waitFor(() => expect(footerStyle.textContent).toBe("Powerline Mono"));
  fireEvent.click(
    screen.getByRole("switch", { name: i18n.t("terminalFooter") }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
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
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("bashOperations") }),
  );
  fireEvent.click(
    screen.getByRole("menuitemradio", {
      name: i18n.t("detailDisplay_compact"),
    }),
  );
  await screen.findByText(i18n.t("settingsPreferencesSaveFailed"));
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("bashOperations"),
    }).textContent,
  ).toBe(i18n.t("detailDisplay_full"));
});

it("routes agent controls through canonical setup and waits for a save receipt", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const configure = vi.fn(async () => true);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  const concurrency = screen.getByRole<HTMLInputElement>("spinbutton", {
    name: i18n.t("workflowConcurrency"),
  });
  await waitFor(() => expect(concurrency.value).toBe("6"));
  fireEvent.change(concurrency, { target: { value: "9" } });
  expect(concurrency.value).toBe("9");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("bashOperations") }),
  );
  fireEvent.click(
    screen.getByRole("menuitemradio", {
      name: i18n.t("detailDisplay_full"),
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("bashOperations"),
      }).textContent,
    ).toBe(i18n.t("detailDisplay_full")),
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
  openAppearance();
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
    await screen.findByText(i18n.t("agentBehavior"));
    openAppearance(true);
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
    openAppearance();
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
