import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import {
  Bot,
  Check,
  Cpu,
  Layers3,
  Plug,
  Plus,
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
import type { WebModelConfiguration } from "../../../../runtime/types.ts";
import { ModelConfigurationEditor } from "./ModelConfigurationEditor.tsx";
import { ProviderStatusSection } from "./ProviderStatusSection.tsx";
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
  entry = "general",
  models,
  currentModel,
  thinkingLevel,
  theme,
  capabilities,
  setupBusy: sessionBusy,
  setupBlockedReason,
  modelSelectionPending,
  onSelectModel,
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
  const [configuredModels, setConfiguredModels] = useState<
    WebModelConfiguration[]
  >([]);
  const [setupPending, setSetupPending] = useState(false);
  const [providerRevision, refreshProviders] = useState(0);
  const [setupSubmitted, setSetupSubmitted] = useState(false);
  const setupRefreshPending = useRef(false);
  const setupObservedBusy = useRef(false);
  const setupRefreshTimer = useRef(0);
  const [preferencePending, setPreferencePending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [modelDraftDirty, setModelDraftDirty] = useState(false);
  const [credentialDraftDirty, setCredentialDraftDirty] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    | { kind: "close" | "runtime" }
    | { kind: "model"; key: string; provider: string }
    | null
  >(null);
  const saving = modelSaving || credentialSaving;
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
  const viewedModel = useRef<WebModelSummary | undefined>(undefined);

  const modelCatalog = useMemo(() => {
    const merged = new Map(models.map((model) => [modelKey(model), model]));
    for (const model of configuredModels) {
      const key = `${model.provider}/${model.id}`;
      if (!merged.has(key))
        merged.set(key, {
          provider: model.provider,
          id: model.id,
          name: model.name,
          label: model.name || model.id,
          current: false,
        });
    }
    return [...merged.values()];
  }, [configuredModels, models]);
  const groupedModels = useMemo(() => {
    const groups = new Map<string, WebModelSummary[]>();
    for (const model of modelCatalog) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()];
  }, [modelCatalog]);
  const catalogModel = modelCatalog.find(
    (model) => modelKey(model) === selectedModelKey,
  );
  if (catalogModel) viewedModel.current = catalogModel;
  // A catalog refresh cannot authorize leaving an open credential draft.
  const selectedModel = selectedModelKey
    ? (catalogModel ??
      (viewedModel.current && modelKey(viewedModel.current) === selectedModelKey
        ? viewedModel.current
        : undefined))
    : undefined;

  useEffect(() => {
    closeButton.current?.focus();
  }, []);
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
    if (setupPending || setupBusy) return false;
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
    if (preferencePending || setupPending || setupBusy) return false;
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

  const selectSection = (next: SettingsSection) => {
    setSection(next);
    if (next === "models") setModelsVisited(true);
    setSetupError(null);
  };
  const navigate = (
    target: NonNullable<typeof pendingNavigation>,
    discard = false,
  ) => {
    if (target.kind === "model" ? credentialSaving : saving) return;
    const changesProvider =
      target.kind === "model" &&
      target.provider !== (selectedModel?.provider ?? "");
    const needsConfirmation =
      target.kind === "model"
        ? changesProvider && credentialDraftDirty
        : modelDraftDirty || credentialDraftDirty;
    if (needsConfirmation && !discard) {
      setPendingNavigation(target);
      return;
    }
    setPendingNavigation(null);
    if (target.kind === "model") setSelectedModelKey(target.key);
    else if (target.kind === "runtime") onOpenRuntimeStatus();
    else onClose();
  };
  const selectModelDetail = (key: string, provider?: string) =>
    navigate({
      kind: "model",
      key,
      provider:
        provider ??
        modelCatalog.find((model) => modelKey(model) === key)?.provider ??
        "",
    });

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
              preferencePending={preferencePending || setupPending || setupBusy}
              setupBusy={setupBusy}
              setupBlockedReason={setupBlockedReason}
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
                          disabled={credentialSaving}
                          onClick={() => selectModelDetail(key)}
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
                {!modelCatalog.length && (
                  <p className="settings-model-empty">{t("noModels")}</p>
                )}
              </div>
              <button
                type="button"
                className="settings-model-provider-link"
                disabled={credentialSaving}
                onClick={() => selectModelDetail("")}
              >
                <Plus aria-hidden="true" /> {t("addModel")}
              </button>
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
                          : models.some(
                                (model) => modelKey(model) === selectedModelKey,
                              )
                            ? t("useThisModel")
                            : t("unavailable")
                      }
                      variant={selectedModel.current ? "secondary" : "primary"}
                      size="sm"
                      icon={
                        selectedModel.current ? (
                          <Check aria-hidden="true" />
                        ) : undefined
                      }
                      isDisabled={
                        setupBusy ||
                        saving ||
                        selectedModel.current ||
                        modelSelectionPending ||
                        !models.some(
                          (model) => modelKey(model) === selectedModelKey,
                        )
                      }
                      isLoading={modelSelectionPending}
                      onClick={() => {
                        if (!setupBusy && !saving)
                          onSelectModel(modelKey(selectedModel));
                      }}
                    />
                  </header>
                  {setupBusy && !selectedModel.current && (
                    <p className="settings-edit-state" role="status">
                      {setupBlockedReason || t("modelSelectionBusy")}
                    </p>
                  )}
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
                <header className="settings-model-detail-heading">
                  <h1>{t("addModel")}</h1>
                </header>
              )}
              {modelsVisited && (
                <ModelConfigurationEditor
                  key={`model-config:${sessionId}`}
                  sessionId={sessionId}
                  selectedKey={selectedModelKey}
                  selectedModel={selectedModel}
                  onSelect={selectModelDetail}
                  onModelsLoaded={setConfiguredModels}
                  onDraftChange={setModelDraftDirty}
                  onSavingChange={setModelSaving}
                  busy={setupBusy}
                  onSaved={async () => {
                    refreshProviders((value) => value + 1);
                    return onPreferencesChanged();
                  }}
                />
              )}
              <ProviderStatusSection
                key={`providers:${sessionId}`}
                sessionId={sessionId}
                providerId={selectedModel?.provider ?? ""}
                active={section === "models"}
                refreshRevision={providerRevision}
                focusOnOpen={entry === "credentials"}
                onDraftChange={setCredentialDraftDirty}
                onSavingChange={setCredentialSaving}
                busy={setupBusy}
                onSaved={onPreferencesChanged}
              />
            </div>
          </section>

          <div
            id="settings-panel-skills"
            aria-labelledby="settings-tab-skills"
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
              catalog={catalog}
              error={catalogError}
              onRefresh={refresh}
              setupPending={setupPending || setupBusy}
              onConfigure={configureOpenPi}
            />
          </div>
        </div>
        {interaction}
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
      {pendingNavigation && (
        <AlertDialog
          isOpen
          onOpenChange={(open: boolean) => {
            if (!open) setPendingNavigation(null);
          }}
          title={t(
            pendingNavigation.kind === "model"
              ? "unsavedCredentialTitle"
              : "unsavedSettingsTitle",
          )}
          description={t(
            pendingNavigation.kind === "model"
              ? "unsavedCredentialDetail"
              : "unsavedSettingsDetail",
          )}
          cancelLabel={t("keepEditing")}
          actionLabel={t("discardAndContinue")}
          onAction={() => navigate(pendingNavigation, true)}
        />
      )}
    </Dialog>
  );
}
