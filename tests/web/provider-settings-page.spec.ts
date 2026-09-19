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
        setupBusy: false,
        modelSelectionPending: false,
        onSelectModel: vi.fn(),
        onConfigureOpenPi: vi.fn(async () => true),
        onPreferencesChanged: vi.fn(async () => true),
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
  let setup = settingsPayload().setup;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes("/api/settings/preferences")) {
      const body = JSON.parse(String(init?.body)) as {
        sessionId: string;
        preferences: {
          theme?: "light" | "dark" | "mist" | "rose" | "pine" | "system";
          chatWidth?: number;
          chatFontSize?: number;
          expandThinking?: boolean;
        };
      };
      setup = {
        ...setup,
        ui: {
          ...setup.ui,
          ...(body.preferences.theme === undefined
            ? {}
            : { webTheme: body.preferences.theme }),
          ...(body.preferences.chatWidth === undefined
            ? {}
            : { webChatWidth: body.preferences.chatWidth }),
          ...(body.preferences.chatFontSize === undefined
            ? {}
            : { webChatFontSize: body.preferences.chatFontSize }),
          ...(body.preferences.expandThinking === undefined
            ? {}
            : { webExpandThinking: body.preferences.expandThinking }),
        },
      };
      return reply({ sessionId: body.sessionId, setup, revision: 2 });
    }
    if (path.includes("/api/settings/catalog")) {
      return reply({ ...settingsPayload(), setup });
    }
    return providerReply();
  });
}

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
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: /DeepSeek V4/u }));
  expect((await screen.findAllByText("DeepSeek")).length).toBeGreaterThan(0);
  expect(screen.getByText(i18n.t("credentialMissing"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("useThisModel") }));
  expect(onSelectModel).toHaveBeenCalledWith("deepseek/deepseek-v4");
  expect(view.container.querySelector(".settings-model-sidebar")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("shows canonical General state and routes real setup/runtime actions", async () => {
  const fetcher = settingsFetcher();
  vi.stubGlobal("fetch", fetcher);
  const onOpenRuntimeStatus = vi.fn();
  const onConfigureOpenPi = vi.fn(async () => false);
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
  await waitFor(() =>
    expect(
      within(generalPanel).getByRole<HTMLInputElement>("radio", {
        name: i18n.t("themeDark"),
      }).checked,
    ).toBe(true),
  );
  const preferenceCalls = fetcher.mock.calls.filter(([input]) =>
    String(input).includes("/api/settings/preferences"),
  );
  expect(preferenceCalls).toHaveLength(1);
  expect(JSON.parse(String(preferenceCalls[0]?.[1]?.body))).toEqual({
    sessionId: "session-a",
    preferences: { theme: "dark" },
  });
  expect(onConfigureOpenPi).not.toHaveBeenCalled();
  expect(onPreferencesChanged).toHaveBeenCalledTimes(1);
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
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/api/settings/preferences"),
      ),
    ).toHaveLength(2),
  );
  const expandCall = fetcher.mock.calls.filter(([input]) =>
    String(input).includes("/api/settings/preferences"),
  )[1];
  expect(JSON.parse(String(expandCall?.[1]?.body))).toEqual({
    sessionId: "session-a",
    preferences: { expandThinking: true },
  });
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
