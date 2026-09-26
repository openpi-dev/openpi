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
  await waitFor(() =>
    expect((address as HTMLInputElement).disabled).toBe(false),
  );
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

it("opens the credentials entry in Models and focuses the provider controls", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings({ entry: "credentials" });
  expect(screen.getByRole("tabpanel").id).toBe("settings-panel-models");
  const provider = await screen.findByRole("combobox", {
    name: i18n.t("provider"),
  });
  await waitFor(() => expect(document.activeElement).toBe(provider));
});

it("confirms leaving a model draft and preserves it after cancel", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const onClose = vi.fn();
  renderSettings({ onClose });
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  const address = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_baseUrl"),
  });
  await waitFor(() => expect(address.disabled).toBe(false));
  fireEvent.change(address, { target: { value: "http://localhost:12345/v1" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("keepEditing") }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(address.value).toBe("http://localhost:12345/v1");
  fireEvent.click(screen.getByRole("button", { name: i18n.t("close") }));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("discardAndContinue") }),
  );
  expect(onClose).toHaveBeenCalledOnce();
});

it("guards runtime navigation even while the edited model tab is hidden", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const onOpenRuntimeStatus = vi.fn();
  renderSettings({ onOpenRuntimeStatus });
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  const address = await screen.findByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_baseUrl"),
  });
  await waitFor(() => expect(address.disabled).toBe(false));
  fireEvent.change(address, { target: { value: "http://localhost:12345/v1" } });
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("generalSettings") }));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openRuntimeDetails") }),
  );
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(onOpenRuntimeStatus).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("discardAndContinue") }),
  );
  expect(onOpenRuntimeStatus).toHaveBeenCalledOnce();
});

it("confirms a model provider change before discarding an unsent credential", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  renderSettings({ currentModel: models[1], entry: "credentials" });
  const credential = await screen.findByLabelText<HTMLInputElement>(
    i18n.t("providerApiKey"),
  );
  fireEvent.change(credential, { target: { value: "unsent-fixture-key" } });
  fireEvent.click(screen.getByRole("button", { name: /GPT 5.6 Luna/u }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(screen.getByText(i18n.t("unsavedCredentialTitle"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("keepEditing") }));
  expect(credential.value).toBe("unsent-fixture-key");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "DeepSeek V4",
  );
  fireEvent.click(screen.getByRole("button", { name: /GPT 5.6 Luna/u }));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("discardAndContinue") }),
  );
  expect(screen.queryByLabelText(i18n.t("providerApiKey"))).toBeNull();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "GPT 5.6 Luna",
  );
});

it("blocks dismissal and provider changes until a credential save settles", async () => {
  const fallback = settingsFetcher();
  let finishSave: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishSave = resolve;
        });
      return fallback(input);
    }),
  );
  const onClose = vi.fn();
  renderSettings({ currentModel: models[1], onClose, entry: "credentials" });
  const credential = await screen.findByLabelText(i18n.t("providerApiKey"));
  fireEvent.change(credential, { target: { value: "submitted-fixture-key" } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveProviderKey") }),
  );
  const close = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("close"),
  });
  expect(close.disabled).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: /GPT 5.6 Luna/u })
      .disabled,
  ).toBe(true);
  fireEvent(
    close.closest("dialog")!,
    new Event("cancel", { cancelable: true }),
  );
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(finishSave).toBeDefined());
  await act(async () => {
    finishSave?.(reply({ saved: true }));
  });
  await waitFor(() => expect(close.disabled).toBe(false));
  fireEvent.click(close);
  expect(onClose).toHaveBeenCalledOnce();
});

