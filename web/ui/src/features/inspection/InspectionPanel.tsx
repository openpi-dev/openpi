import { Dialog } from "@astryxdesign/core/Dialog";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebBackgroundTerminalDetail } from "../../../../../extensions/shared/web-observer-registry.ts";
import type { WebProjectTrustStatus } from "../../../../runtime/trust-status.ts";
import type { WebProviderAuthProjection } from "../../../../runtime/types.ts";
import { WebClient } from "../../protocol/client.ts";

export interface InspectionTarget {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  model: string;
  modelKey?: string;
  terminalId?: string;
}

interface InspectionData {
  thinking?: { level: string; available: readonly string[] };
  trust?: WebProjectTrustStatus;
  auth?: WebProviderAuthProjection;
  terminal?: WebBackgroundTerminalDetail;
  errors: string[];
}

export function InspectionPanel({
  target,
  onClose,
}: {
  target: InspectionTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<InspectionData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setUpdatedAt(null);
    const read = async () => {
      const next: InspectionData = { errors: [] };
      if (target.terminalId) {
        try {
          const response = await client.terminalDetail(
            target.sessionId,
            target.terminalId,
            controller.signal,
          );
          if (
            response.sessionId !== target.sessionId ||
            response.detail.id !== target.terminalId
          ) {
            throw new Error(t("inspectionChanged"));
          }
          next.terminal = response.detail;
        } catch (error) {
          next.errors.push(
            error instanceof Error ? error.message : t("inspectionUnavailable"),
          );
        }
      } else {
        const [thinking, trust, auth] = await Promise.allSettled([
          client.thinking(target.sessionId, controller.signal),
          client.trust(target.sessionId, controller.signal),
          client.providerAuth(target.sessionId, controller.signal),
        ]);
        if (
          thinking.status === "fulfilled" &&
          thinking.value.sessionId === target.sessionId
        )
          next.thinking = thinking.value;
        else next.errors.push(t("thinkingUnavailable"));
        if (
          trust.status === "fulfilled" &&
          (trust.value.workspace === undefined ||
            trust.value.workspace === target.cwd)
        )
          next.trust = trust.value;
        else next.errors.push(t("trustUnavailable"));
        if (auth.status === "fulfilled") next.auth = auth.value;
        else next.errors.push(t("authUnavailable"));
      }
      if (controller.signal.aborted) return;
      setData(next);
      setUpdatedAt(new Date().toLocaleTimeString());
    };
    void read();
    return () => controller.abort();
  }, [client, target, revision, t]);

  const title = target.terminalId ? t("terminalDetails") : t("runtimeStatus");
  const terminal = data?.terminal;
  return (
    <Dialog
      isOpen
      onOpenChange={(open: boolean) => !open && onClose()}
      width={640}
      aria-label={title}
    >
      <section className="inspection-panel">
        <header className="inspection-heading">
          <div>
            <h2>{title}</h2>
            <p className="inspection-subtitle">{target.cwd}</p>
          </div>
          <div className="inspection-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t("refreshStatus")}
              disabled={!data}
              onClick={() => refresh((value) => value + 1)}
            >
              <RefreshCw />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t("close")}
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </header>
        {!data ? (
          <p role="status">{t("inspectionLoading")}</p>
        ) : (
          <>
            {data.errors.map((error) => (
              <p className="inspection-warning" role="alert" key={error}>
                {error}
              </p>
            ))}
            {terminal ? (
              <>
                <div className="inspection-section">
                  <h3>{terminal.title || terminal.id}</h3>
                  <dl>
                    <dt>{t("executionState")}</dt>
                    <dd>
                      {t(`execution_${terminal.status}`, {
                        defaultValue: terminal.status,
                      })}
                    </dd>
                    <dt>{t("terminalCommand")}</dt>
                    <dd>
                      <code>{terminal.command}</code>
                    </dd>
                    <dt>{t("terminalDirectory")}</dt>
                    <dd>{terminal.cwd}</dd>
                    <dt>{t("startedAt")}</dt>
                    <dd>{new Date(terminal.createdAt).toLocaleString()}</dd>
                    {terminal.exitCode !== undefined && (
                      <>
                        <dt>{t("exitCode")}</dt>
                        <dd>{terminal.exitCode}</dd>
                      </>
                    )}
                  </dl>
                  {terminal.errorText && (
                    <p className="inspection-warning">{terminal.errorText}</p>
                  )}
                  {terminal.truncated && (
                    <p className="inspection-note">{t("detailTruncated")}</p>
                  )}
                </div>
                {(["stdout", "stderr"] as const).map((stream) => (
                  <section className="inspection-section" key={stream}>
                    <h3>
                      {stream === "stdout"
                        ? t("standardOutput")
                        : t("standardError")}
                    </h3>
                    <pre className="terminal-evidence">
                      {terminal[stream].text || t("noOutput")}
                    </pre>
                    {terminal[stream].truncated && (
                      <p className="inspection-note">
                        {t("outputTruncated", {
                          count: terminal[stream].omittedBytes,
                        })}
                      </p>
                    )}
                    {terminal[stream].recoveryAvailable && (
                      <p className="inspection-note">{t("outputRecovery")}</p>
                    )}
                  </section>
                ))}
              </>
            ) : (
              !target.terminalId && (
                <>
                  <section className="inspection-section">
                    <h3>{t("modelAndThinking")}</h3>
                    <dl>
                      <dt>{t("selectedModel")}</dt>
                      <dd>{target.model || t("noModels")}</dd>
                      <dt>{t("thinkingLevel")}</dt>
                      <dd>{data.thinking?.level ?? t("unknownState")}</dd>
                      {Boolean(data.thinking?.available.length) && (
                        <>
                          <dt>{t("availableThinking")}</dt>
                          <dd>{data.thinking?.available.join(" · ")}</dd>
                        </>
                      )}
                    </dl>
                  </section>
                  <section className="inspection-section">
                    <h3>{t("projectTrust")}</h3>
                    <p>{t(`trust_${data.trust?.state ?? "unknown"}`)}</p>
                    {data.trust?.refreshRequired === true && (
                      <p className="inspection-warning">
                        {t("trustRefreshNeeded")}
                      </p>
                    )}
                  </section>
                  <section className="inspection-section">
                    <h3>{t("providerAvailability")}</h3>
                    {data.auth?.providers.map((provider) => (
                      <div className="provider-status" key={provider.id}>
                        <span>{provider.name || provider.id}</span>
                        <span>
                          {provider.configured
                            ? t("credentialConfigured")
                            : t("credentialMissing")}
                        </span>
                      </div>
                    ))}
                    {data.auth && !data.auth.providers.length && (
                      <p>{t("noProviders")}</p>
                    )}
                    {data.auth?.truncation.truncated && (
                      <p className="inspection-note">{t("providersBounded")}</p>
                    )}
                    <p className="inspection-note">{t("authNotVerified")}</p>
                  </section>
                  <p className="inspection-note">{t("configurationViaPi")}</p>
                </>
              )
            )}
            <p className="inspection-updated">
              {t("statusCaptured", { time: updatedAt })}
            </p>
          </>
        )}
      </section>
    </Dialog>
  );
}
