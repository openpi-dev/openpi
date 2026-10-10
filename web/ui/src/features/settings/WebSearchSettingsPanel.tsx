import { Button } from "@astryxdesign/core/Button";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isWebAccessSource,
  WEB_ACCESS_PACKAGE,
} from "../../../../../extensions/shared/web-access.ts";
import type { WebSettingsCatalog } from "../../../../protocol/types.ts";

export function WebSearchSettingsPanel({
  catalog,
  error,
  pending,
  onConfigure,
  onRefresh,
  onReload,
}: {
  catalog: WebSettingsCatalog | null;
  error: string | null;
  pending: boolean;
  onConfigure: (request: string) => Promise<boolean>;
  onRefresh: () => void;
  onReload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<"exa" | "existing">("exa");
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const packages =
    catalog?.resources.plugins.filter(
      (plugin) =>
        plugin.scope === "user" &&
        (plugin.name === WEB_ACCESS_PACKAGE.name ||
          isWebAccessSource(plugin.source)),
    ) ?? [];
  const plugin = packages[0];
  const configured = plugin?.configured === true && plugin.enabled !== false;
  const loaded = packages.some((item) => item.extensions.length > 0);
  const blocked =
    pending ||
    reloading ||
    !catalog ||
    Boolean(error) ||
    Boolean(catalog.resources.diagnostics.settingsErrors);
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
              <Search aria-hidden="true" /> Pi Web Access
            </h2>
            <p>{t("webSearchPackageDetail")}</p>
          </div>
          <span className="settings-status-badge">
            {t(configured ? "enabled" : "disabled")}
          </span>
        </div>
        <dl className="settings-detail-metadata">
          <div>
            <dt>{t("source")}</dt>
            <dd>{plugin?.source ?? WEB_ACCESS_PACKAGE.source}</dd>
          </div>
          <div>
            <dt>{t("resourceSessionState")}</dt>
            <dd>{t(loaded ? "webSearchLoaded" : "webSearchNotLoaded")}</dd>
          </div>
        </dl>
        <p className="settings-resource-caption">{t("webSearchDefaultOff")}</p>
        <a
          className="settings-resource-link"
          href={WEB_ACCESS_PACKAGE.repository}
          target="_blank"
          rel="noreferrer"
        >
          {t("webSearchSource")} <ExternalLink size={14} aria-hidden="true" />
        </a>
      </section>
      <section className="settings-section-block settings-chat-controls">
        {!configured && (
          <label className="settings-form-field">
            {t("webSearchProfile")}
            <select
              value={profile}
              disabled={blocked}
              onChange={(event) =>
                setProfile(
                  event.target.value === "existing" ? "existing" : "exa",
                )
              }
            >
              <option value="exa">{t("webSearchExa")}</option>
              <option value="existing">{t("webSearchExisting")}</option>
            </select>
          </label>
        )}
        <p className="settings-resource-caption">{t("webSearchProfileHint")}</p>
        <div className="settings-resource-actions">
          <Button
            label={t(configured ? "webSearchDisable" : "webSearchEnable")}
            variant="secondary"
            size="sm"
            isDisabled={blocked}
            isLoading={pending}
            onClick={() =>
              void onConfigure(
                t(
                  configured
                    ? "webSearchDisableRequest"
                    : profile === "exa"
                      ? "webSearchExaRequest"
                      : "webSearchExistingRequest",
                ),
              )
            }
          />
          {configured && (
            <Button
              label={t("webSearchConfigure")}
              variant="secondary"
              size="sm"
              isDisabled={blocked}
              onClick={() => void onConfigure(t("webSearchProviderRequest"))}
            />
          )}
        </div>
      </section>
      <section className="settings-resource-management">
        <div className="settings-resource-reload">
          <div>
            <strong>{t("resourceSessionState")}</strong>
            <p>{t("resourcesReloadNote")}</p>
          </div>
          <Button
            label={t("reloadResources")}
            variant="secondary"
            size="sm"
            isDisabled={blocked || !catalog?.sessionPath}
            isLoading={reloading}
            onClick={() => {
              setReloading(true);
              setReloadError(null);
              void onReload()
                .catch((reason: unknown) =>
                  setReloadError(
                    reason instanceof Error
                      ? reason.message
                      : t("resourceReloadFailed"),
                  ),
                )
                .finally(() => setReloading(false));
            }}
          />
        </div>
      </section>
      {reloadError && <p role="alert">{reloadError}</p>}
    </section>
  );
}
