import { CheckCircle2, CircleDashed, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebProviderAuthProjection } from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";

export function ProviderStatusSection({
  sessionId,
  providerId,
  active,
}: {
  sessionId: string;
  providerId: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<WebProviderAuthProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRequest = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    const requestKey = `${sessionId}:${revision}`;
    if (loadedRequest.current === requestKey) return;
    const controller = new AbortController();
    setData(null);
    setError(null);
    void client.providerAuth(sessionId, controller.signal).then(
      (projection) => {
        if (controller.signal.aborted) return;
        loadedRequest.current = requestKey;
        setData(projection);
      },
      (reason) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error ? reason.message : t("providerLoadFailed"),
        );
      },
    );
    return () => controller.abort();
  }, [active, client, revision, sessionId, t]);

  const provider = data?.providers.find((item) => item.id === providerId);
  const authMethods = Array.isArray(provider?.authMethods)
    ? provider.authMethods
    : [];
  const authentication = authMethods.length
    ? authMethods.map((method) => t(`providerAuth_${method}`)).join(" · ")
    : t("providerAuthUnknown");

  return (
    <section className="provider-status-section provider-status-detail">
      <div className="provider-detail-heading">
        <div>
          <span>{t("modelConnection")}</span>
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
        <article
          className="provider-connection-card"
          data-configured={provider.configured ? "true" : "false"}
        >
          <div className="provider-connection-state">
            <span
              className={`provider-state-icon ${provider.configured ? "configured" : "missing"}`}
              aria-hidden="true"
            >
              {provider.configured ? <CheckCircle2 /> : <CircleDashed />}
            </span>
            <div className="provider-identity">
              <strong>{provider.name || provider.id}</strong>
              {provider.name !== provider.id && <span>{provider.id}</span>}
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
          <dl className="provider-connection-facts">
            <div>
              <dt>{t("authentication")}</dt>
              <dd>{authentication}</dd>
            </div>
            <div>
              <dt>{t("accessType")}</dt>
              <dd>
                {t(
                  provider.subscription
                    ? "providerAccessSubscription"
                    : "providerAccessStandard",
                )}
              </dd>
            </div>
            <div>
              <dt>{t("configurationOwner")}</dt>
              <dd>{t("providerReadOnly")}</dd>
            </div>
          </dl>
        </article>
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
          <small>{t("authNotVerified")}</small>
        </div>
      </aside>
    </section>
  );
}
