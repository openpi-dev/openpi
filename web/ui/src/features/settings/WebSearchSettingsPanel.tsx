import { Button } from "@astryxdesign/core/Button";
import { RefreshCw, Search } from "lucide-react";
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
    <section className="settings-general-panel settings-web-search-panel">
      <header className="settings-page-heading">
        <div>
          <h1>{t("webSearchSettings")}</h1>
          <p>{t("webSearchIntro")}</p>
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
      <section className="settings-section-block">
        <div className="settings-detail-heading">
          <div>
            <h2>
              <Search aria-hidden="true" />
              {t("webSearchCurrentModel")}
            </h2>
            <p>{t("webSearchNativeDetail")}</p>
          </div>
          <span className="settings-status-badge">
            {t(enabled ? "enabled" : "disabled")}
          </span>
        </div>
        <dl className="settings-detail-metadata">
          <div>
            <dt>{t("source")}</dt>
            <dd>{t("webSearchCurrentModel")}</dd>
          </div>
          <div>
            <dt>{t("model")}</dt>
            <dd>
              {catalog?.webSearch?.model
                ? `${catalog.webSearch.provider} / ${catalog.webSearch.model}`
                : t("unavailable")}
            </dd>
          </div>
        </dl>
        <p className="settings-resource-caption">{t("webSearchDefaultOff")}</p>
        <p role="status" className="settings-resource-caption">
          {t(available ? "webSearchSupported" : "webSearchUnsupported")}
        </p>
      </section>
      <section className="settings-section-block settings-chat-controls">
        <Button
          label={t(enabled ? "webSearchDisable" : "webSearchEnable")}
          variant="secondary"
          size="sm"
          isDisabled={blocked}
          isLoading={pending}
          onClick={() =>
            void onConfigure(
              t(enabled ? "webSearchDisableRequest" : "webSearchNativeRequest"),
            )
          }
        />
      </section>
    </section>
  );
}
