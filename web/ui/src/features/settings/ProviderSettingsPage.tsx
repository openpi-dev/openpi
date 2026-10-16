import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import {
  Archive,
  Bot,
  Cpu,
  Globe2,
  Layers3,
  Plug,
  Search,
  Shield,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import { BrowserSettingsPanel } from "./BrowserSettingsPanel.tsx";
import { ConfigurationSettingsPanel } from "./ConfigurationSettingsPanel.tsx";
import { WebSearchSettingsPanel } from "./WebSearchSettingsPanel.tsx";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebCapabilitySnapshot } from "../../../../../extensions/shared/web-observer-registry.ts";
import type {
  WebModelSummary,
  WebSettingsPreferencesPatch,
  WebSnapshot,
  WebThemePreference,
  WebWorkspaceSummary,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";
import { ProviderModelsSection } from "./ProviderModelsSection.tsx";
import {
  GeneralSettingsPanel,
  PluginsSettingsPanel,
  SkillsSettingsPanel,
  SubagentsSettingsPanel,
} from "./SettingsPanels.tsx";
import { useSettingsCatalog } from "./useSettingsCatalog.ts";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel.tsx";
import { ArchivedChatsSettingsPanel } from "./ArchivedChatsSettingsPanel.tsx";

export type SettingsSection =
  | "general"
  | "appearance"
  | "archived-chats"
  | "configuration"
  | "models"
  | "browser"
  | "web-search"
  | "skills"
  | "subagents"
  | "plugins";

const settingsSections = [
  {
    id: "general",
    group: "settingsPersonal",
    label: "generalSettings",
    Icon: SlidersHorizontal,
    terms: ["agentBehavior", "resultDisplay", "workflowLimits"],
  },
  {
    id: "appearance",
    group: "settingsPersonal",
    label: "appearance",
    Icon: Sun,
    terms: [
      "appearanceTheme",
      "appearanceAccent",
      "appearanceFont",
      "chatContentWidth",
      "chatFontSize",
    ],
  },
  {
    id: "archived-chats",
    group: "settingsPersonal",
    label: "settingsArchivedChats",
    Icon: Archive,
    terms: ["restoreConversation"],
  },
  {
    id: "configuration",
    group: "settingsPersonal",
    label: "configurationSettings",
    Icon: Shield,
    terms: [
      "configurationApproval",
      "configurationSandbox",
      "configurationVerbosity",
      "configurationSummary",
      "configurationReasoningLevels",
      "configurationDependencies",
    ],
  },
  {
    id: "models",
    group: "settingsAgent",
    label: "modelSettings",
    Icon: Cpu,
    terms: ["modelDefaultTitle"],
  },
  {
    id: "subagents",
    group: "settingsAgent",
    label: "subagentsSettings",
    Icon: Bot,
    terms: [],
  },
  {
    id: "web-search",
    group: "settingsAgent",
    label: "webSearchSettings",
    Icon: Search,
    terms: [],
  },
  {
    id: "skills",
    group: "settingsIntegrations",
    label: "skillsSettings",
    Icon: Layers3,
    terms: [],
  },
  {
    id: "plugins",
    group: "settingsIntegrations",
    label: "pluginsSettings",
    Icon: Plug,
    terms: [],
  },
  {
    id: "browser",
    group: "settingsIntegrations",
    label: "browserSettings",
    Icon: Globe2,
    terms: [],
  },
] as const;

export function settingsSectionFromUrl(value: string | null) {
  return settingsSections.find(({ id }) => id === value)?.id;
}

export function ProviderSettingsPage({
  sessionId,
  sessionPath,
  cwd,
  entry = "general",
  models,
  currentModel,
  thinkingLevel,
  theme,
  preferences,
  workspaces = [],
  onRestoreSession,
  capabilities,
  setupBusy: sessionBusy,
  setupBlockedReason,
  plan,
  planSelectionPending = false,
  onExitPlan,
  setupOutcome,
  onConfigureOpenPi,
  interaction,
  onPreferencesChanged,
  onSelectModel,
  onOpenRuntimeStatus,
  onClose,
}: {
  sessionId: string;
  sessionPath?: string;
  cwd: string;
  entry?: SettingsSection | "credentials";
  models: WebModelSummary[];
  currentModel?: WebModelSummary;
  thinkingLevel: string;
  theme: WebThemePreference;
  preferences?: WebSnapshot["preferences"];
  workspaces?: WebWorkspaceSummary[];
  onRestoreSession?: (path: string) => Promise<boolean>;
  capabilities?: WebCapabilitySnapshot;
  setupBusy: boolean;
  setupBlockedReason?: string;
  plan?: WebSnapshot["runtime"]["plan"];
  planSelectionPending?: boolean;
  onExitPlan?: () => Promise<void>;
  setupOutcome?: WebSnapshot["runtime"]["setup"];
  modelSelectionPending: boolean;
  onSelectModel: (value: string) => Promise<boolean> | boolean;
  onConfigureOpenPi: (request: string) => Promise<boolean>;
  interaction?: import("react").ReactNode;
  onPreferencesChanged: () => Promise<boolean>;
  onOpenRuntimeStatus: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setupBusy = sessionBusy || Boolean(setupBlockedReason);
  const closeButton = useRef<HTMLButtonElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [section, setSection] = useState<SettingsSection>(
    entry === "credentials" ? "models" : entry,
  );
  const [modelsVisited, setModelsVisited] = useState(
    entry === "credentials" || entry === "models",
  );
  const [setupPending, setSetupPending] = useState(false);
  const [setupSubmitted, setSetupSubmitted] = useState(false);
  const [setupSection, setSetupSection] = useState<SettingsSection>("general");
  const setupRefreshPending = useRef(false);
  const setupObservedBusy = useRef(false);
  const setupRefreshTimer = useRef(0);
  const [preferencePending, setPreferencePending] = useState(false);
  const preferenceInFlight = useRef(false);
  const [preferencesSaved, setPreferencesSaved] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [modelDraftDirty, setModelDraftDirty] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    kind: "close" | "runtime";
  } | null>(null);
  const saving = modelSaving;
  const setupBaseline = useRef<string | undefined>(undefined);
  const planBlocked = plan !== undefined && plan !== "inactive";
  const setupDisabled =
    setupPending || setupBusy || planBlocked || planSelectionPending;
  const currentOutcome =
    (setupSubmitted && setupSection !== section) ||
    (!setupSubmitted &&
      (section === "skills" ||
        section === "plugins" ||
        section === "web-search"))
      ? undefined
      : !setupSubmitted || setupOutcome?.requestId !== setupBaseline.current
        ? setupOutcome
        : undefined;
  const {
    catalog,
    error: catalogError,
    refresh,
    updateSetup,
  } = useSettingsCatalog(
    sessionId,
    currentModel ? `${currentModel.provider}/${currentModel.id}` : "",
    JSON.stringify(preferences),
  );
  const setupNeedsAttention =
    currentOutcome !== undefined &&
    ["failed", "cancelled", "unconfirmed"].includes(currentOutcome.status);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    if (!setupSubmitted) return;
    if (
      currentOutcome &&
      currentOutcome.status !== "pending" &&
      setupRefreshPending.current
    ) {
      setupRefreshPending.current = false;
      setupObservedBusy.current = false;
      window.clearTimeout(setupRefreshTimer.current);
      void refresh();
      void onPreferencesChanged();
      return;
    }
    if (setupBusy) {
      setupObservedBusy.current = true;
      return;
    }
    if (!setupObservedBusy.current || !setupRefreshPending.current) return;
    setupRefreshPending.current = false;
    setupObservedBusy.current = false;
    window.clearTimeout(setupRefreshTimer.current);
    void refresh();
    void onPreferencesChanged();
  }, [
    onPreferencesChanged,
    refresh,
    setupBusy,
    setupSubmitted,
    currentOutcome,
  ]);
  useEffect(() => () => window.clearTimeout(setupRefreshTimer.current), []);

  const configureOpenPi = async (request: string) => {
    setPreferencesSaved(false);
    if (setupDisabled) return false;
    setupBaseline.current = setupOutcome?.requestId;
    setSetupSection(section);
    setSetupPending(true);
    setSetupSubmitted(false);
    setupRefreshPending.current = false;
    setupObservedBusy.current = false;
    window.clearTimeout(setupRefreshTimer.current);
    setSetupError(null);
    try {
      const accepted = await onConfigureOpenPi(request);
      if (!accepted) {
        setSetupError(t("setupRequestFailed"));
      } else {
        setSetupSubmitted(true);
        setupRefreshPending.current = true;
        setupRefreshTimer.current = window.setTimeout(() => {
          if (!setupRefreshPending.current || setupObservedBusy.current) return;
          setupRefreshPending.current = false;
          setupObservedBusy.current = false;
          refresh();
          void onPreferencesChanged();
        }, 2_000);
      }
      return accepted;
    } catch (reason) {
      setSetupPending(false);
      setSetupError(
        reason instanceof Error ? reason.message : t("setupRequestFailed"),
      );
      return false;
    } finally {
      setSetupPending(false);
    }
  };

  const reloadResources = async () => {
    if (setupDisabled || !catalog?.sessionPath)
      throw new Error(t("resourceReloadFailed"));
    setSetupPending(true);
    try {
      await new WebClient().reloadSettingsResources(
        sessionId,
        catalog.sessionPath,
      );
      refresh();
      void onPreferencesChanged();
    } finally {
      setSetupPending(false);
    }
  };

  const updateWebPreferences = async (patch: WebSettingsPreferencesPatch) => {
    if (preferenceInFlight.current || !catalog) return false;
    preferenceInFlight.current = true;
    setPreferencePending(true);
    setPreferencesSaved(false);
    setSetupError(null);
    try {
      const result = await new WebClient().savePreferences(patch);
      updateSetup(result.setup);
      setPreferencesSaved(true);
      void onPreferencesChanged();
      return true;
    } catch {
      setSetupError(t("settingsPreferencesSaveFailed"));
      return false;
    } finally {
      preferenceInFlight.current = false;
      setPreferencePending(false);
    }
  };

  const selectSection = (next: SettingsSection) => {
    if (saving) return;
    setSection(next);
    setSearch("");
    if (next === "models") setModelsVisited(true);
    setSetupError(null);
  };
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("settings", section);
    window.history.replaceState(window.history.state, "", url);
  }, [section]);
  const visibleSections = settingsSections.filter(({ label, terms }) =>
    [label, ...terms].some((key) =>
      t(key)
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(search.trim().normalize("NFKC").toLocaleLowerCase()),
    ),
  );
  const navigate = (
    target: NonNullable<typeof pendingNavigation>,
    discard = false,
  ) => {
    if (saving) return;
    if (modelDraftDirty && !discard) {
      setPendingNavigation(target);
      return;
    }
    setPendingNavigation(null);
    if (target.kind === "runtime") onOpenRuntimeStatus();
    else onClose();
  };

  return (
    <Dialog
      isOpen
      purpose="info"
      padding={0}
      width="calc(100vw - 32px)"
      maxHeight="calc(100dvh - 16px)"
      className="provider-settings-dialog"
      aria-label={t("settings")}
      onOpenChange={(open: boolean) => {
        if (!open && !pendingNavigation) navigate({ kind: "close" });
      }}
    >
      <section className="provider-settings-surface">
        <aside className="provider-settings-sidebar">
          <header className="provider-settings-header">
            <strong className="provider-settings-title">{t("settings")}</strong>
            <select
              className="provider-settings-mobile-picker"
              aria-label={t("settingsNavigation")}
              disabled={saving}
              value={section}
              onChange={(event) => {
                const next = settingsSections.find(
                  ({ id }) => id === event.target.value,
                );
                if (next) selectSection(next.id);
              }}
            >
              {settingsSections.map(({ id, label }) => (
                <option key={id} value={id}>
                  {t(label)}
                </option>
              ))}
            </select>
          </header>
          <label className="provider-settings-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              aria-label={t("settingsSearch")}
              placeholder={t("settingsSearch")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              disabled={saving}
            />
            {search && (
              <button
                type="button"
                aria-label={t("settingsClearSearch")}
                onClick={() => setSearch("")}
              >
                <X aria-hidden="true" />
              </button>
            )}
          </label>
          <div
            className="provider-settings-navigation"
            ref={tabs}
            aria-label={t("settingsNavigation")}
            role="tablist"
            aria-orientation="vertical"
          >
            {["settingsPersonal", "settingsAgent", "settingsIntegrations"].map(
              (group) => (
                <div className="provider-settings-nav-group" key={group}>
                  {visibleSections.some((item) => item.group === group) && (
                    <p>{t(group)}</p>
                  )}
                  {visibleSections
                    .filter((item) => item.group === group)
                    .map(({ id, label, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        disabled={saving}
                        id={`settings-tab-${id}`}
                        tabIndex={
                          section === id ||
                          (!visibleSections.some(
                            (item) => item.id === section,
                          ) &&
                            visibleSections[0]?.id === id)
                            ? 0
                            : -1
                        }
                        aria-selected={section === id}
                        aria-controls={`settings-panel-${id}`}
                        className="provider-settings-tab"
                        title={t(label)}
                        onClick={() => selectSection(id)}
                        onKeyDown={(event) => {
                          if (
                            event.altKey ||
                            event.ctrlKey ||
                            event.metaKey ||
                            event.nativeEvent.isComposing
                          )
                            return;
                          const index = visibleSections.findIndex(
                            (item) => item.id === id,
                          );
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? visibleSections.length - 1
                                : event.key === "ArrowDown" ||
                                    event.key === "ArrowRight"
                                  ? (index + 1) % visibleSections.length
                                  : event.key === "ArrowUp" ||
                                      event.key === "ArrowLeft"
                                    ? (index + visibleSections.length - 1) %
                                      visibleSections.length
                                    : undefined;
                          if (next === undefined) return;
                          event.preventDefault();
                          const target = visibleSections[next]!.id;
                          selectSection(target);
                          tabs.current
                            ?.querySelector<HTMLButtonElement>(
                              `#settings-tab-${target}`,
                            )
                            ?.focus();
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span>{t(label)}</span>
                      </button>
                    ))}
                </div>
              ),
            )}
            {visibleSections.length === 0 && (
              <p className="provider-settings-no-results" role="status">
                {t("settingsNoResults")}
              </p>
            )}
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-button provider-settings-close"
            aria-label={t("close")}
            disabled={saving}
            title={saving ? t("savingSettings") : t("close")}
            onClick={() => navigate({ kind: "close" })}
          >
            <X />
          </button>
        </aside>

        <div className="provider-settings-body">
          {planBlocked && section !== "browser" && (
            <div className="settings-plan-notice" role="status">
              <span>{t(setupBusy ? "setupPlanBusy" : "setupPlanBlocked")}</span>
              <Button
                label={t("planModeExit")}
                variant="secondary"
                size="sm"
                isDisabled={setupBusy || planSelectionPending || !onExitPlan}
                onClick={() => void onExitPlan?.()}
              />
            </div>
          )}
          <div className="provider-settings-main">
            <div
              id="settings-panel-configuration"
              aria-labelledby="settings-tab-configuration"
              aria-label={t("configurationSettings")}
              role="tabpanel"
              hidden={section !== "configuration"}
            >
              {section === "configuration" && (
                <ConfigurationSettingsPanel
                  catalog={catalog}
                  error={catalogError}
                  pending={
                    setupDisabled ||
                    (setupSubmitted &&
                      setupSection === "configuration" &&
                      (!currentOutcome || currentOutcome.status === "pending"))
                  }
                  preferencePending={preferencePending}
                  onConfigure={configureOpenPi}
                  onUpdatePreferences={updateWebPreferences}
                  onRefresh={refresh}
                  onOpenRuntimeStatus={() => navigate({ kind: "runtime" })}
                />
              )}
            </div>
            <div
              id="settings-panel-appearance"
              aria-labelledby="settings-tab-appearance"
              aria-label={t("appearance")}
              role="tabpanel"
              hidden={section !== "appearance"}
            >
              <AppearanceSettingsPanel
                catalog={catalog}
                theme={theme}
                pending={preferencePending}
                error={catalogError}
                onRefresh={refresh}
                onUpdatePreferences={updateWebPreferences}
              />
            </div>
            <div
              id="settings-panel-archived-chats"
              aria-labelledby="settings-tab-archived-chats"
              aria-label={t("settingsArchivedChats")}
              role="tabpanel"
              hidden={section !== "archived-chats"}
            >
              {section === "archived-chats" && (
                <ArchivedChatsSettingsPanel
                  workspaces={workspaces}
                  onRestore={onRestoreSession ?? (async () => false)}
                />
              )}
            </div>
            <div
              id="settings-panel-web-search"
              aria-labelledby="settings-tab-web-search"
              aria-label={t("webSearchSettings")}
              role="tabpanel"
              hidden={section !== "web-search"}
            >
              {section === "web-search" && (
                <WebSearchSettingsPanel
                  catalog={catalog}
                  error={catalogError}
                  pending={setupDisabled}
                  onConfigure={configureOpenPi}
                  onRefresh={refresh}
                />
              )}
            </div>
            <div
              id="settings-panel-browser"
              aria-labelledby="settings-tab-browser"
              aria-label={t("browserSettings")}
              role="tabpanel"
              hidden={section !== "browser"}
            >
              {section === "browser" && (
                <BrowserSettingsPanel
                  onConfigure={configureOpenPi}
                  setupPending={setupDisabled}
                />
              )}
            </div>
            <div
              id="settings-panel-general"
              aria-labelledby="settings-tab-general"
              aria-label={t("generalSettings")}
              role="tabpanel"
              hidden={section !== "general"}
            >
              <GeneralSettingsPanel
                catalog={catalog}
                error={catalogError}
                currentModel={currentModel}
                thinkingLevel={thinkingLevel}
                cwd={cwd}
                setupPending={setupPending || setupBusy}
                preferencePending={preferencePending || !catalog}
                setupBusy={setupBusy}
                setupBlockedReason={setupBlockedReason}
                setupBlocked={planBlocked || planSelectionPending}
                onConfigure={configureOpenPi}
                onUpdatePreferences={updateWebPreferences}
                onOpenRuntimeStatus={() => navigate({ kind: "runtime" })}
                onRefresh={refresh}
              />
            </div>

            <section
              id="settings-panel-models"
              aria-labelledby="settings-tab-models"
              aria-label={t("modelSettings")}
              className="settings-models"
              role="tabpanel"
              hidden={section !== "models"}
            >
              {modelsVisited && (
                <ProviderModelsSection
                  key={sessionId}
                  sessionId={sessionId}
                  sessionPath={sessionPath}
                  models={models}
                  currentModel={currentModel}
                  busy={setupBusy}
                  focusCredentials={entry === "credentials"}
                  onSaved={async () => {
                    refresh();
                    return onPreferencesChanged();
                  }}
                  onSelectModel={onSelectModel}
                  onDraftChange={setModelDraftDirty}
                  onSavingChange={setModelSaving}
                />
              )}
            </section>

            <div
              id="settings-panel-skills"
              aria-labelledby="settings-tab-skills"
              aria-label={t("skillsSettings")}
              role="tabpanel"
              hidden={section !== "skills"}
            >
              <SkillsSettingsPanel
                key={sessionId}
                catalog={catalog}
                error={catalogError}
                onRefresh={refresh}
                setupPending={setupDisabled}
                onConfigure={configureOpenPi}
                onReload={reloadResources}
              />
            </div>

            <div
              id="settings-panel-subagents"
              aria-labelledby="settings-tab-subagents"
              aria-label={t("subagentsSettings")}
              role="tabpanel"
              hidden={section !== "subagents"}
            >
              <SubagentsSettingsPanel
                catalog={catalog}
                error={catalogError}
                currentModel={currentModel}
                models={models}
                activity={capabilities?.subagents}
                setupPending={setupPending || setupBusy}
                setupBlocked={planBlocked || planSelectionPending}
                onConfigure={configureOpenPi}
                onRefresh={refresh}
              />
            </div>

            <div
              id="settings-panel-plugins"
              aria-labelledby="settings-tab-plugins"
              aria-label={t("pluginsSettings")}
              role="tabpanel"
              hidden={section !== "plugins"}
            >
              <PluginsSettingsPanel
                key={sessionId}
                catalog={catalog}
                error={catalogError}
                onRefresh={refresh}
                setupPending={setupDisabled}
                onConfigure={configureOpenPi}
                onReload={reloadResources}
              />
            </div>
          </div>
          {interaction}
          {setupError && (
            <div className="settings-global-error" role="alert">
              {setupError}
            </div>
          )}
          {(preferencePending || preferencesSaved) &&
            !setupError &&
            !setupNeedsAttention && (
              <div className="settings-global-status" role="status">
                {t(
                  preferencePending
                    ? "savingSettings"
                    : "settingsPreferencesSaved",
                )}
              </div>
            )}
          {!preferencePending &&
            (!preferencesSaved || setupNeedsAttention) &&
            ((setupSubmitted && setupSection === section) || currentOutcome) &&
            !setupError && (
              <div
                className={
                  currentOutcome?.status === "failed"
                    ? "settings-global-error"
                    : "settings-global-status"
                }
                role={currentOutcome?.status === "failed" ? "alert" : "status"}
              >
                {currentOutcome
                  ? t(
                      (section === "skills" ||
                        section === "plugins" ||
                        section === "web-search") &&
                        ["unconfirmed", "saved", "unchanged"].includes(
                          currentOutcome.status,
                        )
                        ? "resourceRequestFinished"
                        : `setupOutcome_${currentOutcome.status}`,
                    )
                  : t(
                      setupBusy
                        ? "setupRequestRunning"
                        : section === "skills" ||
                            section === "plugins" ||
                            section === "web-search"
                          ? "resourceRequestSubmitted"
                          : "setupRequestAccepted",
                    )}
                {currentOutcome?.error && <p>{currentOutcome.error}</p>}
              </div>
            )}
        </div>
      </section>
      {pendingNavigation && (
        <AlertDialog
          isOpen
          onOpenChange={(open: boolean) => {
            if (!open) setPendingNavigation(null);
          }}
          title={t("unsavedSettingsTitle")}
          description={t("unsavedSettingsDetail")}
          cancelLabel={t("keepEditing")}
          actionLabel={t("discardAndContinue")}
          onAction={() => navigate(pendingNavigation, true)}
        />
      )}
    </Dialog>
  );
}
