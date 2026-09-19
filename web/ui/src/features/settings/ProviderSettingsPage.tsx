import {
  Activity,
  Check,
  Clipboard,
  KeyRound,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../../lib/clipboard.ts";
import { ProviderStatusSection } from "./ProviderStatusSection.tsx";

type SettingsSection = "runtime" | "providers" | "openpi";

const settingsSections = [
  { id: "runtime", label: "runtimeStatus", Icon: Activity },
  { id: "providers", label: "providerSettings", Icon: KeyRound },
  { id: "openpi", label: "openPiSettings", Icon: SlidersHorizontal },
] as const;

export function ProviderSettingsPage({
  sessionId,
  cwd,
  model,
  thinkingLevel,
  onOpenRuntimeStatus,
  onClose,
}: {
  sessionId: string;
  cwd: string;
  model: string;
  thinkingLevel: string;
  onOpenRuntimeStatus: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<SettingsSection>("providers");
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );

  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const title =
    section === "runtime"
      ? t("runtimeStatus")
      : section === "openpi"
        ? t("openPiSettings")
        : t("providerSettings");
  const intro =
    section === "runtime"
      ? t("runtimeSettingsIntro")
      : section === "openpi"
        ? t("openPiSettingsIntro")
        : t("providerSettingsIntro");

  const copySetup = () => {
    setCopyStatus(null);
    void copyText("/openpi-setup").then((success) =>
      setCopyStatus(success ? "copied" : "failed"),
    );
  };

  return (
    <div className="provider-settings-page">
      <header className="provider-settings-header">
        <div>
          <span>{t("settings")}</span>
          <strong>{title}</strong>
        </div>
        <button
          ref={closeButton}
          type="button"
          className="icon-button"
          aria-label={t("close")}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <div className="provider-settings-layout">
        <nav
          className="provider-settings-navigation"
          aria-label={t("settingsNavigation")}
        >
          <strong>{t("settings")}</strong>
          <div>
            {settingsSections.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? "page" : undefined}
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
        </nav>
        <div className="provider-settings-scroll">
          <main
            className="provider-settings-content"
            aria-labelledby="provider-settings-title"
          >
            <div className="provider-settings-title-row">
              <div>
                <h1 id="provider-settings-title">{title}</h1>
                <p>{intro}</p>
              </div>
            </div>
            <p className="provider-settings-workspace" title={cwd}>
              {cwd}
            </p>
            <section
              className="settings-summary-section"
              hidden={section !== "runtime"}
            >
              <dl className="settings-summary-list">
                <div>
                  <dt>{t("selectedModel")}</dt>
                  <dd>{model}</dd>
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
              <button
                type="button"
                className="settings-primary-action"
                onClick={onOpenRuntimeStatus}
              >
                <Activity aria-hidden="true" />
                {t("openRuntimeDetails")}
              </button>
              <p className="settings-section-note">{t("configurationViaPi")}</p>
            </section>
            <section
              className="settings-summary-section"
              hidden={section !== "openpi"}
            >
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
                <SlidersHorizontal aria-hidden="true" />
                <div>
                  <strong>{t("providerReadOnly")}</strong>
                  <p>{t("configurationViaPi")}</p>
                </div>
              </aside>
            </section>
            <ProviderStatusSection
              sessionId={sessionId}
              hidden={section !== "providers"}
            />
          </main>
        </div>
      </div>
    </div>
  );
}
