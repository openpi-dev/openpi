import { ComplexSelector } from "@astryxdesign/core/ComplexSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { ArrowUpRight, RefreshCw, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReasoningLevel } from "../../../../../extensions/shared/setup-config.ts";
import type {
  WebSettingsCatalog,
  WebSettingsPreferencesPatch,
} from "../../../../protocol/types.ts";

export function ConfigurationSettingsPanel({
  catalog,
  error,
  pending,
  preferencePending,
  onConfigure,
  onUpdatePreferences,
  onRefresh,
  onOpenRuntimeStatus,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  pending: boolean;
  preferencePending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onUpdatePreferences: (patch: WebSettingsPreferencesPatch) => Promise<boolean>;
  onRefresh: () => void;
  onOpenRuntimeStatus: () => void;
}) {
  const { t } = useTranslation();
  const unreadable =
    catalog?.setupWritable === false ||
    Boolean(catalog?.resources.diagnostics.settingsErrors);
  const blocked =
    pending ||
    preferencePending ||
    Boolean(error) ||
    Boolean(catalog?.resources.diagnostics.settingsErrors);
  const hidden = catalog?.setup.ui.webHiddenThinkingLevels ?? [];
  const levels = (catalog?.thinking?.available ?? []).filter(
    (level): level is ReasoningLevel =>
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        level,
      ),
  );
  const verbosity = catalog?.setup.response?.verbosity ?? "default";
  const summary = catalog?.setup.response?.reasoningSummary ?? "default";
  return (
    <section className="settings-configuration-panel">
      <header className="settings-page-heading">
        <div>
          <h1>{t("configurationSettings")}</h1>
          <p>{t("configurationIntro")}</p>
        </div>
        <button
          type="button"
          aria-label={t("refreshStatus")}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>
      {error && (
        <p className="inspection-warning" role="alert">
          {error}
        </p>
      )}
      {!catalog && !error && <p role="status">{t("settingsCatalogLoading")}</p>}
      {unreadable && (
        <p className="inspection-warning" role="alert">
          {t("configurationReadFailure")}
          {catalog?.setupDiagnostics?.map((diagnostic) => (
            <span key={`${diagnostic.path}:${diagnostic.message}`}>
              {diagnostic.path}: {diagnostic.message}
            </span>
          ))}
        </p>
      )}
      {catalog && !unreadable && (
        <>
          <div className="configuration-scope">
            <span className="configuration-scope-label">
              <UserRound aria-hidden="true" />
              {t("configurationUserScope")}
            </span>
            <span>{t("configurationSetupHint")}</span>
          </div>
          <div className="configuration-group">
            <div className="configuration-row">
              <div className="configuration-copy">
                <strong>{t("configurationApproval")}</strong>
                <p>{t("configurationApprovalDetail")}</p>
              </div>
              <span className="configuration-readonly">
                {t("configurationPiPermissions")}
              </span>
            </div>
            <div className="configuration-row">
              <div className="configuration-copy">
                <strong>{t("configurationSandbox")}</strong>
                <p>{t("configurationSandboxDetail")}</p>
              </div>
              <span className="configuration-readonly">
                {t("configurationSandboxUnavailable")}
              </span>
            </div>
            <div className="configuration-row">
              <div className="configuration-copy">
                <strong>{t("webSearchSettings")}</strong>
                <p>{t("configurationSearchDetail")}</p>
                {catalog.webSearch?.available !== true && (
                  <p>{t("webSearchUnsupported")}</p>
                )}
              </div>
              <div className="configuration-control">
                <Selector
                  label={t("webSearchSettings")}
                  isLabelHidden
                  size="sm"
                  width={144}
                  value={
                    catalog.setup.webSearch?.enabled === true ? "on" : "off"
                  }
                  options={[
                    { value: "off", label: t("disabled") },
                    { value: "on", label: t("enabled") },
                  ]}
                  isDisabled={blocked}
                  onChange={(value: string) => {
                    if (
                      (value === "on") ===
                      (catalog.setup.webSearch?.enabled === true)
                    )
                      return;
                    void onConfigure(
                      t(
                        value === "on"
                          ? "webSearchNativeRequest"
                          : "webSearchDisableRequest",
                      ),
                    );
                  }}
                />
              </div>
            </div>
            <div className="configuration-row">
              <div className="configuration-copy">
                <strong>{t("configurationVerbosity")}</strong>
                <p>{t("configurationVerbosityDetail")}</p>
                {catalog.responseSupport?.verbosity !== true && (
                  <p>{t("configurationResponsesUnavailable")}</p>
                )}
              </div>
              <div className="configuration-control">
                <Selector
                  label={t("configurationVerbosity")}
                  isLabelHidden
                  size="sm"
                  width={144}
                  value={verbosity}
                  options={["default", "low", "medium", "high"].map(
                    (value) => ({
                      value,
                      label: t(`configurationVerbosity_${value}`),
                    }),
                  )}
                  isDisabled={
                    blocked || catalog.responseSupport?.verbosity !== true
                  }
                  onChange={(value: string) => {
                    if (value !== verbosity)
                      void onConfigure(
                        t("configurationVerbosityRequest", { value }),
                      );
                  }}
                />
              </div>
            </div>
            <div className="configuration-row">
              <div className="configuration-copy">
                <strong>{t("configurationSummary")}</strong>
                <p>{t("configurationSummaryDetail")}</p>
                {catalog.responseSupport?.reasoningSummary !== true && (
                  <p>{t("configurationSummaryUnavailable")}</p>
                )}
              </div>
              <div className="configuration-control">
                <Selector
                  label={t("configurationSummary")}
                  isLabelHidden
                  size="sm"
                  width={144}
                  value={summary}
                  options={[
                    "default",
                    "auto",
                    "concise",
                    "detailed",
                    "none",
                  ].map((value) => ({
                    value,
                    label: t(`configurationSummary_${value}`),
                  }))}
                  isDisabled={
                    blocked ||
                    catalog.responseSupport?.reasoningSummary !== true
                  }
                  onChange={(value: string) => {
                    if (value !== summary)
                      void onConfigure(
                        t("configurationSummaryRequest", { value }),
                      );
                  }}
                />
              </div>
            </div>
          </div>
          <section className="configuration-section">
            <h2>{t("configurationModelFeatures")}</h2>
            <div className="configuration-group">
              <div className="configuration-row">
                <div className="configuration-copy">
                  <strong>{t("configurationReasoningLevels")}</strong>
                  <p>{t("configurationReasoningDetail")}</p>
                </div>
                <div className="configuration-control">
                  <ComplexSelector
                    label={t("configurationReasoningLevels")}
                    isLabelHidden
                    size="sm"
                    width={144}
                    value={hidden}
                    triggerLabel={t("configurationReasoningCount", {
                      count: levels.filter((level) => !hidden.includes(level))
                        .length,
                    })}
                    isDisabled={blocked || levels.length === 0}
                    placement="below"
                    alignment="end"
                    onChange={(
                      hiddenThinkingLevels: readonly ReasoningLevel[],
                    ) => {
                      void onUpdatePreferences({ hiddenThinkingLevels });
                    }}
                  >
                    {(
                      value: readonly ReasoningLevel[],
                      onChange: (next: readonly ReasoningLevel[]) => void,
                    ) => (
                      <fieldset
                        className="configuration-levels"
                        disabled={preferencePending}
                      >
                        <legend className="sr-only">
                          {t("configurationReasoningLevels")}
                        </legend>
                        {levels.map((level) => (
                          <label key={level}>
                            <input
                              type="checkbox"
                              checked={!value.includes(level)}
                              onChange={(event) =>
                                onChange(
                                  event.target.checked
                                    ? value.filter((item) => item !== level)
                                    : [...value, level],
                                )
                              }
                            />
                            <span>{level}</span>
                          </label>
                        ))}
                      </fieldset>
                    )}
                  </ComplexSelector>
                </div>
              </div>
            </div>
          </section>
          <section className="configuration-section">
            <h2>{t("configurationDependencies")}</h2>
            <div className="configuration-group">
              <div className="configuration-row">
                <div className="configuration-copy">
                  <strong>{t("configurationEnvironment")}</strong>
                  <p>{t("configurationEnvironmentDetail")}</p>
                </div>
                <button
                  type="button"
                  className="configuration-runtime-button"
                  onClick={onOpenRuntimeStatus}
                >
                  {t("configurationRuntimeStatus")}
                  <ArrowUpRight aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>
        </>
      )}
    </section>
  );
}
