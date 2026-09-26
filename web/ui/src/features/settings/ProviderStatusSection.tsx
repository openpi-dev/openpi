import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { CheckCircle2, CircleDashed, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebProviderAuthProjection } from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";

export function ProviderStatusSection({
  sessionId,
  providerId,
  active,
  busy = false,
  onSaved,
  onDraftChange,
  onSavingChange,
  refreshRevision = 0,
  focusOnOpen = false,
}: {
  sessionId: string;
  providerId: string;
  active: boolean;
  busy?: boolean;
  onSaved?: () => Promise<boolean>;
  onDraftChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  refreshRevision?: number;
  focusOnOpen?: boolean;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<WebProviderAuthProjection | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const loadedRequest = useRef<string | null>(null);
  const loadedSession = useRef(sessionId);
  const [selectedProvider, setSelectedProvider] = useState(providerId);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{
    sessionId: string;
    providerId: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<{
    sessionId: string;
    providerId: string;
  } | null>(null);
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  const saveOperation = useRef<AbortController | null>(null);
  const currentScope = useRef({ sessionId, selectedProvider, providerId });
  currentScope.current = { sessionId, selectedProvider, providerId };
  const callbacks = useRef({ onDraftChange, onSavingChange });
  callbacks.current = { onDraftChange, onSavingChange };
  const providerSelect = useRef<HTMLSelectElement>(null);
  const credentialInput = useRef<HTMLInputElement>(null);
  const focusRequest = useRef<{ previous: Element | null } | null>(null);
  const requestedFocusSession = useRef<string | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);

  useEffect(() => {
    callbacks.current.onDraftChange?.(apiKey.length > 0);
  }, [apiKey]);
  useEffect(() => {
    callbacks.current.onSavingChange?.(saving);
  }, [saving]);
  useEffect(
    () => () => {
      saveOperation.current?.abort();
      callbacks.current.onDraftChange?.(false);
      callbacks.current.onSavingChange?.(false);
    },
    [],
  );
  useEffect(() => {
    // Credentials never transfer between Sessions or providers.
    void sessionId;
    setSelectedProvider(providerId);
    setApiKey("");
    setSaved(null);
    setSaving(false);
    setSaveError(null);
    setPendingProvider(null);
    return () => saveOperation.current?.abort();
  }, [providerId, sessionId]);

  useEffect(() => {
    if (!active) return;
    const requestKey = JSON.stringify([sessionId, revision, refreshRevision]);
    if (loadedRequest.current === requestKey) return;
    const controller = new AbortController();
    if (loadedSession.current !== sessionId) {
      loadedSession.current = sessionId;
      setData(null);
    }
    setLoading(true);
    setLoadError(false);
    void client.providerAuth(sessionId, controller.signal).then(
      (projection) => {
        if (controller.signal.aborted) return;
        loadedRequest.current = requestKey;
        setData(projection);
        setLoading(false);
      },
      () => {
        if (controller.signal.aborted) return;
        setLoadError(true);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [active, client, revision, refreshRevision, sessionId]);

  useEffect(() => {
    if (
      !active ||
      !focusOnOpen ||
      requestedFocusSession.current === sessionId
    ) {
      focusRequest.current = null;
      return;
    }
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    const frame = window.requestAnimationFrame(() => {
      requestedFocusSession.current = sessionId;
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
      if (cancelled) return;
      // The enclosing dialog gets its initial focus before this request.
      focusRequest.current = { previous: document.activeElement };
      setFocusRevision((value) => value + 1);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
      focusRequest.current = null;
    };
  }, [active, focusOnOpen, sessionId]);
  useEffect(() => {
    void focusRevision;
    const request = focusRequest.current;
    if (!active || !data || !request) return;
    focusRequest.current = null;
    // Loading must not pull focus back after the user moves elsewhere.
    if (document.activeElement !== request.previous) return;
    const target =
      credentialInput.current && !credentialInput.current.disabled
        ? credentialInput.current
        : providerSelect.current;
    target?.focus();
  }, [active, data, focusRevision]);

  const selectProvider = (id: string) => {
    setSelectedProvider(id);
    setApiKey("");
    setSaved(null);
    setSaveError(null);
    setPendingProvider(null);
  };

  const provider = data?.providers.find((item) => item.id === selectedProvider);
  const authMethods = Array.isArray(provider?.authMethods)
    ? provider.authMethods
    : [];
  const authentication = authMethods.length
    ? authMethods.map((method) => t(`providerAuth_${method}`)).join(" · ")
    : t("providerAuthUnknown");

  return (
    <section className="provider-status-section provider-status-detail">
      {data && (
        <label className="settings-form-field">
          {t("provider")}
          <select
            ref={providerSelect}
            aria-label={t("provider")}
            value={selectedProvider}
            disabled={saving}
            onChange={(event) => {
              const next = event.target.value;
              if (saving || next === selectedProvider) return;
              if (apiKey.length > 0) setPendingProvider(next);
              else selectProvider(next);
            }}
          >
            {!data.providers.some((item) => item.id === selectedProvider) && (
              <option value={selectedProvider}>
                {selectedProvider || t("selectProvider")}
              </option>
            )}
            {data.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="provider-detail-heading">
        <div>
          <span>{t("modelConnection")}</span>
          <strong>{provider?.name || selectedProvider}</strong>
        </div>
        <button
          type="button"
          className="provider-refresh"
          aria-label={t("refreshStatus")}
          disabled={loading}
          onClick={() => refresh((value) => value + 1)}
        >
          <RefreshCw aria-hidden="true" />
          <span>{t("refreshStatus")}</span>
        </button>
      </div>
      {loadError && (
        <div className="provider-settings-state error" role="alert">
          <strong>{t("providerLoadFailed")}</strong>
          <button type="button" onClick={() => refresh((value) => value + 1)}>
            {t("retryAdmissionCheck")}
          </button>
        </div>
      )}
      {!data && !loadError ? (
        <p className="provider-settings-state" role="status">
          {t("providerLoading")}
        </p>
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
      ) : data ? (
        <div className="provider-settings-state">
          <strong>{selectedProvider}</strong>
          <span>{t("providerStatusUnavailable")}</span>
        </div>
      ) : null}
      {authMethods.includes("api_key") && (
        <form
          className="settings-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (saving || busy || !apiKey.trim()) return;
            const operation = new AbortController();
            saveOperation.current = operation;
            const submitted = { sessionId, providerId: selectedProvider };
            const requestedProvider = providerId;
            const isCurrent = () =>
              !operation.signal.aborted &&
              saveOperation.current === operation &&
              currentScope.current.sessionId === submitted.sessionId &&
              currentScope.current.selectedProvider === submitted.providerId &&
              currentScope.current.providerId === requestedProvider;
            setSaving(true);
            setSaved(null);
            setSaveError(null);
            const key = apiKey.trim();
            setApiKey("");
            void client
              .saveProviderKey(
                sessionId,
                selectedProvider,
                key,
                operation.signal,
              )
              .then(
                async () => {
                  if (!isCurrent()) return;
                  setSaved(submitted);
                  refresh((value) => value + 1);
                  await onSaved?.().catch(() => false);
                },
                () => {
                  if (isCurrent()) setSaveError(submitted);
                },
              )
              .finally(() => {
                if (isCurrent()) setSaving(false);
              });
          }}
        >
          <label className="settings-form-field">
            {t("providerApiKey")}
            <input
              ref={credentialInput}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={saving || busy}
              placeholder={t("providerKeyPlaceholder")}
              onChange={(event) => {
                setApiKey(event.target.value);
                setSaved(null);
                setSaveError(null);
              }}
            />
          </label>
          <button type="submit" disabled={saving || busy || !apiKey.trim()}>
            {t(saving ? "savingSettings" : "saveProviderKey")}
          </button>
          {saveError?.sessionId === sessionId &&
            saveError.providerId === selectedProvider && (
              <p role="alert">{t("providerSaveFailed")}</p>
            )}
          {saved?.sessionId === sessionId &&
            saved.providerId === selectedProvider && (
              <p role="status">{t("providerKeySaved")}</p>
            )}
        </form>
      )}
      <aside className="provider-read-only">
        <KeyRound aria-hidden="true" />
        <div>
          <strong>{t("providerReadOnly")}</strong>
          <p>{t("providerWriteDetail")}</p>
          <small>{t("authNotVerified")}</small>
        </div>
      </aside>
      {pendingProvider !== null && (
        <AlertDialog
          isOpen
          onOpenChange={(open: boolean) => !open && setPendingProvider(null)}
          title={t("unsavedCredentialTitle")}
          description={t("unsavedCredentialDetail")}
          cancelLabel={t("keepEditing")}
          actionLabel={t("discardAndContinue")}
          onAction={() => selectProvider(pendingProvider)}
        />
      )}
    </section>
  );
}
