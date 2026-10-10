import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Bot, Cpu, Layers3, Plug, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebCapabilitySnapshot } from "../../../../../extensions/shared/web-observer-registry.ts";
import type {
  WebModelSummary,
  WebSettingsPreferencesPatch,
  WebSnapshot,
  WebThemePreference,
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

type SettingsSection =
  | "general"
  | "models"
  | "skills"
  | "subagents"
  | "plugins";

const settingsSections = [
  { id: "general", label: "generalSettings", Icon: SlidersHorizontal },
  { id: "models", label: "modelSettings", Icon: Cpu },
  { id: "skills", label: "skillsSettings", Icon: Layers3 },
  { id: "subagents", label: "subagentsSettings", Icon: Bot },
  { id: "plugins", label: "pluginsSettings", Icon: Plug },
] as const;

export function ProviderSettingsPage({
  sessionId,
  cwd,
  entry = "general",
  models,
  currentModel,
  thinkingLevel,
  theme,
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
  onOpenRuntimeStatus,
  onClose,
}: {
  sessionId: string;
  cwd: string;
  entry?: "general" | "credentials";
  models: WebModelSummary[];
  currentModel?: WebModelSummary;
  thinkingLevel: string;
  theme: WebThemePreference;
  capabilities?: WebCapabilitySnapshot;
  setupBusy: boolean;
  setupBlockedReason?: string;
  plan?: WebSnapshot["runtime"]["plan"];
  planSelectionPending?: boolean;
  onExitPlan?: () => Promise<void>;
  setupOutcome?: WebSnapshot["runtime"]["setup"];
  modelSelectionPending: boolean;
  onSelectModel: (value: string) => void;
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
  const [section, setSection] = useState<SettingsSection>(
    entry === "credentials" ? "models" : "general",
  );
  const [modelsVisited, setModelsVisited] = useState(entry === "credentials");
  const [setupPending, setSetupPending] = useState(false);
  const [setupSubmitted, setSetupSubmitted] = useState(false);
  const [setupSection, setSetupSection] = useState<SettingsSection>("general");
  const setupRefreshPending = useRef(false);
  const setupObservedBusy = useRef(false);
  const setupRefreshTimer = useRef(0);
  const [preferencePending, setPreferencePending] = useState(false);
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
    (!setupSubmitted && (section === "skills" || section === "plugins"))
      ? undefined
      : !setupSubmitted || setupOutcome?.requestId !== setupBaseline.current
        ? setupOutcome
        : undefined;
  const {
    catalog,
    error: catalogError,
    refresh,
    updateSetup,
  } = useSettingsCatalog(sessionId);
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
    if (preferencePending || !catalog) return false;
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
      setPreferencePending(false);
    }
  };

  const selectSection = (next: SettingsSection) => {
    if (saving) return;
    setSection(next);
    if (next === "models") setModelsVisited(true);
    setSetupError(null);
  };
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
      width={1080}
      maxHeight="calc(100dvh - 16px)"
      className="provider-settings-dialog"
      aria-label={t("settings")}
      onOpenChange={(open: boolean) => {
        if (!open && !pendingNavigation) navigate({ kind: "close" });
      }}
    >
      <section className="provider-settings-surface">
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
          <div
            className="provider-settings-navigation"
            ref={tabs}
            aria-label={t("settingsNavigation")}
            role="tablist"
          >
            {settingsSections.map(({ id, label, Icon }, index) => (
              <button
                key={id}
                type="button"
                role="tab"
                disabled={saving}
                id={`settings-tab-${id}`}
                tabIndex={section === id ? 0 : -1}
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
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? settingsSections.length - 1
                        : event.key === "ArrowRight"
                          ? (index + 1) % settingsSections.length
                          : event.key === "ArrowLeft"
                            ? (index + settingsSections.length - 1) %
                              settingsSections.length
                            : undefined;
                  if (next === undefined) return;
                  event.preventDefault();
                  selectSection(settingsSections[next]!.id);
                  tabs.current
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                <Icon aria-hidden="true" />
                <span>{t(label)}</span>
              </button>
            ))}
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
        </header>

        {planBlocked && (
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
            id="settings-panel-general"
            aria-labelledby="settings-tab-general"
            role="tabpanel"
            hidden={section !== "general"}
          >
            <GeneralSettingsPanel
              catalog={catalog}
              error={catalogError}
              currentModel={currentModel}
              thinkingLevel={thinkingLevel}
              cwd={cwd}
              theme={theme}
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
            className="settings-models"
            role="tabpanel"
            hidden={section !== "models"}
          >
            {modelsVisited && (
              <ProviderModelsSection
                key={sessionId}
                sessionId={sessionId}
                models={models}
                currentModel={currentModel}
                busy={setupBusy}
                focusCredentials={entry === "credentials"}
                onSaved={onPreferencesChanged}
                onDraftChange={setModelDraftDirty}
                onSavingChange={setModelSaving}
              />
            )}
          </section>

          <div
            id="settings-panel-skills"
            aria-labelledby="settings-tab-skills"
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
        {(preferencePending || preferencesSaved) && !setupError && (
          <div className="settings-global-status" role="status">
            {t(
              preferencePending ? "savingSettings" : "settingsPreferencesSaved",
            )}
          </div>
        )}
        {!preferencePending &&
          !preferencesSaved &&
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
                    (section === "skills" || section === "plugins") &&
                      ["unconfirmed", "saved", "unchanged"].includes(
                        currentOutcome.status,
                      )
                      ? "resourceRequestFinished"
                      : `setupOutcome_${currentOutcome.status}`,
                  )
                : t(
                    setupBusy
                      ? "setupRequestRunning"
                      : section === "skills" || section === "plugins"
                        ? "resourceRequestSubmitted"
                        : "setupRequestAccepted",
                  )}
              {currentOutcome?.error && <p>{currentOutcome.error}</p>}
            </div>
          )}
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
