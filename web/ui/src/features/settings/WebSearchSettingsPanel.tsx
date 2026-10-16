import { Button } from "@astryxdesign/core/Button";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WebSettingsCatalog } from "../../../../protocol/types.ts";

export function WebSearchSettingsPanel({
  catalog,
  error,
  pending,
  onConfigure,
  onRefresh,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  pending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const enabled = catalog?.setup.webSearch?.enabled === true;
  const available = catalog?.webSearch?.available === true;
  const blocked =
    pending ||
    !catalog ||
    Boolean(error) ||
    Boolean(catalog?.resources.diagnostics.settingsErrors);
  return (
    <section className="settings-content-page settings-web-search-panel">
      <header className="settings-page-heading">
        <div>
          <h1>{t("webSearchSettings")}</h1>
          <p>{t("webSearchIntro")}</p>
        </div>
        <button
          type="button"
          className="icon-button settings-heading-refresh"
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
      <section className="settings-control-group">
        <div className="settings-control-row">
          <div className="settings-control-copy">
            <h2>{t("webSearchCurrentModel")}</h2>
            <p>{t("webSearchNativeDetail")}</p>
          </div>
          <Button
            label={t(enabled ? "webSearchDisable" : "webSearchEnable")}
            variant="secondary"
            size="sm"
            isDisabled={blocked}
            isLoading={pending}
            onClick={() =>
              void onConfigure(
                t(
                  enabled
                    ? "webSearchDisableRequest"
                    : "webSearchNativeRequest",
                ),
              )
            }
          />
        </div>
        <div className="settings-control-row">
          <div className="settings-control-copy">
            <strong>{t("model")}</strong>
          </div>
          <span className="settings-control-value">
            {catalog?.webSearch?.model
              ? `${catalog.webSearch.provider} / ${catalog.webSearch.model}`
              : t("unavailable")}
          </span>
        </div>
      </section>
      <p className="settings-resource-caption">{t("webSearchDefaultOff")}</p>
      <p role="status" className="settings-resource-caption">
        {t(available ? "webSearchSupported" : "webSearchUnsupported")}
      </p>
    </section>
  );
}