it("retains an unsent credential when a model save refreshes provider status", async () => {
  const fallback = settingsFetcher();
  const savedModel = {
    provider: "deepseek",
    id: "deepseek-v4",
    name: "DeepSeek V4",
    baseUrl: "http://localhost:12345/v1",
    api: "openai-responses",
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
  };
  let persisted = false;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/models/configuration")) {
        if (init?.method === "POST") {
          persisted = true;
          return reply({ saved: true });
        }
        return reply({
          revision: persisted ? "saved" : "initial",
          models: persisted ? [savedModel] : [],
        });
      }
      return fallback(input);
    },
  );
  vi.stubGlobal("fetch", fetcher);
  renderSettings({ currentModel: models[1], entry: "credentials" });
  const credential = await screen.findByLabelText<HTMLInputElement>(
    i18n.t("providerApiKey"),
  );
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: i18n.t("modelConfig_baseUrl"),
  });
  await waitFor(() => expect(address.disabled).toBe(false));
  fireEvent.change(credential, { target: { value: "unsent-fixture-key" } });
  fireEvent.change(address, { target: { value: savedModel.baseUrl } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  await screen.findByText(i18n.t("modelConfigurationSaved"));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/api/providers/auth"),
      ),
    ).toHaveLength(2),
  );
  expect(screen.getByLabelText(i18n.t("providerApiKey"))).toBe(credential);
  expect(credential.value).toBe("unsent-fixture-key");
});

it.each([false, true])(
  "selects a newly saved model while preferences refresh is pending (credential draft: %s)",
  async (credentialDraft) => {
    const fallback = settingsFetcher();
    const savedModel = {
      provider: "fixture",
      id: "new-model",
      name: "New fixture model",
      baseUrl: "http://localhost:12345/v1",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 16384,
    };
    let persisted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/models/configuration")) {
          if (init?.method === "POST") {
            persisted = true;
            return reply({ saved: true });
          }
          return reply({
            revision: persisted ? "saved" : "initial",
            models: persisted ? [savedModel] : [],
          });
        }
        return fallback(input);
      }),
    );
    let finishRefresh: ((result: boolean) => void) | undefined;
    const onPreferencesChanged = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    renderSettings({ onPreferencesChanged });
    fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
    const address = await screen.findByRole<HTMLInputElement>("textbox", {
      name: i18n.t("modelConfig_baseUrl"),
    });
    await waitFor(() => expect(address.disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("addModel") }));
    let credential: HTMLInputElement | undefined;
    if (credentialDraft) {
      fireEvent.change(
        await screen.findByRole("combobox", { name: i18n.t("provider") }),
        { target: { value: "deepseek" } },
      );
      credential = screen.getByLabelText<HTMLInputElement>(
        i18n.t("providerApiKey"),
      );
      fireEvent.change(credential, { target: { value: "unsent-fixture-key" } });
    }
    for (const field of ["provider", "id", "name", "baseUrl"] as const)
      fireEvent.change(
        screen.getByRole("textbox", { name: i18n.t(`modelConfig_${field}`) }),
        { target: { value: savedModel[field] } },
      );
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
    );
    if (credentialDraft) {
      await screen.findByRole("alertdialog");
      expect(credential?.value).toBe("unsent-fixture-key");
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        i18n.t("addModel"),
      );
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("keepEditing") }),
      );
      expect(credential?.value).toBe("unsent-fixture-key");
      fireEvent.click(
        screen.getByRole("button", { name: /New fixture model/u }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("discardAndContinue") }),
      );
    }
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
        savedModel.name,
      ),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("close") })
        .disabled,
    ).toBe(true);
    await act(async () => {
      finishRefresh?.(true);
    });
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("close") })
          .disabled,
      ).toBe(false),
    );
  },
);

