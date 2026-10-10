import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { ArrowUpRight, Check, Copy, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  providerLoginActive,
  type WebProviderLogin,
} from "../../../../protocol/provider-login.ts";
import type { WebProviderAuthSummary } from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";

export function ProviderAccountLogin({
  sessionId,
  auth,
  busy,
  onSaving,
  onAuthenticated,
  onReload,
}: {
  sessionId: string;
  auth: WebProviderAuthSummary;
  busy: boolean;
  onSaving: (saving: boolean) => void;
  onAuthenticated: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [flow, setFlow] = useState<WebProviderLogin | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [pollError, setPollError] = useState(false);
  const [revision, refresh] = useState(0);
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [logout, setLogout] = useState(false);
  const [logoutRefreshRequired, setLogoutRefreshRequired] = useState(false);
  const mounted = useRef(false);
  const live = useRef<WebProviderLogin | null>(null);
  const lock = useRef(false);
  const completed = useRef<string | null>(null);
  const callbacks = useRef({ onSaving, onAuthenticated });
  callbacks.current = { onSaving, onAuthenticated };
  const active = providerLoginActive(flow);
  const provider = auth.id;
  const ownerKey = `${sessionId}:${provider}`;
  const owner = useRef({ key: ownerKey });
  if (owner.current.key !== ownerKey) owner.current = { key: ownerKey };
  const scope = owner.current;

  const accept = useCallback(
    (next: WebProviderLogin | null, id?: string) => {
      if (
        next &&
        (next.sessionId !== sessionId ||
          next.provider !== provider ||
          (id && next.id !== id))
      )
        throw new Error("Login ownership changed");
      if (id && !next) throw new Error("Login status unavailable");
      if (!mounted.current || owner.current !== scope) {
        if (next && providerLoginActive(next))
          void new WebClient()
            .cancelProviderLogin(sessionId, next.id)
            .catch(() => undefined);
        return;
      }
      live.current = next;
      setFlow(next);
      setPollError(false);
      if (
        next?.status === "succeeded" &&
        !next.refreshRequired &&
        completed.current !== next.id
      ) {
        completed.current = next.id;
        callbacks.current.onAuthenticated();
      }
    },
    [sessionId, provider, scope],
  );

  useEffect(() => {
    mounted.current = true;
    live.current = null;
    lock.current = false;
    completed.current = null;
    setFlow(null);
    setPending(false);
    setError(false);
    setPollError(false);
    setCopied(false);
    setLogoutRefreshRequired(false);
    const controller = new AbortController();
    void new WebClient()
      .providerLogin(sessionId, undefined, controller.signal)
      .then((next) => {
        if (
          !controller.signal.aborted &&
          next?.provider === provider &&
          providerLoginActive(next)
        )
          accept(next);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      controller.abort();
      const current = live.current;
      if (current && providerLoginActive(current))
        void new WebClient()
          .cancelProviderLogin(sessionId, current.id)
          .catch(() => undefined);
      callbacks.current.onSaving(false);
    };
  }, [sessionId, provider, accept]);

  useEffect(() => {
    callbacks.current.onSaving(active || pending);
  }, [active, pending]);
  const promptId = flow?.prompt?.id;
  useEffect(() => {
    void promptId;
    setValue("");
  }, [promptId]);
  const flowId = flow?.id;
  useEffect(() => {
    void flowId;
    setCopied(false);
  }, [flowId]);
  useEffect(() => {
    void revision;
    if (!active || !flowId) return;
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const next = await new WebClient().providerLogin(
          sessionId,
          flowId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        accept(next, flowId);
        if (providerLoginActive(next))
          timer = window.setTimeout(() => void poll(), 900);
      } catch {
        if (!controller.signal.aborted) setPollError(true);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [sessionId, accept, flowId, active, revision]);

  const run = async (operation: () => Promise<WebProviderLogin>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(false);
    try {
      accept(await operation());
    } catch {
      if (mounted.current && owner.current === scope) setError(true);
    } finally {
      if (owner.current === scope) {
        lock.current = false;
        if (mounted.current) setPending(false);
      }
    }
  };
  const start = () => {
    if (busy || active) return;
    void run(() => new WebClient().startProviderLogin(sessionId, provider));
  };
  const respond = (answer: string) => {
    const prompt = flow?.prompt;
    if (!flow || !prompt) return;
    const id = flow.id;
    void run(() =>
      new WebClient().respondProviderLogin(sessionId, id, prompt.id, answer),
    );
  };
  const recover = async () => {
    try {
      const next = await new WebClient().providerLogin(sessionId, flow?.id);
      accept(next, flow?.id);
      if (mounted.current && owner.current === scope) {
        setError(false);
        refresh((count) => count + 1);
      }
    } catch {
      if (mounted.current && owner.current === scope) setError(true);
    }
  };
  const prompt = flow?.prompt;
  const waiting = flow?.auth || flow?.device;
  const input = prompt && prompt.type !== "select" && (
    <div className="models-login-input">
      <label className="models-field">
        {prompt.type === "manual_code"
          ? t("accountLoginPaste")
          : prompt.message}
        <input
          type={
            prompt.type === "secret" || prompt.type === "manual_code"
              ? "password"
              : "text"
          }
          autoComplete="off"
          spellCheck={false}
          value={value}
          maxLength={8192}
          placeholder={prompt.placeholder}
          disabled={pending || flow.status !== "running"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (prompt.type === "text" || value.trim()) respond(value);
          }}
        />
      </label>
      <button
        type="button"
        className="models-button primary"
        disabled={
          pending ||
          (prompt.type !== "text" && !value.trim()) ||
          flow.status !== "running"
        }
        onClick={() => respond(value)}
      >
        {t("accountLoginContinue")}
      </button>
    </div>
  );

  return (
    <div className="models-account-login">
      {!active &&
        !logoutRefreshRequired &&
        (!flow || ["failed", "expired", "cancelled"].includes(flow.status)) && (
          <>
            <div className="models-login-intro">
              <div>
                <strong>
                  {provider === "openai"
                    ? t("accountLoginChatGPT")
                    : provider === "anthropic"
                      ? t("accountLoginClaude")
                      : auth.loginLabel || auth.name}
                </strong>
                <p className="models-hint">
                  {t(
                    auth.subscription
                      ? "accountLoginExisting"
                      : "accountLoginIntro",
                  )}
                </p>
              </div>
            </div>
            <div className="models-login-actions">
              <button
                type="button"
                className="models-button primary"
                disabled={busy || pending || error}
                onClick={start}
              >
                {t(
                  auth.subscription ? "accountLoginAgain" : "accountLoginStart",
                )}
              </button>
              {auth.subscription && (
                <button
                  type="button"
                  className="models-link"
                  disabled={busy || pending}
                  onClick={() => setLogout(true)}
                >
                  {t("accountLogout")}
                </button>
              )}
            </div>
          </>
        )}
      {active && (
        <div className="models-login-flow">
          <div className="models-login-status" role="status">
            <LoaderCircle aria-hidden="true" />
            <span>
              {t(
                flow?.status === "cancelling"
                  ? "accountLoginCancelling"
                  : waiting
                    ? "accountLoginWaiting"
                    : prompt
                      ? "accountLoginChoose"
                      : "accountLoginStarting",
              )}
            </span>
          </div>
          {waiting && (
            <p className="models-hint">
              {t(
                flow?.device
                  ? "accountLoginDeviceHelp"
                  : "accountLoginBrowserHelp",
              )}
            </p>
          )}
          {flow?.device && (
            <div className="models-device-code">
              <code>{flow.device.code}</code>
              <button
                type="button"
                className="models-icon"
                aria-label={t("accountLoginCopyCode")}
                onClick={() => {
                  if (!flow.device) return;
                  void navigator.clipboard
                    .writeText(flow.device.code)
                    .then(() => {
                      if (mounted.current && owner.current === scope)
                        setCopied(true);
                    })
                    .catch(() => {
                      if (mounted.current && owner.current === scope)
                        setCopied(false);
                    });
                }}
              >
                {copied ? <Check /> : <Copy />}
              </button>
            </div>
          )}
          {waiting && (
            <a
              className="models-button primary models-login-open"
              href={flow?.device?.url || flow?.auth?.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("accountLoginOpen")}
              <ArrowUpRight aria-hidden="true" />
            </a>
          )}
          {prompt?.type === "select" && (
            <fieldset
              className="models-login-options"
              aria-label={prompt.message}
            >
              {prompt.options?.map((option) => {
                const codex =
                  ["openai", "openai-codex"].includes(provider) &&
                  ["browser", "device_code"].includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="models-login-option"
                    disabled={pending || flow?.status !== "running"}
                    onClick={() => respond(option.id)}
                  >
                    <strong>
                      {codex
                        ? t(
                            option.id === "browser"
                              ? "accountLoginBrowser"
                              : "accountLoginDevice",
                          )
                        : option.label}
                    </strong>
                    {(codex || option.description) && (
                      <span>
                        {codex
                          ? t(
                              option.id === "browser"
                                ? "accountLoginBrowserOption"
                                : "accountLoginDeviceOption",
                            )
                          : option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </fieldset>
          )}
          {prompt?.type === "manual_code" && waiting ? (
            <details className="models-login-fallback">
              <summary>{t("accountLoginFallback")}</summary>
              <p className="models-hint">{t("accountLoginRemoteHelp")}</p>
              {input}
            </details>
          ) : (
            input
          )}
          {flow?.messages.map((message) => (
            <div className="models-hint" key={message.id}>
              <p>{message.message}</p>
              {message.links?.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.label}
                  <ArrowUpRight aria-hidden="true" />
                </a>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="models-link models-login-cancel"
            disabled={pending || flow?.status === "cancelling"}
            onClick={() => {
              if (flow)
                void run(() =>
                  new WebClient().cancelProviderLogin(sessionId, flow.id),
                );
            }}
          >
            {t("accountLoginCancel")}
          </button>
        </div>
      )}
      {flow?.status === "succeeded" && flow.refreshRequired && (
        <p className="models-hint" role="status">
          {t("accountLoginRefreshRequired")}{" "}
          <button type="button" className="models-link" onClick={onReload}>
            {t("refreshStatus")}
          </button>
        </p>
      )}
      {logoutRefreshRequired && (
        <p className="models-hint" role="status">
          {t("accountLogoutRefreshRequired")}{" "}
          <button type="button" className="models-link" onClick={onReload}>
            {t("refreshStatus")}
          </button>
        </p>
      )}
      {flow && ["failed", "expired", "cancelled"].includes(flow.status) && (
        <p
          className={flow.status === "failed" ? "models-error" : "models-hint"}
          role="status"
        >
          {t(`accountLogin_${flow.status}`)}
        </p>
      )}
      {error && (
        <p className="models-error" role="alert">
          {t("accountLoginRequestFailed")}
          <button
            type="button"
            className="models-link"
            onClick={() => void recover()}
          >
            {t("refreshStatus")}
          </button>
        </p>
      )}
      {pollError && (
        <p className="models-error" role="alert">
          {t("accountLoginStatusUnknown")}
          <button
            type="button"
            className="models-link"
            onClick={() => refresh((count) => count + 1)}
          >
            {t("refreshStatus")}
          </button>
        </p>
      )}
      {logout && (
        <AlertDialog
          isOpen
          title={t("accountLogoutTitle", { provider: auth.name })}
          description={t("accountLogoutDetail")}
          cancelLabel={t("cancel")}
          actionLabel={t("accountLogout")}
          isActionLoading={pending}
          onOpenChange={(open: boolean) => {
            if (!open && !pending) setLogout(false);
          }}
          onAction={() => {
            if (lock.current || busy) return;
            lock.current = true;
            setPending(true);
            setError(false);
            void new WebClient()
              .logoutProvider(sessionId, provider)
              .then((result) => {
                if (!mounted.current || owner.current !== scope) return;
                setLogout(false);
                if (result.refreshRequired) setLogoutRefreshRequired(true);
                else onReload();
              })
              .catch(() => {
                if (mounted.current && owner.current === scope) {
                  setLogout(false);
                  setError(true);
                }
              })
              .finally(() => {
                if (owner.current === scope) {
                  lock.current = false;
                  if (mounted.current) setPending(false);
                }
              });
          }}
        />
      )}
    </div>
  );
}
