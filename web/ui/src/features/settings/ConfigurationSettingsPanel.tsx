import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
} from "@astryxdesign/core/DropdownMenu";
import { ArrowUpRight, Check, RefreshCw, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReasoningLevel } from "../../../../../extensions/shared/setup-config.ts";
import type {
  WebSettingsCatalog,
  WebSettingsPreferencesPatch,
} from "../../../../protocol/types.ts";

function ConfigurationMenu({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; description?: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu
      button={{
        label: options.find((option) => option.value === value)?.label ?? value,
        "aria-label": label,
        variant: "secondary",
        size: "sm",
        className: "configuration-menu-trigger",
        isDisabled: disabled,
      }}
      className="configuration-menu"
      menuWidth="min(360px, calc(100vw - 32px))"
      alignment="end"
      items={options.map((option) => ({
        id: option.value,
        label: option.label,
        isDisabled: disabled,
        description: option.description ? (
          <span className="configuration-option-description">
            {option.description}
          </span>
        ) : undefined,
        endContent:
          value === option.value ? <Check aria-hidden="true" /> : undefined,
        onClick: () => {
          if (option.value !== value) onChange(option.value);
        },
      }))}
    />
  );
}

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
                <ConfigurationMenu
                  label={t("webSearchSettings")}
                  value={
                    catalog.setup.webSearch?.enabled === true ? "on" : "off"
                  }
                  options={[
                    {
                      value: "off",
                      label: t("disabled"),
                      description: t("configurationSearchOff"),
                    },
                    {
                      value: "on",
                      label: t("enabled"),
                      description: t("configurationSearchOn"),
                    },
                  ]}
                  disabled={blocked}
                  onChange={(value: string) => {
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
                <ConfigurationMenu
                  label={t("configurationVerbosity")}
                  value={verbosity}
                  options={["default", "low", "medium", "high"].map(
                    (value) => ({
                      value,
                      label: t(`configurationVerbosity_${value}`),
                      description:
                        value === "default"
                          ? undefined
                          : t(`configurationVerbosityHelp_${value}`),
                    }),
                  )}
                  disabled={
                    blocked || catalog.responseSupport?.verbosity !== true
                  }
                  onChange={(value: string) => {
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
                <ConfigurationMenu
                  label={t("configurationSummary")}
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
                    description:
                      value === "default"
                        ? undefined
                        : t(`configurationSummaryHelp_${value}`),
                  }))}
                  disabled={
                    blocked ||
                    catalog.responseSupport?.reasoningSummary !== true
                  }
                  onChange={(value: string) => {
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
                  <DropdownMenu
                    button={{
                      label: t("configurationReasoningCount", {
                        count: levels.filter((level) => !hidden.includes(level))
                          .length,
                      }),
                      "aria-label": t("configurationReasoningLevels"),
                      variant: "secondary",
                      size: "sm",
                      className: "configuration-menu-trigger",
                      isDisabled: blocked || levels.length === 0,
                    }}
                    className="configuration-level-menu"
                    menuWidth="min(240px, calc(100vw - 32px))"
                    alignment="end"
                  >
                    {levels.map((level) => (
                      <DropdownMenuCheckboxItem
                        key={level}
                        label={level}
                        value={!hidden.includes(level)}
                        isDisabled={blocked}
                        endContent={
                          <span className="configuration-check">
                            {!hidden.includes(level) && (
                              <Check aria-hidden="true" />
                            )}
                          </span>
                        }
                        onChange={(checked: boolean) => {
                          void onUpdatePreferences({
                            thinkingLevelVisibility: {
                              level,
                              visible: checked,
                            },
                          });
                        }}
                      />
                    ))}
                  </DropdownMenu>
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
