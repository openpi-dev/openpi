import {
  CheckCircle2,
  CircleDashed,
  KeyRound,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebProviderAuthProjection } from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";

type ProviderFilter = "all" | "configured" | "missing";

export function ProviderStatusSection({
  sessionId,
  hidden,
  providerId,
}: {
  sessionId: string;
  hidden: boolean;
  providerId?: string;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<WebProviderAuthProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProviderFilter>("all");

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void client
      .providerAuth(sessionId, controller.signal)
      .then(setData, (reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error ? reason.message : t("providerLoadFailed"),
          );
      });
    return () => controller.abort();
  }, [client, revision, sessionId, t]);

  const providers = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return [...(data?.providers ?? [])]
      .sort(
        (left, right) =>
          Number(right.configured) - Number(left.configured) ||
          (left.name || left.id).localeCompare(right.name || right.id),
      )
      .filter((provider) => {
        if (filter === "configured" && !provider.configured) return false;
        if (filter === "missing" && provider.configured) return false;
        if (!normalized) return true;
        return [
          provider.name,
          provider.id,
          ...(provider.authMethods ?? []),
        ].some((value) => value.toLocaleLowerCase().includes(normalized));
      });
  }, [data, filter, query]);
  const configured = data?.providers.filter(
    (provider) => provider.configured,
  ).length;

  if (providerId) {
    const provider = data?.providers.find((item) => item.id === providerId);
    return (
      <section
        className="provider-status-section provider-status-detail"
        hidden={hidden}
      >
        <div className="provider-detail-heading">
          <div>
            <span>{t("providerAvailability")}</span>
            <strong>{provider?.name || providerId}</strong>
          </div>
          <button
            type="button"
            className="provider-refresh"
            aria-label={t("refreshStatus")}
            disabled={!data}
            onClick={() => refresh((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" />
            <span>{t("refreshStatus")}</span>
          </button>
        </div>
        {!data && !error ? (
          <p className="provider-settings-state" role="status">
            {t("providerLoading")}
          </p>
        ) : error ? (
          <div className="provider-settings-state error" role="alert">
            <strong>{t("providerLoadFailed")}</strong>
            <span>{error}</span>
            <button type="button" onClick={() => refresh((value) => value + 1)}>
              {t("retryAdmissionCheck")}
            </button>
          </div>
        ) : provider ? (
          <div className="provider-detail-card">
            <span
              className={`provider-state-icon ${provider.configured ? "configured" : "missing"}`}
              aria-hidden="true"
            >
              {provider.configured ? <CheckCircle2 /> : <CircleDashed />}
            </span>
            <div className="provider-identity">
              <strong>{provider.name || provider.id}</strong>
              {provider.name !== provider.id && <span>{provider.id}</span>}
              <small>
                {(provider.authMethods ?? []).length
                  ? (provider.authMethods ?? [])
                      .map((method) => t(`providerAuth_${method}`))
                      .join(" · ")
                  : t("providerAuthUnknown")}
                {provider.subscription ? ` · ${t("providerSubscription")}` : ""}
              </small>
            </div>
            <span
              className={`provider-state-label ${provider.configured ? "configured" : "missing"}`}
            >
              {t(
                provider.configured
                  ? "credentialConfigured"
                  : "credentialMissing",
              )}
            </span>
          </div>
        ) : (
          <div className="provider-settings-state">
            <strong>{providerId}</strong>
            <span>{t("providerStatusUnavailable")}</span>
          </div>
        )}
        <aside className="provider-read-only">
          <KeyRound aria-hidden="true" />
          <div>
            <strong>{t("providerReadOnly")}</strong>
            <p>{t("providerReadOnlyDetail")}</p>
          </div>
        </aside>
      </section>
    );
  }

  return (
    <section className="provider-status-section" hidden={hidden}>
      <div className="provider-settings-toolbar">
        <label className="provider-search">
          <Search aria-hidden="true" />
          <span className="sr-only">{t("providerSearchLabel")}</span>
          <input
            value={query}
            placeholder={t("providerSearchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <fieldset aria-label={t("providerFilter")}>
          {(["all", "configured", "missing"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(`providerFilter_${value}`)}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className="provider-refresh"
          aria-label={t("refreshStatus")}
          disabled={!data}
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw aria-hidden="true" />
          <span>{t("refreshStatus")}</span>
        </button>
      </div>
      {data && (
        <p className="provider-settings-count" role="status">
          {t("providerConfiguredCount", {
            configured,
            total: data.providers.length,
          })}
        </p>
      )}
      {!data && !error ? (
        <p className="provider-settings-state" role="status">
          {t("providerLoading")}
        </p>
      ) : error ? (
        <div className="provider-settings-state error" role="alert">
          <strong>{t("providerLoadFailed")}</strong>
          <span>{error}</span>
          <button type="button" onClick={() => refresh((value) => value + 1)}>
            {t("retryAdmissionCheck")}
          </button>
        </div>
      ) : providers.length ? (
        <div className="provider-list">
          {providers.map((provider) => (
            <div className="provider-row" key={provider.id}>
              <span
                className={`provider-state-icon ${provider.configured ? "configured" : "missing"}`}
                aria-hidden="true"
              >
                {provider.configured ? <CheckCircle2 /> : <CircleDashed />}
              </span>
              <div className="provider-identity">
                <strong>{provider.name || provider.id}</strong>
                {provider.name !== provider.id && <span>{provider.id}</span>}
                <small>
                  {(provider.authMethods ?? []).length
                    ? (provider.authMethods ?? [])
                        .map((method) => t(`providerAuth_${method}`))
                        .join(" · ")
                    : t("providerAuthUnknown")}
                  {provider.subscription
                    ? ` · ${t("providerSubscription")}`
                    : ""}
                </small>
              </div>
              <span
                className={`provider-state-label ${provider.configured ? "configured" : "missing"}`}
              >
                {t(
                  provider.configured
                    ? "credentialConfigured"
                    : "credentialMissing",
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="provider-settings-state">
          <strong>{t("providerNoMatches")}</strong>
          <span>{t("providerNoMatchesHint")}</span>
        </div>
      )}
      {data?.truncation.truncated && (
        <p className="inspection-warning">{t("providersBounded")}</p>
      )}
      <aside className="provider-read-only">
        <KeyRound aria-hidden="true" />
        <div>
          <strong>{t("providerReadOnly")}</strong>
          <p>{t("providerReadOnlyDetail")}</p>
        </div>
      </aside>
    </section>
  );
}