it("keeps the inspected provider when external model removal needs credential confirmation", async () => {
  const fallback = settingsFetcher();
  const configuredModel = {
    provider: "deepseek",
    id: "configuration-only",
    name: "Removed external model",
    baseUrl: "http://localhost:12345/v1",
    api: "openai-responses",
    reasoning: true,
    contextWindow: 128000,
    maxTokens: 16384,
  };
  let removed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/models/configuration")) {
        if (init?.method === "POST") {
          removed = true;
          return new Response(
            JSON.stringify({
              code: "MODEL_CONFIGURATION_CONFLICT",
              error: "conflict",
            }),
            { status: 409 },
          );
        }
        return reply({
          revision: removed ? "removed" : "initial",
          models: removed ? [] : [configuredModel],
        });
      }
      return fallback(input);
    }),
  );
  renderSettings({ entry: "credentials" });
  fireEvent.click(
    await screen.findByRole("button", { name: /Removed external model/u }),
  );
  const credential = await screen.findByLabelText<HTMLInputElement>(
    i18n.t("providerApiKey"),
  );
  fireEvent.change(credential, { target: { value: "unsent-fixture-key" } });
  fireEvent.change(
    screen.getByRole("textbox", { name: i18n.t("modelConfig_name") }),
    { target: { value: "My model draft" } },
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("saveModelConfiguration") }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: i18n.t("reloadModelConfiguration"),
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("discardAndReload") }),
  );
  await screen.findByText(i18n.t("unsavedCredentialTitle"));
  expect(credential.value).toBe("unsent-fixture-key");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    configuredModel.name,
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("keepEditing") }));
  expect(screen.getByLabelText(i18n.t("providerApiKey"))).toBe(credential);
  expect(credential.value).toBe("unsent-fixture-key");
  fireEvent.click(screen.getByRole("button", { name: /GPT 5.6 Luna/u }));
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("discardAndContinue") }),
  );
  expect(screen.queryByLabelText(i18n.t("providerApiKey"))).toBeNull();
});

it("disables using another model during a running session", async () => {
  vi.stubGlobal("fetch", settingsFetcher());
  const onSelectModel = vi.fn();
  renderSettings({ setupBusy: true, onSelectModel });
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  fireEvent.click(screen.getByRole("button", { name: /DeepSeek V4/u }));
  const useModel = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("useThisModel"),
  });
  expect(useModel.disabled).toBe(true);
  expect(screen.getByText(i18n.t("modelSelectionBusy"))).toBeTruthy();
  fireEvent.click(useModel);
  expect(onSelectModel).not.toHaveBeenCalled();
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

it("keeps configured models editable before their credentials make them available", async () => {
  const fallback = settingsFetcher();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/models/configuration"))
        return reply({
          revision: "configuration-only",
          models: [
            {
              provider: "unconnected",
              id: "model",
              name: "Configured before login",
              baseUrl: "http://localhost:12345/v1",
              api: "openai-responses",
              reasoning: true,
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        });
      return fallback(input);
    }),
  );
  renderSettings();
  fireEvent.click(screen.getByRole("tab", { name: i18n.t("modelSettings") }));
  fireEvent.click(
    await screen.findByRole("button", { name: /Configured before login/ }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: i18n.t("modelConfig_name"),
      }).value,
    ).toBe("Configured before login"),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("unavailable"),
    }).disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("saveModelConfiguration"),
    }).disabled,
  ).toBe(false);
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

it("explains why appearance changes are unavailable during an active turn", async () => {
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
  expect(theme.disabled).toBe(true);
  expect(
    screen.getByRole<HTMLInputElement>("switch", {
      name: i18n.t("expandThinkingByDefault"),
    }).disabled,
  ).toBe(true);
  fireEvent.click(theme);
  expect(configure).not.toHaveBeenCalled();
  view.rerender(
    settingsElement({ setupBusy: false, onConfigureOpenPi: configure }),
  );
  expect(theme.disabled).toBe(false);
  expect(screen.queryByText(i18n.t("settingsSetupBusyHint"))).toBeNull();
});

it("restores chat appearance through setup and rolls back a rejected request", async () => {
  const payload = settingsPayload();
  payload.setup.ui.webChatWidth = 1200;
  payload.setup.ui.webChatFontSize = 18;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reply(payload)),
  );
  const configure = vi.fn(async () => false);
  renderSettings({ onConfigureOpenPi: configure });
  await screen.findByText(i18n.t("agentBehavior"));
  const resetWidth = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("resetChatContentWidth"),
  });
  await waitFor(() => expect(resetWidth.disabled).toBe(false));
  fireEvent.click(resetWidth);
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("setupRequestSetChatWidth", { value: 820 }),
    ),
  );
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
  await waitFor(() =>
    expect(configure).toHaveBeenCalledWith(
      i18n.t("setupRequestSetChatFontSize", { value: 14 }),
    ),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("slider", { name: i18n.t("chatFontSize") })
        .getAttribute("aria-valuenow"),
    ).toBe("18"),
  );
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
  ).toBe(true);
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
