import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import {
  Bot,
  Check,
  Cpu,
  KeyRound,
  Layers3,
  Plug,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebCapabilitySnapshot } from "../../../../../extensions/shared/web-observer-registry.ts";
import type {
  WebModelSummary,
  WebSettingsPreferencesPatch,
  WebThemePreference,
} from "../../../../protocol/types.ts";
import { ProviderStatusSection } from "./ProviderStatusSection.tsx";
import { ModelConfigurationEditor } from "./ModelConfigurationEditor.tsx";
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

function modelKey(model: WebModelSummary) {
  return `${model.provider}/${model.id}`;
}

export function ProviderSettingsPage({
  sessionId,
  cwd,
  models,
  currentModel,
  thinkingLevel,
  theme,
  capabilities,
  setupBusy,
  modelSelectionPending,
  onSelectModel,
  onConfigureOpenPi,
  onPreferencesChanged,
  onOpenRuntimeStatus,
  onClose,
}: {
  sessionId: string;
  cwd: string;
  models: WebModelSummary[];
  currentModel?: WebModelSummary;
  thinkingLevel: string;
  theme: WebThemePreference;
  capabilities?: WebCapabilitySnapshot;
  setupBusy: boolean;
  modelSelectionPending: boolean;
  onSelectModel: (value: string) => void;
  onConfigureOpenPi: (request: string) => Promise<boolean>;
  onPreferencesChanged: () => Promise<boolean>;
  onOpenRuntimeStatus: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<SettingsSection>("general");
  const [modelsVisited, setModelsVisited] = useState(false);
  const [setupPending, setSetupPending] = useState(false);
  const [providerRevision, refreshProviders] = useState(0);
  const [setupSubmitted, setSetupSubmitted] = useState(false);
  const setupRefreshPending = useRef(false);
  const setupObservedBusy = useRef(false);
  const setupRefreshTimer = useRef(0);
  const [preferencePending, setPreferencePending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const {
    catalog,
    error: catalogError,
    refresh,
  } = useSettingsCatalog(sessionId);
  const [selectedModelKey, setSelectedModelKey] = useState(
    currentModel
      ? modelKey(currentModel)
      : models[0]
        ? modelKey(models[0])
        : "",
  );

  const groupedModels = useMemo(() => {
    const groups = new Map<string, WebModelSummary[]>();
    for (const model of models) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()];
  }, [models]);
  const selectedModel =
    models.find((model) => modelKey(model) === selectedModelKey) ??
    currentModel ??
    models[0];

  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    if (!models.length) {
      setSelectedModelKey("");
      return;
    }
    if (models.some((model) => modelKey(model) === selectedModelKey)) return;
    setSelectedModelKey(modelKey(currentModel ?? models[0]!));
  }, [currentModel, models, selectedModelKey]);
  useEffect(() => {
    if (!setupSubmitted) return;
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
  }, [onPreferencesChanged, refresh, setupBusy, setupSubmitted]);
  useEffect(() => () => window.clearTimeout(setupRefreshTimer.current), []);

  const configureOpenPi = async (request: string) => {
    if (setupPending) return false;
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

  const preferenceRequest = (patch: WebSettingsPreferencesPatch) => {
    if (patch.theme !== undefined)
      return t("setupRequestSetTheme", { value: patch.theme });
    if (patch.chatWidth !== undefined)
      return t("setupRequestSetChatWidth", { value: patch.chatWidth });
    if (patch.chatFontSize !== undefined)
      return t("setupRequestSetChatFontSize", { value: patch.chatFontSize });
    if (patch.expandThinking !== undefined)
      return t(
        patch.expandThinking
          ? "setupRequestEnableExpandedThinking"
          : "setupRequestDisableExpandedThinking",
      );
    return t("setupRequestReviewAll");
  };

  const updateWebPreferences = async (patch: WebSettingsPreferencesPatch) => {
    if (preferencePending) return false;
    setPreferencePending(true);
    setSetupError(null);
    try {
      return await configureOpenPi(preferenceRequest(patch));
    } catch (reason) {
      setSetupError(
        reason instanceof Error ? reason.message : t("settingsUpdateFailed"),
      );
      return false;
    } finally {
      setPreferencePending(false);
    }
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
      onOpenChange={(open: boolean) => !open && onClose()}
    >
      <section className="provider-settings-surface">
        <header className="provider-settings-header">
          <strong className="provider-settings-title">{t("settings")}</strong>
          <div
            className="provider-settings-navigation"
            aria-label={t("settingsNavigation")}
            role="tablist"
          >
            {settingsSections.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={section === id}
                aria-controls={`settings-panel-${id}`}
                className="provider-settings-tab"
                title={t(label)}
                onClick={() => {
                  setSection(id);
                  if (id === "models") setModelsVisited(true);
                  setSetupError(null);
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
            onClick={onClose}
          >
            <X />
          </button>
        </header>

        <div className="provider-settings-main">
          <div
            id="settings-panel-general"
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
              preferencePending={preferencePending}
              onConfigure={configureOpenPi}
              onUpdatePreferences={updateWebPreferences}
              onOpenRuntimeStatus={onOpenRuntimeStatus}
              onRefresh={refresh}
            />
          </div>

          <section
            id="settings-panel-models"
            className="settings-models"
            role="tabpanel"
            hidden={section !== "models"}
          >
            <aside className="settings-model-sidebar">
              <div className="settings-model-list">
                {groupedModels.map(([provider, providerModels]) => (
                  <section className="settings-model-group" key={provider}>
                    <h2>
                      <Cpu aria-hidden="true" />
                      <span>{provider}</span>
                      <small>{providerModels.length}</small>
                    </h2>
                    {providerModels.map((model) => {
                      const key = modelKey(model);
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-current={
                            key === selectedModelKey ? "page" : undefined
                          }
                          className="settings-model-item"
                          onClick={() => setSelectedModelKey(key)}
                        >
                          <span>
                            <strong>{model.name || model.id}</strong>
                            {model.name !== model.id && (
                              <small>{model.id}</small>
                            )}
                          </span>
                          {model.current && (
                            <Check aria-label={t("currentModel")} />
                          )}
                        </button>
                      );
                    })}
                  </section>
                ))}
                {!models.length && (
                  <p className="settings-model-empty">{t("noModels")}</p>
                )}
              </div>
              <div className="settings-model-provider-link">
                <KeyRound aria-hidden="true" /> {t("providerReadOnly")}
              </div>
            </aside>
            <div className="settings-model-detail">
              {selectedModel ? (
                <>
                  <header className="settings-model-detail-heading">
                    <div>
                      <span>{t("model")}</span>
                      <h1>{selectedModel.name || selectedModel.id}</h1>
                      <code>{modelKey(selectedModel)}</code>
                    </div>
                    <Button
                      label={
                        selectedModel.current
                          ? t("currentModel")
                          : t("useThisModel")
                      }
                      variant={selectedModel.current ? "secondary" : "primary"}
                      size="sm"
                      icon={
                        selectedModel.current ? (
                          <Check aria-hidden="true" />
                        ) : undefined
                      }
                      isDisabled={
                        selectedModel.current || modelSelectionPending
                      }
                      isLoading={modelSelectionPending}
                      onClick={() => onSelectModel(modelKey(selectedModel))}
                    />
                  </header>
                  <dl className="settings-model-metadata">
                    <div>
                      <dt>{t("provider")}</dt>
                      <dd>{selectedModel.provider}</dd>
                    </div>
                    <div>
                      <dt>{t("modelId")}</dt>
                      <dd>{selectedModel.id}</dd>
                    </div>
                  </dl>
                </>
              ) : (
                <div className="provider-settings-state">
                  <strong>{t("noModels")}</strong>
                </div>
              )}
              <ProviderStatusSection
                key={`${sessionId}:${providerRevision}`}
                sessionId={sessionId}
                providerId={selectedModel?.provider ?? ""}
                active={section === "models"}
                busy={setupBusy}
                onSaved={onPreferencesChanged}
              />
              {modelsVisited && (
                <ModelConfigurationEditor
                  key={sessionId}
                  sessionId={sessionId}
                  busy={setupBusy}
                  onSaved={async () => {
                    refreshProviders((value) => value + 1);
                    return onPreferencesChanged();
                  }}
                />
              )}
            </div>
          </section>

          <div
            id="settings-panel-skills"
            role="tabpanel"
            hidden={section !== "skills"}
          >
            <SkillsSettingsPanel
              catalog={catalog}
              error={catalogError}
              onRefresh={refresh}
              setupPending={setupPending || setupBusy}
              onConfigure={configureOpenPi}
            />
          </div>

          <div
            id="settings-panel-subagents"
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
              onConfigure={configureOpenPi}
              onRefresh={refresh}
            />
          </div>

          <div
            id="settings-panel-plugins"
            role="tabpanel"
            hidden={section !== "plugins"}
          >
            <PluginsSettingsPanel
              catalog={catalog}
              error={catalogError}
              onRefresh={refresh}
              setupPending={setupPending || setupBusy}
              onConfigure={configureOpenPi}
            />
          </div>
        </div>
        {setupError && (
          <div className="settings-global-error" role="alert">
            {setupError}
          </div>
        )}
        {setupSubmitted && !setupError && (
          <div className="settings-global-status" role="status">
            {t(setupBusy ? "setupRequestRunning" : "setupRequestAccepted")}
          </div>
        )}
      </section>
    </Dialog>
  );
}
