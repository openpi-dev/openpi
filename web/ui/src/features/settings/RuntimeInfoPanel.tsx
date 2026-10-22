import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WebBuildInfo,
  WebRuntimeInfo,
} from "../../../../protocol/runtime-info.ts";
import { WebClient } from "../../protocol/client.ts";

declare const __OPENPI_WEB_BUILD__: WebBuildInfo;

export function RuntimeInfoPanel() {
  const pageBuild =
    typeof __OPENPI_WEB_BUILD__ === "undefined" ? null : __OPENPI_WEB_BUILD__;
  const { t } = useTranslation();
  const [info, setInfo] = useState<WebRuntimeInfo | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [request, setRequest] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: request explicitly triggers a manual refresh.
  useEffect(() => {
    const controller = new AbortController();
    const client = new WebClient();
    setState("loading");
    setInfo(null);
    void client
      .request<{ openpi?: WebRuntimeInfo }>("/api/diagnostics", {
        signal: controller.signal,
      })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setInfo(result.openpi ?? null);
          setState("ready");
        },
        () => {
          if (!controller.signal.aborted) setState("error");
        },
      );
    return () => controller.abort();
  }, [request]);
  const unknown = t("notReported");
  const mismatch =
    pageBuild?.id &&
    info?.frontendAtStartup?.id &&
    pageBuild.id !== info.frontendAtStartup.id;
  return (
    <section
      className="settings-section-block"
      aria-label={t("runtimeIdentity")}
    >
      <h2>{t("runtimeIdentity")}</h2>
      <p>{t("runtimeIdentityHint")}</p>
      {state === "loading" && (
        <p role="status">{t("settingsCatalogLoading")}</p>
      )}
      {state === "error" && <p role="alert">{t("runtimeIdentityFailed")}</p>}
      <dl className="settings-summary-list runtime-identity-list">
        <div>
          <dt>{t("runtimeBackendVersion")}</dt>
          <dd>{info?.version ?? unknown}</dd>
        </div>
        <div>
          <dt>{t("runtimePackageRoot")}</dt>
          <dd>{info?.packageRoot ?? unknown}</dd>
        </div>
        <div>
          <dt>{t("runtimeStartedAt")}</dt>
          <dd>{info ? new Date(info.startedAt).toLocaleString() : unknown}</dd>
        </div>
        <div>
          <dt>{t("runtimeGitRevision")}</dt>
          <dd>{info?.git?.revision ?? unknown}</dd>
        </div>
        <div>
          <dt>{t("runtimeGitState")}</dt>
          <dd>
            {info?.git?.dirty == null
              ? unknown
              : t(info.git.dirty ? "runtimeGitDirty" : "runtimeGitClean")}
          </dd>
        </div>
        <div>
          <dt>{t("runtimeFrontendVersion")}</dt>
          <dd>{pageBuild?.version ?? unknown}</dd>
        </div>
        <div>
          <dt>{t("runtimeFrontendBuild")}</dt>
          <dd>
            {pageBuild?.mode === "development"
              ? t("runtimeDevelopmentBuild")
              : (pageBuild?.id ?? unknown)}
          </dd>
        </div>
        <div>
          <dt>{t("runtimeStartupBuild")}</dt>
          <dd>{info?.frontendAtStartup?.id ?? unknown}</dd>
        </div>
      </dl>
      {mismatch && <p role="status">{t("runtimeBuildMismatch")}</p>}
      <button
        type="button"
        onClick={() => setRequest((value) => value + 1)}
        disabled={state === "loading"}
      >
        {t("refreshStatus")}
      </button>
    </section>
  );
}
