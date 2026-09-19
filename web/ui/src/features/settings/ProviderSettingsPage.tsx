import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import {
  Check,
  Clipboard,
  Cpu,
  KeyRound,
  Monitor,
  Moon,
  SlidersHorizontal,
  Sun,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebModelSummary } from "../../../../protocol/types.ts";
import { copyText } from "../../lib/clipboard.ts";
import { ProviderStatusSection } from "./ProviderStatusSection.tsx";

type SettingsSection = "general" | "models" | "openpi";

const settingsSections = [
  { id: "general", label: "generalSettings", Icon: SlidersHorizontal },
  { id: "models", label: "modelSettings", Icon: Cpu },
  { id: "openpi", label: "openPiSettings", Icon: Wrench },
] as const;

const themeOptions = [
  { id: "light", label: "themeLight", Icon: Sun },
  { id: "dark", label: "themeDark", Icon: Moon },
  { id: "system", label: "themeSystem", Icon: Monitor },
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
  modelSelectionPending,
  onSelectModel,
  onOpenRuntimeStatus,
  onClose,
}: {
  sessionId: string;
  cwd: string;
  models: WebModelSummary[];
  currentModel?: WebModelSummary;
  thinkingLevel: string;
  theme: "system" | "light" | "dark";
  modelSelectionPending: boolean;
  onSelectModel: (value: string) => void;
  onOpenRuntimeStatus: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<SettingsSection>("models");
  const [selectedModelKey, setSelectedModelKey] = useState(
    currentModel
      ? modelKey(currentModel)
      : models[0]
        ? modelKey(models[0])
        : "",
  );
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
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

  const copySetup = () => {
    setCopyStatus(null);
    void copyText("/openpi-setup").then((success) =>
      setCopyStatus(success ? "copied" : "failed"),
    );
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
                  setCopyStatus(null);
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
          <section
            id="settings-panel-general"
            className="settings-general"
            role="tabpanel"
            hidden={section !== "general"}
          >
            <h1>{t("generalSettings")}</h1>
            <section className="settings-general-section">
              <h2>{t("appearance")}</h2>
              <p>{t("appearanceDescription")}</p>
              <ul className="settings-theme-options">
                {themeOptions.map(({ id, label, Icon }) => (
                  <li
                    key={id}
                    className="settings-theme-option"
                    data-selected={theme === id ? "true" : undefined}
                    aria-current={theme === id ? "true" : undefined}
                  >
                    <Icon aria-hidden="true" />
                    <span>{t(label)}</span>
                  </li>
                ))}
              </ul>
              <p className="settings-managed-note">
                {t("themeManagedBySetup")}
              </p>
            </section>
            <section className="settings-general-section">
              <h2>{t("sessionSettings")}</h2>
              <p>{t("runtimeSettingsIntro")}</p>
              <dl className="settings-summary-list">
                <div>
                  <dt>{t("selectedModel")}</dt>
                  <dd>{currentModel?.label ?? t("noModels")}</dd>
                </div>
                <div>
                  <dt>{t("thinkingLevel")}</dt>
                  <dd>{thinkingLevel}</dd>
                </div>
                <div>
                  <dt>{t("currentWorkspace")}</dt>
                  <dd title={cwd}>{cwd}</dd>
                </div>
              </dl>
              <Button
                label={t("openRuntimeDetails")}
                variant="secondary"
                size="sm"
                icon={<SlidersHorizontal aria-hidden="true" />}
                className="settings-runtime-action"
                onClick={onOpenRuntimeStatus}
              />
            </section>
          </section>

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
              <button
                type="button"
                className="settings-model-provider-link"
                onClick={() => setSection("openpi")}
              >
                <KeyRound aria-hidden="true" /> {t("providerReadOnly")}
              </button>
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

          <section
            id="settings-panel-openpi"
            className="settings-openpi"
            role="tabpanel"
            hidden={section !== "openpi"}
          >
            <h1>{t("openPiSettings")}</h1>
            <p>{t("openPiSettingsIntro")}</p>
            <div className="settings-command-row">
              <div>
                <strong>{t("canonicalSetupCommand")}</strong>
                <code>/openpi-setup</code>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={t(
                  copyStatus === "copied"
                    ? "copiedMessage"
                    : "copySetupCommand",
                )}
                title={t(
                  copyStatus === "copied"
                    ? "copiedMessage"
                    : "copySetupCommand",
                )}
                onClick={copySetup}
              >
                {copyStatus === "copied" ? <Check /> : <Clipboard />}
              </button>
            </div>
            {copyStatus === "failed" && (
              <p className="inspection-warning" role="status">
                {t("copyFailed")}
              </p>
            )}
            <aside className="provider-read-only">
              <Wrench aria-hidden="true" />
              <div>
                <strong>{t("providerReadOnly")}</strong>
                <p>{t("configurationViaPi")}</p>
              </div>
            </aside>
          </section>
        </div>
      </section>
    </Dialog>
  );
}
