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
  WebThemePreference,
} from "../../../../protocol/types.ts";
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
  models,
  currentModel,
  thinkingLevel,
  theme,
  capabilities,
  modelSelectionPending,
  onSelectModel,
  onConfigureOpenPi,
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
  modelSelectionPending: boolean;
  onSelectModel: (value: string) => void;
  onConfigureOpenPi: (request: string) => Promise<boolean>;
  onOpenRuntimeStatus: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<SettingsSection>("general");
  const [setupPending, setSetupPending] = useState(false);
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

  const configureOpenPi = async (request: string) => {
    if (setupPending) return false;
    setSetupPending(true);
    setSetupError(null);
    try {
      const accepted = await onConfigureOpenPi(request);
      if (!accepted) {
        setSetupPending(false);
        setSetupError(t("setupRequestFailed"));
      }
      return accepted;
    } catch (reason) {
      setSetupPending(false);
      setSetupError(
        reason instanceof Error ? reason.message : t("setupRequestFailed"),
      );
      return false;
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
                onClick={() => {
                  setSection(id);
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
              setupPending={setupPending}
              onConfigure={configureOpenPi}
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
                          <span>{model.name || model.id}</span>
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
                      <span>{t("modelSettings")}</span>
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
                  <ProviderStatusSection
                    sessionId={sessionId}
                    providerId={selectedModel.provider}
                    hidden={false}
                  />
                </>
              ) : (
                <div className="provider-settings-state">
                  <strong>{t("noModels")}</strong>
                </div>
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
              activity={capabilities?.subagents}
              setupPending={setupPending}
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
            />
          </div>
        </div>
        {setupError && (
          <div className="settings-global-error" role="alert">
            {setupError}
          </div>
        )}
      </section>
    </Dialog>
  );
}
